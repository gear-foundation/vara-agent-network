import { ApiPromise, WsProvider } from "@polkadot/api";
import { Keyring } from "@polkadot/keyring";
import { cryptoWaitReady } from "@polkadot/util-crypto";
import type { SubmittableExtrinsic } from "@polkadot/api/types";
import { config } from "./config.js";
import { normalizeAddress, requireAddress, toBigIntString } from "./address.js";
import { log } from "./logger.js";

type Api = ApiPromise;

export interface SpendEvent {
  id: string;
  wallet: string;
  recipient: string;
  amountRaw: bigint;
  kind: "balances_transfer" | "gear_value";
  substrateBlockNumber: number;
  substrateBlockTs: Date;
  extrinsicIdx: number | null;
  eventIdx: number | null;
}

export class ChainClient {
  private api: Api | null = null;
  private account: ReturnType<Keyring["addFromUri"]> | null = null;

  async connect(): Promise<Api> {
    if (this.api) return this.api;
    await cryptoWaitReady();
    const provider = new WsProvider(config.varaRpcUrl);
    this.api = await ApiPromise.create({ provider });

    const keyring = new Keyring({ type: "sr25519" });
    this.account = keyring.addFromUri(config.seedAccount);
    const chain = (await this.api.rpc.system.chain()).toString();
    log.info("seed backend connected to chain", {
      chain,
      endpoint: config.varaRpcUrl,
      seedAddress: this.account.address,
    });
    return this.api;
  }

  async finalizedHeight(): Promise<number> {
    const api = await this.connect();
    const hash = await api.rpc.chain.getFinalizedHead();
    const header = await api.rpc.chain.getHeader(hash);
    return header.number.toNumber();
  }

  async balanceOf(address: string): Promise<bigint> {
    const api = await this.connect();
    const normalized = requireAddress(address, "address");
    const account = await api.query.system.account(normalized);
    return BigInt((account as unknown as { data: { free: { toString(): string } } }).data.free.toString());
  }

  async transfer(to: string, amountRaw: bigint): Promise<string> {
    const api = await this.connect();
    if (!this.account) throw new Error("seed account is not initialized");
    const recipient = requireAddress(to, "recipient");

    const balances = api.tx.balances as unknown as {
      transferKeepAlive?: (dest: string, value: bigint) => SubmittableExtrinsic<"promise">;
      transferAllowDeath?: (dest: string, value: bigint) => SubmittableExtrinsic<"promise">;
      transfer?: (dest: string, value: bigint) => SubmittableExtrinsic<"promise">;
    };

    const tx =
      balances.transferKeepAlive?.(recipient, amountRaw) ??
      balances.transferAllowDeath?.(recipient, amountRaw) ??
      balances.transfer?.(recipient, amountRaw);

    if (!tx) throw new Error("balances transfer call is not available in this runtime");

    return new Promise<string>((resolve, reject) => {
      let unsub: (() => void) | undefined;
      const timeout = setTimeout(() => {
        unsub?.();
        reject(new Error("transfer timed out before finalization"));
      }, 120_000);

      tx.signAndSend(this.account!, (result) => {
        if (result.dispatchError) {
          clearTimeout(timeout);
          unsub?.();
          reject(new Error(result.dispatchError.toString()));
          return;
        }
        if (result.status.isFinalized || result.status.isInBlock) {
          clearTimeout(timeout);
          unsub?.();
          resolve(result.txHash.toHex());
        }
      })
        .then((u) => {
          unsub = u;
        })
        .catch((err) => {
          clearTimeout(timeout);
          reject(err);
        });
    });
  }

  async readSpendEvents(blockNumber: number, fundedWallets: Set<string>): Promise<SpendEvent[]> {
    if (fundedWallets.size === 0) return [];
    const api = await this.connect();
    const blockHash = await api.rpc.chain.getBlockHash(blockNumber);
    const apiAt = await api.at(blockHash);
    const [eventsRaw, block, timestampRaw] = await Promise.all([
      apiAt.query.system.events(),
      api.rpc.chain.getBlock(blockHash),
      apiAt.query.timestamp.now(),
    ]);

    const timestamp = new Date(Number((timestampRaw as unknown as { toBigInt(): bigint }).toBigInt()));
    const events: SpendEvent[] = [];
    const extrinsics = block.block.extrinsics;
    const records = eventsRaw as unknown as Array<{
      phase: { isApplyExtrinsic?: boolean; asApplyExtrinsic?: { toNumber(): number } };
      event: {
        section: string;
        method: string;
        data: unknown[];
      };
    }>;

    records.forEach((record, eventIdx) => {
      if (record.event.section !== "balances" || record.event.method !== "Transfer") return;
      const data = record.event.data;
      const from = normalizeAddress(data[0]);
      const to = normalizeAddress(data[1]);
      const amountRaw = BigInt(toBigIntString(data[2]));
      if (!from || !to || amountRaw <= 0n || !fundedWallets.has(from)) return;
      const extrinsicIdx = record.phase.isApplyExtrinsic ? record.phase.asApplyExtrinsic?.toNumber() ?? null : null;
      events.push({
        id: `balances:${blockNumber}:${eventIdx}`,
        wallet: from,
        recipient: to,
        amountRaw,
        kind: "balances_transfer",
        substrateBlockNumber: blockNumber,
        substrateBlockTs: timestamp,
        extrinsicIdx,
        eventIdx,
      });
    });

    extrinsics.forEach((extrinsic, extrinsicIdx) => {
      if (!extrinsic.isSigned) return;
      const signer = normalizeAddress(extrinsic.signer.toString());
      if (!signer || !fundedWallets.has(signer)) return;
      const method = extrinsic.method;
      if (method.section !== "gear") return;
      const methodName = method.method.toLowerCase();
      if (!methodName.includes("send")) return;

      const args = method.args;
      const metaArgs = method.meta.args;
      const argByName = new Map<string, unknown>();
      metaArgs.forEach((argMeta, idx) => {
        argByName.set(argMeta.name.toString().toLowerCase(), args[idx]);
      });

      const destinationRaw =
        argByName.get("destination") ??
        argByName.get("dest") ??
        argByName.get("program_id") ??
        args[0];
      const valueRaw =
        argByName.get("value") ??
        argByName.get("amount") ??
        args[3];

      const recipient = normalizeAddress(String(destinationRaw));
      const amountRaw = BigInt(toBigIntString(valueRaw));
      if (!recipient || amountRaw <= 0n) return;

      events.push({
        id: `gear-value:${blockNumber}:${extrinsicIdx}`,
        wallet: signer,
        recipient,
        amountRaw,
        kind: "gear_value",
        substrateBlockNumber: blockNumber,
        substrateBlockTs: timestamp,
        extrinsicIdx,
        eventIdx: null,
      });
    });

    return events;
  }
}
