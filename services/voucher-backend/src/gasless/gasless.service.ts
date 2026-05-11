import {
  Injectable,
  Logger,
  BadRequestException,
  InternalServerErrorException,
  ServiceUnavailableException,
  HttpException,
  HttpStatus,
  OnModuleInit,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, In, Repository } from 'typeorm';
import { decodeAddress, HexString } from '@gear-js/api';
import { AdvisoryLockTimeoutError, withAdvisoryLock } from './advisory-lock';
import { getWalletLockKey } from './wallet-lock';
import {
  GaslessProgram,
  GaslessProgramStatus,
} from '../entities/gasless-program.entity';
import { Voucher } from '../entities/voucher.entity';
import { IpTrancheUsage } from '../entities/ip-tranche-usage.entity';
import { VoucherService } from './voucher.service';
import { ConfigService } from '@nestjs/config';

/**
 * Hourly-tranche model:
 *   - POST /voucher accepts `programs: string[]` and batch-registers them.
 *   - First POST for an agent issues a voucher with `HOURLY_TRANCHE_VARA` VARA
 *     covering all listed programs.
 *   - Subsequent POSTs ≥ TRANCHE_INTERVAL_SEC after the last funding event add
 *     another `HOURLY_TRANCHE_VARA` AND extend the voucher duration by
 *     `TRANCHE_DURATION_SEC`. New programs in the payload get appended.
 *   - POSTs within TRANCHE_INTERVAL_SEC return 429 with `Retry-After` header.
 *
 * Abuse gates:
 *   1. Per-IP UTC-day tranche ceiling stored in Postgres.
 *   2. TOCTOU-safe per-account pg_try_advisory_xact_lock — serializes
 *      concurrent requests from the same wallet so the DB-state check is race-free.
 *   3. DB state is authoritative (survives restarts + multi-pod).
 */
export interface VoucherResult {
  voucherId: string;
}

export interface RateLimitedBody {
  statusCode: 429;
  error: 'Too Many Requests';
  message: string;
  nextEligibleAt: string;
  retryAfterSec: number;
}

export interface RateLimitedResult {
  status: 'rate_limited';
  body: RateLimitedBody;
  retryAfterSec: number;
}

export type RequestVoucherResult =
  | { status: 'ok'; voucherId: string }
  | RateLimitedResult;

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

function isStaleOnChainVoucherError(error: unknown): boolean {
  const message = formatUnknownError(error).toLowerCase();
  return (
    message.includes('inexistentvoucher') ||
    message.includes('voucherexpired') ||
    message.includes("doesn't exist") ||
    message.includes('does not exist') ||
    message.includes('voucher has expired')
  );
}

@Injectable()
export class GaslessService implements OnModuleInit {
  private logger = new Logger(GaslessService.name);

  constructor(
    private readonly voucherService: VoucherService,
    private readonly configService: ConfigService,
    private readonly dataSource: DataSource,
    @InjectRepository(GaslessProgram)
    private readonly programRepo: Repository<GaslessProgram>,
    @InjectRepository(Voucher)
    private readonly voucherRepo: Repository<Voucher>,
    @InjectRepository(IpTrancheUsage)
    private readonly ipUsageRepo: Repository<IpTrancheUsage>,
  ) {}

  /**
   * Ensure the ip_tranche_usage table exists on boot. Production runs with
   * `synchronize: false` (app.module.ts), so new entities do NOT auto-create.
   * This self-healing DDL avoids a hand-run migration step — the first voucher
   * request after deploy would otherwise fail with "relation does not exist".
   *
   * CREATE TABLE IF NOT EXISTS is safe to run on every startup (idempotent).
   */
  async onModuleInit(): Promise<void> {
    try {
      await this.ipUsageRepo.query(`
        CREATE TABLE IF NOT EXISTS ip_tranche_usage (
          ip varchar(64) NOT NULL,
          utc_day date NOT NULL,
          count int NOT NULL DEFAULT 0,
          PRIMARY KEY (ip, utc_day)
        )
      `);
      this.logger.log('ip_tranche_usage table ensured');
    } catch (e) {
      this.logger.error(`Failed to ensure ip_tranche_usage table: ${formatUnknownError(e)}`);
      throw e; // Fail boot — ceiling is a hard gate, we must not run without it.
    }
  }

  private getTodayIsoDate(): string {
    return new Date().toISOString().slice(0, 10);
  }

  /**
   * Seconds until next UTC midnight — used as `Retry-After` when the per-IP
   * ceiling is hit (reset happens at 00:00 UTC).
   */
  private secondsUntilUtcMidnight(): number {
    const now = new Date();
    const nextMidnight = new Date(Date.UTC(
      now.getUTCFullYear(),
      now.getUTCMonth(),
      now.getUTCDate() + 1,
      0, 0, 0, 0,
    ));
    return Math.max(1, Math.ceil((nextMidnight.getTime() - now.getTime()) / 1000));
  }

