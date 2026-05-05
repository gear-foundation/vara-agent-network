import {
  GearApi,
  HexString,
  IUpdateVoucherParams,
  VoucherIssuedData,
} from '@gear-js/api';
import { waitReady } from '@polkadot/wasm-crypto';
import { hexToU8a } from '@polkadot/util';
import { Keyring } from '@polkadot/api';
import { DataSource, Repository } from 'typeorm';
import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Voucher } from '../entities/voucher.entity';
import { withAdvisoryLock } from './advisory-lock';
import { getWalletLockKey } from './wallet-lock';

const SECONDS_PER_BLOCK = 3;
const PLANCK_PER_VARA = BigInt(1e12);
const MIN_RESERVE_VARA = 10n;
const SIGN_AND_SEND_TIMEOUT_MS = 180_000;
const SIGN_AND_SEND_TIMEOUT_SEC = SIGN_AND_SEND_TIMEOUT_MS / 1000;

function withTimeout<T>(promise: Promise<T>, message: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(message)), SIGN_AND_SEND_TIMEOUT_MS),
    ),
  ]);
}

function formatUnknownError(error: unknown): string {
  if (error instanceof Error) {
    return error.stack ? `${error.name}: ${error.message}\n${error.stack}` : `${error.name}: ${error.message}`;
  }
  if (typeof error === 'string') return error;

  try {
    return JSON.stringify(error, (_key, value) =>
      typeof value === 'bigint' ? value.toString() : value,
    );
  } catch {
    return String(error);
  }
}

