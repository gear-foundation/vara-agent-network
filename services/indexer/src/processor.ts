// Chain adapter using @polkadot/api directly. Subscribes to finalized block
// headers; for each block fetches the events at that block hash and emits a
// BlockContext to the handler pipeline.
//
// Design choice (Phase 5 scaffold): no Subsquid archive dependency. Vara
// testnet archive via Subsquid is not a guaranteed service. Direct RPC
// subscription is sufficient for finalized-block-only ingestion and works on
// any archive-enabled public RPC.
//
// Replay-safety (Q3): processor_cursor row records lastProcessedBlock. On
// restart, we resume from that block. Deterministic row IDs make replay
// idempotent.
import { ApiPromise, WsProvider } from "@polkadot/api";
import { eq } from "drizzle-orm";
import { config } from "./config.js";
import { log } from "./helpers/logger.js";
import {
  type BlockContext,
  type GearEvent,
  type Hex,
} from "./helpers/types.js";
import { db, schema } from "./model/db.js";

export interface ProcessorHooks {
  onBlock: (ctx: BlockContext) => Promise<void>;
}

export async function createProcessor(hooks: ProcessorHooks) {
  const provider = new WsProvider(config.varaRpcUrl);
  const api = await ApiPromise.create({ provider });
  const chain = (await api.rpc.system.chain()).toString();
  log.info("connected", { chain, endpoint: config.varaRpcUrl });

  const targetProgramIdLower = config.hackathonProgramId.toLowerCase();

  async function processBlock(blockNumber: number): Promise<void> {
    const blockHash = (await api.rpc.chain.getBlockHash(blockNumber)).toHex() as Hex;
    const apiAt = await api.at(blockHash);
    const rawEvents = await apiAt.query.system.events();
    const timestamp = ((await apiAt.query.timestamp.now()) as unknown as { toBigInt(): bigint })
      .toBigInt();

    const events: GearEvent[] = [];
    let idx = 0;
    for (const record of rawEvents as unknown as Array<{
      event: { section: string; method: string; data: { toJSON(): unknown } };
    }>) {
      const { section, method, data } = record.event;
      if (section !== "gear") {
        idx++;
        continue;
      }

      const json = data.toJSON() as unknown;

      if (method === "UserMessageSent") {
        // JSON shape: [{ id, source, destination, payload, value, details, ... }, expirationBlock?]
        const tuple = Array.isArray(json) ? json : [json];
        const stored = tuple[0] as {
          id?: string;
          source?: string;
          destination?: string;
          payload?: string;
          value?: string | number | bigint;
          details?: unknown | null;
        } | undefined;
        if (!stored || typeof stored.source !== "string") {
          idx++;
          continue;
        }
        if (stored.source.toLowerCase() !== targetProgramIdLower) {
          idx++;
          continue;
        }
        events.push({
          kind: "UserMessageSent",
          messageId: (stored.id ?? "0x") as Hex,
          source: stored.source as Hex,
          destination: (stored.destination ?? "0x") as Hex,
          payload: (stored.payload ?? "0x") as Hex,
          value: String(stored.value ?? "0"),
          hasReplyDetails: stored.details != null,
          indexInBlock: idx,
        });
      } else if (method === "MessageQueued") {
        const tuple = Array.isArray(json) ? json : [json];
        const msg = tuple[0] as {
          id?: string;
          source?: string;
          destination?: string;
        } | undefined;
        if (!msg || typeof msg.source !== "string" || typeof msg.destination !== "string") {
          idx++;
          continue;
        }
        if (
          msg.destination.toLowerCase() === targetProgramIdLower ||
          msg.source.toLowerCase() === targetProgramIdLower
        ) {
          events.push({
            kind: "MessageQueued",
            messageId: (msg.id ?? "0x") as Hex,
            source: msg.source as Hex,
            destination: msg.destination as Hex,
            indexInBlock: idx,
          });
        }
      }
      idx++;
    }

    const ctx: BlockContext = {
      substrateBlockNumber: blockNumber,
      substrateBlockHash: blockHash,
      substrateBlockTs: timestamp,
      events,
    };
    await hooks.onBlock(ctx);

    await db
      .insert(schema.processorCursor)
      .values({
        id: "main",
        lastProcessedBlock: blockNumber,
        updatedAt: BigInt(Date.now()),
      })
      .onConflictDoUpdate({
        target: schema.processorCursor.id,
        set: { lastProcessedBlock: blockNumber, updatedAt: BigInt(Date.now()) },
      });
  }

  async function resumePoint(): Promise<number> {
    const cursor = await db
      .select()
      .from(schema.processorCursor)
      .where(eq(schema.processorCursor.id, "main"))
      .limit(1);
    if (cursor[0]) return cursor[0].lastProcessedBlock + 1;
    return config.hackathonStartBlock;
  }

  /** Most public Vara RPCs run with pruning — state reads older than ~256
   *  blocks fail with "State already discarded". For an archive-backed RPC
   *  we want to backfill from HACKATHON_START_BLOCK. For a pruned RPC we
   *  clamp backfill to a safe recent window so the indexer can still boot
   *  and catch the tail of live activity.
   *
   *  PRODUCTION: point VARA_RPC_URL at an archive endpoint (or add a
   *  Subsquid archive adapter to the processor) before mainnet deploy. */
  const PRUNED_RPC_BACKFILL_DEPTH = 250;
  async function clampedResumePoint(finalizedHeight: number): Promise<number> {
    const raw = await resumePoint();
    const floor = Math.max(0, finalizedHeight - PRUNED_RPC_BACKFILL_DEPTH);
    if (raw < floor) {
      log.warn("pruned RPC — clamping backfill", {
        wantedFrom: raw,
        clampedFrom: floor,
        finalized: finalizedHeight,
      });
      return floor;
    }
    return raw;
  }

  async function runBackfill(toBlock: number): Promise<void> {
    let from = await clampedResumePoint(toBlock);
    if (from > toBlock) return;
    log.info("backfill start", { from, to: toBlock });
    for (let n = from; n <= toBlock; n++) {
      try {
        await processBlock(n);
      } catch (err) {
        const msg = String(err);
        if (msg.includes("State already discarded") || msg.includes("Unknown Block")) {
          log.warn("skipping pruned block", { block: n });
          continue;
        }
        throw err;
      }
      if (n % 50 === 0) log.info("backfill progress", { at: n, to: toBlock });
    }
    log.info("backfill done", { at: toBlock });
  }

  async function runLive(): Promise<void> {
    log.info("subscribing to finalized heads");
    await api.rpc.chain.subscribeFinalizedHeads(async (header) => {
      const height = header.number.toNumber();
      try {
        const resume = await clampedResumePoint(height);
        // Catch up if we've fallen behind finalized head.
        for (let n = resume; n <= height; n++) {
          try {
            await processBlock(n);
          } catch (err) {
            const msg = String(err);
            if (msg.includes("State already discarded") || msg.includes("Unknown Block")) {
              log.warn("skipping pruned block", { block: n });
              continue;
            }
            throw err;
          }
        }
      } catch (err) {
        log.error("block processing failed", {
          block: height,
          error: String(err),
        });
      }
    });
  }

  return {
    api,
    processBlock,
    resumePoint,
    runBackfill,
    runLive,
    async stop() {
      await api.disconnect();
    },
  };
}