  /**
   * Atomically increment the per-IP per-UTC-day tranche counter via a single
   * SQL statement (`INSERT ... ON CONFLICT DO UPDATE ... RETURNING count`).
   * No read-then-write race, no process-local state, cluster-wide correct.
   *
   * Returns `null` when the reservation succeeds. Returns a `rate_limited`
   * shape when the IP would exceed the ceiling so the caller can surface a
   * consistent 429 response (same body + Retry-After header as the per-wallet
   * path).
   *
   * Reservation is NOT refunded on downstream failure (signAndSend timeout
   * may have landed the tx on-chain; refunding would let retries re-mint).
   */
  private async reserveIpTrancheCount(ip: string): Promise<RateLimitedResult | null> {
    const ceiling = this.configService.get<number>('perIpTranchesPerDay');
    if (!ceiling || ceiling <= 0) return null; // disabled

    const today = this.getTodayIsoDate();

    // Atomic increment: the ON CONFLICT branch returns the post-increment count.
    // Use a raw query so the increment + return happens in one round-trip with
    // no read-modify-write race between concurrent requests from the same IP.
    const rows: Array<{ count: number | string }> = await this.ipUsageRepo.query(
      `INSERT INTO ip_tranche_usage (ip, utc_day, count)
       VALUES ($1, $2, 1)
       ON CONFLICT (ip, utc_day) DO UPDATE SET count = ip_tranche_usage.count + 1
       RETURNING count`,
      [ip, today],
    );
    const newCount = Number(rows[0]?.count ?? 0);

    if (newCount > ceiling) {
      this.logger.warn(
        `Per-IP tranche ceiling hit for ${ip}: ${newCount} > ${ceiling}`,
      );
      const retryAfterSec = this.secondsUntilUtcMidnight();
      const nextEligibleAt = new Date(Date.now() + retryAfterSec * 1000).toISOString();
      return {
        status: 'rate_limited',
        retryAfterSec,
        body: {
          statusCode: 429,
          error: 'Too Many Requests',
          message: `Daily voucher tranche ceiling exceeded for this IP. Limit: ${ceiling} tranches/UTC-day.`,
          nextEligibleAt,
          retryAfterSec,
        },
      };
    }

    return null;
  }

  async getVoucherInfo() {
    return {
      address: this.voucherService.account?.address,
      balance: await this.voucherService
        .getAccountBalance()
        .then((r) => r.toString(10)),
    };
  }

  /**
   * Read-only voucher state. No ceiling charge. Used by agents to decide
   * whether to POST a new voucher request or wait for the next eligible slot.
   */
  async getVoucherState(account: string) {
    let address: HexString;
    try {
      address = decodeAddress(account);
    } catch {
      throw new BadRequestException('Invalid account address');
    }

    const voucher = await this.voucherService.getVoucher(address);
    const trancheIntervalSec = this.configService.get<number>('trancheIntervalSec');

    if (!voucher) {
      return {
        voucherId: null,
        programs: [],
        validUpTo: null,
        varaBalance: '0',
        balanceKnown: true,
        lastRenewedAt: null,
        nextTopUpEligibleAt: null,
        canTopUpNow: true,
      };
    }

    let balance: bigint | null = null;
    let balanceKnown = true;
    try {
      balance = await this.voucherService.getVoucherBalance(voucher.voucherId);
    } catch (e) {
      // RPC failure — do NOT fabricate a zero balance. Returning "0" would
      // make the starter prompt's drained-voucher STOP rule trigger during
      // a transient Gear node outage, aborting live agents with full vouchers.
      this.logger.warn(`getVoucherBalance failed for ${voucher.voucherId}: ${e}`);
      balanceKnown = false;
    }

    const nowMs = Date.now();
    const rawNextEligibleMs = voucher.lastRenewedAt.getTime() + trancheIntervalSec * 1000;
    const canTopUpNow = nowMs >= rawNextEligibleMs;
    // Clamp to `now` when already eligible so clients don't render
    // "eligible since 3h ago" from stale/abandoned vouchers.
    const nextEligibleMs = canTopUpNow ? nowMs : rawNextEligibleMs;

    return {
      voucherId: voucher.voucherId,
      programs: voucher.programs,
      validUpTo: voucher.validUpTo,
      varaBalance: balance === null ? null : balance.toString(10),
      balanceKnown,
      lastRenewedAt: voucher.lastRenewedAt.toISOString(),
      nextTopUpEligibleAt: new Date(nextEligibleMs).toISOString(),
      canTopUpNow,
    };
  }