function getExtrinsicFailedError(api: GearApi, event: unknown): Error {
  const decoded = api.getExtrinsicFailedError(event as never);
  if (decoded instanceof Error) return decoded;

  if (decoded && typeof decoded === 'object') {
    const { method, name, docs } = decoded as {
      method?: string;
      name?: string;
      docs?: string;
    };
    const label = [method, name].filter(Boolean).join('.');
    return new Error([label || 'ExtrinsicFailed', docs].filter(Boolean).join(': '));
  }

  return new Error(formatUnknownError(decoded));
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function toBlockBigInt(value: bigint | number | string): bigint {
  return typeof value === 'bigint' ? value : BigInt(value);
}

function isIrrevocableYetError(error: unknown): boolean {
  return formatUnknownError(error).toLowerCase().includes('irrevocableyet');
}

export type RevokeResult = 'revoked' | 'db_only' | 'still_valid';

@Injectable()
export class VoucherService implements OnModuleInit {
  private logger = new Logger('VoucherService');
  private api: GearApi;
  private nodeUrl: string;
  public account;

  constructor(
    @InjectRepository(Voucher) private readonly repo: Repository<Voucher>,
    private readonly configService: ConfigService,
    private readonly dataSource: DataSource,
  ) {
    this.nodeUrl = configService.get('nodeUrl');
    this.api = new GearApi({ providerAddress: this.nodeUrl });
  }

  /**
   * Ensures the GearApi WebSocket is connected. If the connection dropped
   * (node restart, network glitch), creates a fresh instance and awaits ready.
   * Call this before every chain operation.
   */
  private async ensureConnected(): Promise<GearApi> {
    if (this.api.isConnected) return this.api;

    return this.reconnectApi();
  }

  private async reconnectApi(): Promise<GearApi> {
    this.logger.warn('GearApi disconnected — reconnecting...');
    try {
      await this.api.disconnect();
    } catch {
      // old socket may already be dead
    }
    this.api = new GearApi({ providerAddress: this.nodeUrl });
    await this.api.isReadyOrError;
    this.logger.log('GearApi reconnected');
    return this.api;
  }

  private isOutdatedTransactionError(error: unknown): boolean {
    const message = error instanceof Error ? error.message : String(error);
    return (
      message.includes('Invalid Transaction: Transaction is outdated') ||
      (message.includes('1010') && message.toLowerCase().includes('outdated'))
    );
  }

  /**
   * Serializes all signed sends made by the shared voucher issuer account.
   * Per-wallet locks in GaslessService stop duplicate mints for one user,
   * but different users still sign with the same issuer account and can
   * race on signer nonce across pods without this global lock.
   */
  private async withIssuerLock<T>(operation: string, fn: () => Promise<T>): Promise<T> {
    if (!this.account?.address) {
      throw new Error('Voucher issuer account is not initialized');
    }

    return withAdvisoryLock(
      this.dataSource,
      getWalletLockKey(this.account.address),
      operation,
      async () => {
        try {
          return await fn();
        } finally {
          this.logger.debug(`Issuer lock released after ${operation}`);
        }
      },
    );
  }

  private async sendWithOutdatedRetry<T>(
    operation: string,
    fn: (api: GearApi) => Promise<T>,
  ): Promise<T> {
    return this.withIssuerLock(operation, async () => {
      const api = await this.ensureConnected();
      try {
        return await fn(api);
      } catch (error) {
        if (!this.isOutdatedTransactionError(error)) throw error;

        this.logger.warn(
          `${operation} hit "Transaction is outdated" for issuer ${this.account.address}; reconnecting and retrying once`,
        );
        const freshApi = await this.reconnectApi();
        return fn(freshApi);
      }
    });
  }

  getAccountBalance() {
    return this.api.balance.findOut(this.account.address);
  }

  async onModuleInit() {
    // Re-throw on failure — silent startup with a broken API is worse than a crash loop
    await Promise.all([this.api.isReadyOrError, waitReady()]);

    const keyring = new Keyring({ type: 'sr25519', ss58Format: 137 });
    const seed = this.configService.get('voucherAccount');

    if (seed.startsWith('0x')) {
      this.account = keyring.addFromSeed(hexToU8a(seed));
    } else if (seed.startsWith('//')) {
      this.account = keyring.addFromUri(seed);
    } else {
      this.account = keyring.addFromMnemonic(seed);
    }

    this.logger.log(`Voucher issuer: ${this.account.address}`);
  }

  /**
   * Issue a fresh voucher registering all listed programs and funding the
   * voucher with `amount` VARA. `programIds` must be non-empty.
   */
  async issue(
    account: HexString,
    programIds: HexString[],
    amount: number,
    durationInSec: number,
  ): Promise<string> {
    const requestedDurationInBlocks = Math.round(durationInSec / SECONDS_PER_BLOCK);

    this.logger.log(
      `Issuing voucher: account=${account} amount=${amount} VARA duration=${durationInSec}s programs=[${programIds.join(', ')}]`,
    );

    const [voucherId, blockNumber] = await this.sendWithOutdatedRetry(
      `issue ${account}`,
      async (api) => {
        const issuerBalance = (await api.balance.findOut(this.account.address)).toBigInt();
        if (
          issuerBalance <
          BigInt(amount) * PLANCK_PER_VARA + MIN_RESERVE_VARA * PLANCK_PER_VARA
        ) {
          throw new Error(
            `Insufficient issuer balance (${issuerBalance / PLANCK_PER_VARA} VARA). Min reserve: ${MIN_RESERVE_VARA} VARA.`,
          );
        }

        const durationInBlocks = clamp(
          requestedDurationInBlocks,
          api.voucher.minDuration,
          api.voucher.maxDuration,
        );

        const { extrinsic } = await api.voucher.issue(
          account,
          BigInt(amount) * PLANCK_PER_VARA,
          durationInBlocks,
          programIds,
        );

        const [voucherId, blockHash] = await withTimeout(
          new Promise<[HexString, HexString]>((resolve, reject) => {
            extrinsic.signAndSend(this.account, ({ events, status }) => {
              if (status.isDropped || status.isInvalid || status.isUsurped) {
                return reject(
                  new Error(`Transaction ${status.type} — not included in block`),
                );
              }
              if (status.isInBlock) {
                const viEvent = events.find(
                  ({ event }) => event.method === 'VoucherIssued',
                );
                if (viEvent) {
                  const data = viEvent.event.data as VoucherIssuedData;
                  resolve([data.voucherId.toHex(), status.asInBlock.toHex()]);
                } else {
                  const efEvent = events.find(
                    ({ event }) => event.method === 'ExtrinsicFailed',
                  );
                  reject(
                    efEvent
                      ? getExtrinsicFailedError(api, efEvent.event)
                      : new Error('VoucherIssued event not found'),
                  );
                }
              }
            }).catch(reject);
          }),
          `signAndSend timed out after ${SIGN_AND_SEND_TIMEOUT_SEC}s — transaction may or may not have landed`,
        );

        const blockNumber = (await api.blocks.getBlockNumber(blockHash)).toNumber();
        return [voucherId, blockNumber] as const;
      },
    );

    const durationInBlocks = clamp(
      requestedDurationInBlocks,
      this.api.voucher.minDuration,
      this.api.voucher.maxDuration,
    );
    const validUpToBlock = BigInt(blockNumber + durationInBlocks);
    const validUpTo = new Date(Date.now() + durationInSec * 1000);
    const now = new Date();

    this.logger.log(`Voucher issued: ${voucherId} valid until ${validUpTo.toISOString()}`);

    await this.repo.save(
      new Voucher({
        account,
        voucherId,
        validUpToBlock,
        validUpTo,
        programs: [...programIds],
        varaToIssue: amount,
        lastRenewedAt: now,
        revoked: false,
      }),
    );

    return voucherId;
  }

  /**
   * Additive top-up: adds `amountToAdd` VARA to the voucher balance and keeps
   * voucher validity near `prolongDurationInSec` from now without exceeding
   * runtime voucher duration bounds. It also optionally appends new programs.
   *
   * Unlike the legacy "top up to target" semantic, this method always adds
   * exactly `amountToAdd` — no on-chain balance subtraction. This is what the
   * hourly-tranche model expects: each tranche is a full +500 regardless of
   * what's left on the voucher.
   */
  async update(
    voucher: Voucher,
    amountToAdd: number,
    prolongDurationInSec?: number,
    addPrograms?: HexString[],
  ) {
    if (voucher.revoked) {
      throw new Error(`Cannot update revoked voucher ${voucher.voucherId} — issue a new one instead`);
    }

    const params: IUpdateVoucherParams = {};
    if (addPrograms && addPrograms.length) {
      params.appendPrograms = addPrograms;
    }
    if (amountToAdd > 0) {
      params.balanceTopUp = BigInt(amountToAdd) * PLANCK_PER_VARA;
    }

    this.logger.log(
      `Updating voucher: ${voucher.voucherId} for ${voucher.account} (+${amountToAdd} VARA, +${prolongDurationInSec ?? 0}s)`,
    );

    const blockNumber = await this.sendWithOutdatedRetry(
      `update ${voucher.voucherId}`,
      async (api) => {
        const currentHead = await api.blocks.getFinalizedHead();
        const currentBlock = (
          await api.blocks.getBlockNumber(currentHead.toHex())
        ).toNumber();
        const targetDurationInBlocks = prolongDurationInSec
          ? clamp(
              Math.round(prolongDurationInSec / SECONDS_PER_BLOCK),
              api.voucher.minDuration,
              api.voucher.maxDuration,
            )
          : 0;
        const currentRemainingBlocks = Math.max(
          0,
          Number(toBlockBigInt(voucher.validUpToBlock) - BigInt(currentBlock)),
        );
        const durationInBlocks = targetDurationInBlocks
          ? Math.max(0, targetDurationInBlocks - currentRemainingBlocks)
          : 0;
        if (durationInBlocks) {
          params.prolongDuration = durationInBlocks;
        }

        const tx = api.voucher.update(voucher.account, voucher.voucherId, params);
        const blockHash = await withTimeout(
          new Promise<HexString>((resolve, reject) => {
            tx.signAndSend(this.account, ({ events, status }) => {
              if (status.isDropped || status.isInvalid || status.isUsurped) {
                return reject(
                  new Error(`Transaction ${status.type} — not included in block`),
                );
              }
              if (status.isInBlock) {
                const vuEvent = events.find(
                  ({ event }) => event.method === 'VoucherUpdated',
                );
                if (vuEvent) {
                  resolve(status.asInBlock.toHex());
                } else {
                  const efEvent = events.find(
                    ({ event }) => event.method === 'ExtrinsicFailed',
                  );
                  reject(
                    efEvent
                      ? getExtrinsicFailedError(api, efEvent.event)
                      : new Error('VoucherUpdated event not found'),
                  );
                }
              }
            }).catch(reject);
          }),
          `signAndSend timed out after ${SIGN_AND_SEND_TIMEOUT_SEC}s`,
        );

        return (await api.blocks.getBlockNumber(blockHash)).toNumber();
      },
    );

    // Chain confirmed. Persist new state with retry — a DB save failure here
    // would let the next request read stale lastRenewedAt and mint another
    // tranche (double-mint). Retry 3× with backoff to cover transient DB
    // blips. If we still can't save after retries, we log and re-throw:
    // the caller returns 500, but the per-wallet advisory lock prevented
    // concurrent mints while we were trying.
    //
    // We intentionally DO NOT pre-save before signAndSend: a cleanly failed
    // chain call (dropped extrinsic, ExtrinsicFailed) with a pre-save would
    // strand the wallet on a DB row that permanently disagrees with chain
    // state, which is much worse than the narrow double-mint window.
    const now = new Date();
    if (addPrograms && addPrograms.length) {
      voucher.programs.push(...addPrograms);
    }
    if (prolongDurationInSec) {
      const targetDurationInBlocks = clamp(
        Math.round(prolongDurationInSec / SECONDS_PER_BLOCK),
        this.api.voucher.minDuration,
        this.api.voucher.maxDuration,
      );
      const desiredValidUpToBlock = BigInt(blockNumber + targetDurationInBlocks);
      if (desiredValidUpToBlock > toBlockBigInt(voucher.validUpToBlock)) {
        voucher.validUpToBlock = desiredValidUpToBlock;
        voucher.validUpTo = new Date(Date.now() + prolongDurationInSec * 1000);
      }
    }
    voucher.lastRenewedAt = now;

    await this.saveWithRetry(voucher, `update ${voucher.voucherId}`);

    this.logger.log(`Voucher updated: ${voucher.voucherId} valid until ${voucher.validUpTo.toISOString()}`);
  }

  /**
   * Save a voucher row with bounded retries. Used after a confirmed on-chain
   * operation to close the narrow window where a transient DB blip could
   * let the next request see stale state. Retries 3× with 200ms, 500ms,
   * 1500ms backoff. Throws if all attempts fail — the per-wallet advisory
   * lock held by the caller prevents double-mint during the retry loop.
   */
  private async saveWithRetry(voucher: Voucher, context: string): Promise<void> {
    const delays = [200, 500, 1500];
    let lastErr: unknown;
    for (let i = 0; i <= delays.length; i++) {
      try {
        await this.repo.save(voucher);
        if (i > 0) {
          this.logger.log(`DB save succeeded on retry ${i} (${context})`);
        }
        return;
      } catch (e) {
        lastErr = e;
        if (i < delays.length) {
          this.logger.warn(`DB save failed (attempt ${i + 1}, ${context}), retrying in ${delays[i]}ms`);
          await new Promise((r) => setTimeout(r, delays[i]));
        }
      }
    }
    this.logger.error(`DB save failed after ${delays.length + 1} attempts (${context})`, lastErr);
    throw lastErr;
  }

  /**
   * Append new programs to an existing voucher WITHOUT funding or extending
   * duration. Used to let migrated legacy vouchers register missing programs
   * during the 1h rate-limit window — the voucher isn't getting a new tranche,
   * it's just widening its program whitelist so writes to the new programs
   * stop failing while the 1h cooldown elapses.
   *
   * No `lastRenewedAt` update (this is not a funding event), no tranche
   * charge, no duration bump. Pure chain-side whitelist amendment.
   */
  async appendProgramsFreeOfCharge(
    voucher: Voucher,
    programIds: HexString[],
  ): Promise<void> {
    if (voucher.revoked) {
      throw new Error(
        `Cannot append to revoked voucher ${voucher.voucherId} — issue a new one instead`,
      );
    }
    if (!programIds.length) return;

    this.logger.log(
      `Appending programs (no fund) to voucher ${voucher.voucherId}: ${programIds.join(', ')}`,
    );

    await this.sendWithOutdatedRetry(
      `appendPrograms ${voucher.voucherId}`,
      async (api) => {
        const tx = api.voucher.update(voucher.account, voucher.voucherId, {
          appendPrograms: programIds,
        });

        return withTimeout(
          new Promise<HexString>((resolve, reject) => {
            tx.signAndSend(this.account, ({ events, status }) => {
              if (status.isDropped || status.isInvalid || status.isUsurped) {
                return reject(
                  new Error(`Transaction ${status.type} — not included in block`),
                );
              }
              if (status.isInBlock) {
                const vuEvent = events.find(
                  ({ event }) => event.method === 'VoucherUpdated',
                );
                if (vuEvent) {
                  resolve(status.asInBlock.toHex());
                } else {
                  const efEvent = events.find(
                    ({ event }) => event.method === 'ExtrinsicFailed',
                  );
                  reject(
                    efEvent
                      ? getExtrinsicFailedError(api, efEvent.event)
                      : new Error('VoucherUpdated event not found'),
                  );
                }
              }
            }).catch(reject);
          }),
          `appendProgramsFreeOfCharge signAndSend timed out after ${SIGN_AND_SEND_TIMEOUT_SEC}s`,
        );
      },
    );

    // Chain confirmed. Persist program list with retry — same reasoning as
    // update(): pre-saving before chain success would strand the DB ahead
    // of chain on a failed append, so the next request would see all
    // programs already registered and stop retrying the append.
    voucher.programs.push(...programIds);
    await this.saveWithRetry(voucher, `appendPrograms ${voucher.voucherId}`);
  }

  private async syncVoucherValidityFromChain(voucher: Voucher): Promise<void> {
    const api = await this.ensureConnected();
    const details = await api.voucher.getDetails(voucher.account, voucher.voucherId);
    const expiryBlock = BigInt(details.expiry);
    const currentHead = await api.blocks.getFinalizedHead();
    const currentBlock = (
      await api.blocks.getBlockNumber(currentHead.toHex())
    ).toNumber();
    const remainingBlocks = Math.max(1, Number(expiryBlock - BigInt(currentBlock)));

    voucher.validUpToBlock = expiryBlock;
    voucher.validUpTo = new Date(Date.now() + remainingBlocks * SECONDS_PER_BLOCK * 1000);
    await this.repo.save(voucher);
  }

  async revoke(voucher: Voucher): Promise<RevokeResult> {
    try {
      await this.sendWithOutdatedRetry(
        `revoke ${voucher.voucherId}`,
        async (api) => {
          const tx = api.voucher.revoke(voucher.account, voucher.voucherId);
          return withTimeout(
            new Promise<HexString>((resolve, reject) => {
              tx.signAndSend(this.account, ({ events, status }) => {
                if (status.isDropped || status.isInvalid || status.isUsurped) {
                  return reject(new Error(`Transaction ${status.type}`));
                }
                if (status.isInBlock) {
                  const vrEvent = events.find(
                    ({ event }) => event.method === 'VoucherRevoked',
                  );
                  if (vrEvent) resolve(status.asInBlock.toHex());
                  else {
                    const efEvent = events.find(
                      ({ event }) => event.method === 'ExtrinsicFailed',
                    );
                    reject(
                      efEvent
                        ? getExtrinsicFailedError(api, efEvent.event)
                        : new Error('VoucherRevoked event not found'),
                    );
                  }
                }
              }).catch(reject);
            }),
            `revoke signAndSend timed out after ${SIGN_AND_SEND_TIMEOUT_SEC}s`,
          );
        },
      );
      voucher.revoked = true;
      await this.repo.save(voucher);
      return 'revoked';
    } catch (e) {
      if (isIrrevocableYetError(e)) {
        this.logger.warn(
          `On-chain revoke skipped for ${voucher.voucherId}: voucher is still valid. Syncing DB validity instead.`,
        );
        try {
          await this.syncVoucherValidityFromChain(voucher);
        } catch (syncError) {
          this.logger.warn(
            `Failed to sync still-valid voucher ${voucher.voucherId} from chain: ${formatUnknownError(syncError)}`,
          );
        }
        return 'still_valid';
      }

      this.logger.error(
        `On-chain revoke failed for ${voucher.voucherId} — marking DB as revoked to stop retries: ${formatUnknownError(e)}`,
      );
      voucher.revoked = true;
      await this.repo.save(voucher);
      return 'db_only';
    }
  }

  async markRevokedLocally(voucher: Voucher, reason: string): Promise<void> {
    voucher.revoked = true;
    await this.repo.save(voucher);
    this.logger.warn(
      `Marked voucher ${voucher.voucherId} as revoked locally: ${reason}`,
    );
  }

  async getVoucher(account: string): Promise<Voucher | null> {
    return this.repo.findOneBy({ account, revoked: false });
  }

  /**
   * Reads the on-chain balance of a voucher ID.
   * Used by the public GET /voucher/:account endpoint so agents can detect
   * drained vouchers mid-session and decide whether to stop or ask for help.
   */
  async getVoucherBalance(voucherId: string): Promise<bigint> {
    await this.ensureConnected();
    return (await this.api.balance.findOut(voucherId)).toBigInt();
  }
}