  /**
   * Process a voucher request. Returns either `{status: 'ok', voucherId}` on
   * success or `{status: 'rate_limited', body, retryAfterSec}` when the 1h
   * per-wallet limit applies — controller uses retryAfterSec to set the
   * `Retry-After` header.
   *
   * Rate-limit architecture (defense layers, innermost is authoritative):
   *   1. PG transaction-level advisory lock on account hash — serializes
   *      concurrent same-wallet requests across pods (cluster-wide, not per-process).
   *   2. DB state `existing.lastRenewedAt < now - trancheIntervalSec` — the
   *      ONLY authoritative per-wallet gate. Survives restarts + multi-pod.
   *   3. Per-IP tranche-count ceiling in Postgres — survives restarts and
   *      works across multiple service instances.
   *
   * No in-memory wallet throttle: the DB state check inside the advisory
   * lock is sufficient and correct. Adding an in-memory layer would risk
   * drift between pods with no correctness gain.
   */
  async requestVoucher(
    body: { account: string; programs?: string[]; program?: string },
    ip: string,
  ): Promise<RequestVoucherResult> {
    // Shape validation FIRST — before any logging or processing that would
    // assume `programs` is an array. DTO layer catches this normally, but
    // the guard here keeps the service safe if the ValidationPipe is ever
    // bypassed (tests, custom decorators, future refactors).
    if (body.programs !== undefined && !Array.isArray(body.programs)) {
      throw new BadRequestException('programs must be an array of contract program IDs');
    }

    // Backward-compat hint: old clients sent { account, program: string }.
    // DTO validation rejects that payload with a generic "programs must be
    // an array" error; this check surfaces a specific migration message.
    if (body.program && (body.programs === undefined || body.programs === null)) {
      throw new BadRequestException(
        'API change: `program: string` was renamed to `programs: string[]`. Send `{ account, programs: [<address>, ...] }` instead.',
      );
    }

    this.logger.log(
      `Voucher request for programs [${body.programs?.join(', ') ?? ''}] from ip ${ip}`,
    );

    let address: HexString;
    try {
      address = decodeAddress(body.account);
    } catch {
      throw new BadRequestException('Invalid account address');
    }

    // Normalize + dedupe program addresses.
    const programs = Array.from(
      new Set((body.programs ?? []).map((p) => p.toLowerCase())),
    );

    if (programs.length === 0) {
      throw new BadRequestException('programs must be a non-empty array');
    }

    // Batch whitelist lookup. Every requested program must exist + be Enabled.
    const programRows = await this.programRepo.findBy({ address: In(programs) });
    if (programRows.length !== programs.length) {
      const foundAddrs = new Set(programRows.map((r) => r.address));
      const missing = programs.filter((p) => !foundAddrs.has(p));
      throw new BadRequestException(
        `Program(s) not whitelisted: ${missing.join(', ')}`,
      );
    }
    const disabled = programRows.filter(
      (r) => r.status !== GaslessProgramStatus.Enabled,
    );
    if (disabled.length > 0) {
      throw new BadRequestException(
        `Program(s) disabled: ${disabled.map((r) => r.address).join(', ')}`,
      );
    }

    const trancheVara = this.configService.get<number>('hourlyTrancheVara');
    const trancheIntervalSec = this.configService.get<number>('trancheIntervalSec');
    const trancheDurationSec = this.configService.get<number>('trancheDurationSec');

    const [lockKey1, lockKey2] = getWalletLockKey(address);

    try {
      return await withAdvisoryLock(
        this.dataSource,
        [lockKey1, lockKey2],
        `voucher request ${address}`,
        async () => {
          const existing = await this.voucherService.getVoucher(address);

      // oneTime enforcement across the batch: if any requested program is
      // oneTime AND already in the voucher, reject.
      //
      // KNOWN LIMITATION (accepted for this PR, no oneTime programs in
      // seed.ts today): this only inspects the current non-revoked voucher.
      // If the cron revokes a voucher carrying a oneTime program, `existing`
      // becomes null and the next POST re-issues that oneTime program on a
      // fresh voucher. When any program is actually marked oneTime,
      // introduce a separate `one_time_claim(account, program_address)` row
      // with a unique constraint so the check spans the full history.
      const oneTimeConflicts = programRows
        .filter(
          (r) => r.oneTime && existing?.programs.includes(r.address),
        )
        .map((r) => r.address);
      if (oneTimeConflicts.length > 0) {
        throw new BadRequestException(
          `One-time voucher already issued for: ${oneTimeConflicts.join(', ')}`,
        );
      }

      // Branch (a): no existing voucher → fresh issue.
      if (!existing) {
        const ipLimit = await this.reserveIpTrancheCount(ip);
        if (ipLimit) return ipLimit;
        const voucherId = await this.voucherService.issue(
          address,
          programs as HexString[],
          trancheVara,
          trancheDurationSec,
        );
        return { status: 'ok', voucherId };
      }

      const cutoffMs = Date.now() - trancheIntervalSec * 1000;
      const lastRenewedMs = existing.lastRenewedAt.getTime();
      const missingPrograms = programs.filter(
        (p) => !existing.programs.includes(p),
      );

      // Branch (b): eligible for top-up.
      // Boundary is inclusive (<=) so clients that sleep until
      // `nextTopUpEligibleAt` and POST exactly at that instant don't hit a
      // spurious 429 — matches getVoucherState's `now >= nextEligibleMs`
      // semantics for canTopUpNow.
      if (lastRenewedMs <= cutoffMs) {
        const ipLimit = await this.reserveIpTrancheCount(ip);
        if (ipLimit) {
          // IP daily tranche budget exhausted. A funded top-up isn't
          // possible right now, but widening the program whitelist costs
          // no VARA — let migrated legacy vouchers with partial programs
          // escape the "stuck until midnight" trap. If there's nothing to
          // append, surface the 429 as usual.
          if (missingPrograms.length > 0) {
            await this.voucherService.appendProgramsFreeOfCharge(
              existing,
              missingPrograms as HexString[],
            );
            return { status: 'ok', voucherId: existing.voucherId };
          }
          return ipLimit;
        }
        try {
          await this.voucherService.update(
            existing,
            trancheVara,
            trancheDurationSec,
            missingPrograms.length
              ? (missingPrograms as HexString[])
              : undefined,
          );
        } catch (error) {
          if (!isStaleOnChainVoucherError(error)) throw error;

          this.logger.warn(
            `Voucher ${existing.voucherId} for account=${address} is stale on-chain (${formatUnknownError(error)}); issuing replacement`,
          );
          await this.voucherService.markRevokedLocally(
            existing,
            `stale on-chain during update: ${formatUnknownError(error)}`,
          );
          const voucherId = await this.voucherService.issue(
            address,
            programs as HexString[],
            trancheVara,
            trancheDurationSec,
          );
          return { status: 'ok', voucherId };
        }
        return { status: 'ok', voucherId: existing.voucherId };
      }

      // Branch (c): within the 1h window.
      //
      // If the request lists any programs NOT already on the voucher, append
      // them free of charge (no tranche cost, no duration bump, no
      // lastRenewedAt update). This covers migrated legacy vouchers that
      // were funded with only a subset of programs and need the remaining
      // ones before the hour elapses.
      //
      // If all requested programs are already on the voucher, it's a true
      // rate-limit violation → 429.
      if (missingPrograms.length > 0) {
        try {
          await this.voucherService.appendProgramsFreeOfCharge(
            existing,
            missingPrograms as HexString[],
          );
        } catch (error) {
          if (!isStaleOnChainVoucherError(error)) throw error;

          this.logger.warn(
            `Voucher ${existing.voucherId} for account=${address} is stale on-chain (${formatUnknownError(error)}); issuing replacement`,
          );
          await this.voucherService.markRevokedLocally(
            existing,
            `stale on-chain during append: ${formatUnknownError(error)}`,
          );
          const ipLimit = await this.reserveIpTrancheCount(ip);
          if (ipLimit) return ipLimit;
          const voucherId = await this.voucherService.issue(
            address,
            programs as HexString[],
            trancheVara,
            trancheDurationSec,
          );
          return { status: 'ok', voucherId };
        }
        return { status: 'ok', voucherId: existing.voucherId };
      }

      const nextEligibleMs = lastRenewedMs + trancheIntervalSec * 1000;
      const retryAfterSec = Math.max(
        1,
        Math.ceil((nextEligibleMs - Date.now()) / 1000),
      );
          return {
            status: 'rate_limited',
            retryAfterSec,
            body: {
              statusCode: 429,
              error: 'Too Many Requests',
              message: 'Per-wallet rate limit: 1 voucher request per hour',
              nextEligibleAt: new Date(nextEligibleMs).toISOString(),
              retryAfterSec,
            },
          };
        },
      );
    } catch (error) {
      if (error instanceof HttpException) throw error;
      if (error instanceof AdvisoryLockTimeoutError) {
        this.logger.warn(
          `Voucher request for account=${address} ip=${ip} timed out waiting for advisory lock`,
        );
        throw new ServiceUnavailableException('Voucher service is busy — please retry');
      }
      this.logger.error(
        `Failed to process voucher request for account=${address} ip=${ip}: ${formatUnknownError(error)}`,
      );
      throw new InternalServerErrorException('Voucher processing failed — please retry');
    }
  }
}
