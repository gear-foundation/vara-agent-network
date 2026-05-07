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
import { decodeAddress } from "@polkadot/util-crypto";
import { u8aToHex } from "@polkadot/util";
import { eq } from "drizzle-orm";
import { requireProcessorConfig } from "./config.js";
import { log } from "./helpers/logger.js";
import {
  type BlockContext,
  type GearEvent,
  type Hex,
} from "./helpers/types.js";
import { db, schema } from "./model/db.js";
import { P2PDetector } from "./processor/p2p-detector.js";

export interface ProcessorHooks {
  onBlock: (ctx: BlockContext) => Promise<void>;
}

export async function createProcessor(hooks: ProcessorHooks) {
  const config = requireProcessorConfig();
  const provider = new WsProvider(config.varaRpcUrl);
  const api = await ApiPromise.create({ provider });
  const chain = (await api.rpc.system.chain()).toString();
  log.info("connected", { chain, endpoint: config.varaRpcUrl });

  const p2pDetector = new P2PDetector();

  // Catch-up reuses the previous block's hash as the next block's parent —
  // saves one `state_getBlockHash` RPC per block in the live tail.
  let lastProcessedNumber: number | null = null;
  let lastProcessedHash: Hex | null = null;

  // Normalize ActorId strings to lowercase hex. Gear events surface addresses
  // in mixed formats:
  //   Gear.MessageQueued's source is SS58 (wallet-style extrinsic origin),
  //   destination is hex. UserMessageSent fields are all hex. Programs
  //   sending messages also emit MessageQueued with source=hex — so we
  //   detect SS58 by absence of '0x' prefix and decode defensively.
  function normalizeActorId(addr: string): `0x${string}` {
    if (addr.startsWith("0x")) return addr.toLowerCase() as `0x${string}`;
    try {
      return u8aToHex(decodeAddress(addr)).toLowerCase() as `0x${string}`;
    } catch {
      return addr.toLowerCase() as `0x${string}`;
    }
  }

  async function processBlock(blockNumber: number, opts?: { runP2PDetector?: boolean }): Promise<void> {
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
          details?: { to?: string; code?: unknown } | null;
        } | undefined;
        if (!stored || typeof stored.source !== "string") {
          idx++;
          continue;
        }
        const source = normalizeActorId(stored.source);
        // NOTE: we used to early-continue when `source !== targetProgramIdLower`,
        // dropping every reply that didn't come from the network program. That
        // hid replies from registered applications — needed by Strategy C
        // (`handleUserMessageSentBacktrack` in `handlers/p2p_inference.ts`)
        // to detect hidden P2P intermediates. The `source !== networkProgram`
        // gate now lives at the top of Pass 1 in `main.ts`, where the Sails
        // decoder still skips non-network replies. If you remove that gate
        // without restoring this filter, the Sails decoder will warn about
        // every app reply ("undecodable sails event"). Co-landed change.
        const detailsObj = stored.details ?? null;
        const replyToMessageId =
          detailsObj && typeof detailsObj.to === "string"
            ? normalizeActorId(detailsObj.to)
            : null;
        events.push({
          kind: "UserMessageSent",
          messageId: normalizeActorId(stored.id ?? "0x"),
          source,
          destination: normalizeActorId(stored.destination ?? "0x"),
          payload: (stored.payload ?? "0x") as Hex,
          value: String(stored.value ?? "0"),
          hasReplyDetails: detailsObj != null,
          replyToMessageId,
          indexInBlock: idx,
        });
      } else if (method === "MessagesDispatched") {
        // JSON shape: [total, statuses, stateChanges] from polkadot-js raw
        // events on Vara dev / testnet. Some metadata variants surface this as
        // a struct-shape object — handle both. statuses is a BTreeMap rendered
        // as { msgId: status }; we don't consume it here, only total + state
        // changes feed Strategy A. stateChanges is a BTreeSet<ActorId>
        // serialised as an array of hex strings.
        const obj = Array.isArray(json)
          ? { total: json[0], statuses: json[1], stateChanges: json[2] }
          : (json as { total?: unknown; stateChanges?: unknown });
        const totalRaw = obj?.total;
        const total =
          typeof totalRaw === "number"
            ? totalRaw
            : typeof totalRaw === "string"
              ? Number.parseInt(totalRaw, 10)
              : 0;
        const rawStateChanges = obj?.stateChanges;
        const stateChanges: Hex[] = Array.isArray(rawStateChanges)
          ? rawStateChanges
              .filter((s): s is string => typeof s === "string")
              .map((s) => normalizeActorId(s))
          : [];
        events.push({
          kind: "MessagesDispatched",
          total,
          stateChanges,
          indexInBlock: idx,
        });
      } else if (method === "MessageQueued") {
        // JSON shape: [messageId, source, destination, entry?] — a flat
        // positional tuple. `source` is SS58 for wallet-originated extrinsics
        // and hex for program-originated sends; normalizeActorId handles both.
        if (!Array.isArray(json) || json.length < 3) {
          idx++;
          continue;
        }
        const rawMessageId = json[0];
        const rawSource = json[1];
        const rawDestination = json[2];
        if (
          typeof rawMessageId !== "string" ||
          typeof rawSource !== "string" ||
          typeof rawDestination !== "string"
        ) {
          idx++;
          continue;
        }
        const source = normalizeActorId(rawSource);
        const destination = normalizeActorId(rawDestination);
        // Do not pre-filter by the root Vara Agent Network program here.
        // Registered applications can talk directly to each other, and those
        // app->app messages will not have the registry/chat/board program as
        // either side. The interaction handler resolves both actors against
        // the projected registry and drops irrelevant chain traffic there.
        events.push({
          kind: "MessageQueued",
          messageId: normalizeActorId(rawMessageId),
          source,
          destination,
          indexInBlock: idx,
        });
      }
      idx++;
    }

    // P2P detector: snapshot-diff the messenger storage between parent and
    // current block to surface program → program edges that pallet-gear does
    // not emit as events. Public RPCs prune state ≈250 blocks back, so this
    // only runs in live mode (the catch-up loop opts in). During backfill
    // the parent-state read would fail with `State already discarded`.
    //
    // Failure policy: best-effort overlay. Any detector error logs and
    // returns no edges; the wallet-driven `MessageQueued` projection still
    // runs and the cursor still advances. Halting the cursor on a P2P
    // overlay failure would block the entire indexer over a secondary
    // metric, which trades a transient gap in `p2p_*` columns for a hard
    // outage on the public dashboard. Detector reset on hard error to
    // invalidate the cached parent snapshot.
    if (opts?.runP2PDetector) {
      try {
        // Reuse the previous block's hash if we processed `blockNumber - 1`
        // last; otherwise fetch fresh.
        const parentHash =
          lastProcessedNumber === blockNumber - 1 && lastProcessedHash
            ? lastProcessedHash
            : ((await api.rpc.chain.getBlockHash(blockNumber - 1)).toHex() as Hex);
        const p2pEvents = await p2pDetector.detect({
          api,
          blockHash,
          parentHash,
          baseIndex: events.length,
        });
        events.push(...p2pEvents);
      } catch (err) {
        const msg = String(err);
        if (msg.includes("State already discarded") || msg.includes("Unknown Block")) {
          log.warn("p2p detector: parent state pruned, skipping", { block: blockNumber });
        } else {
          log.warn("p2p detector failed (continuing)", { block: blockNumber, error: msg });
        }
        p2pDetector.reset();
      }
    } else {
      // Skipped this block — cached snapshot is no longer adjacent to the
      // next block we'll see, so invalidate it.
      p2pDetector.reset();
    }

    const ctx: BlockContext = {
      substrateBlockNumber: blockNumber,
      substrateBlockHash: blockHash,
      substrateBlockTs: timestamp,
      events,
      inLiveWindow: opts?.runP2PDetector === true,
    };
    await hooks.onBlock(ctx);

    lastProcessedNumber = blockNumber;
    lastProcessedHash = blockHash;

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
    return config.startBlock;
  }

  /** Most public Vara RPCs run with pruning — state reads older than ~256
   *  blocks fail with "State already discarded". For an archive-backed RPC
   *  we want to backfill from VARA_AGENTS_START_BLOCK. For a pruned RPC we
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

  // Single-flight guard for the finalized-head catch-up loop. Substrate
  // finalized heads can arrive faster than we can process them; without this
  // guard, two async callbacks would both read a stale cursor, both try to
  // process the same blocks, and race on cursor writes. (Finding #1.)
  let catchUpInFlight: Promise<void> | null = null;
  async function catchUpTo(height: number): Promise<void> {
    const resume = await clampedResumePoint(height);
    for (let n = resume; n <= height; n++) {
      try {
        // Only run P2P detector when we're close enough to the head that
        // (n - 1) state is still served by the RPC. Older catch-up blocks
        // skip detection — backfill gap is documented in the README.
        const inLiveWindow = height - n < PRUNED_RPC_BACKFILL_DEPTH;
        await processBlock(n, { runP2PDetector: inLiveWindow });
      } catch (err) {
        const msg = String(err);
        if (msg.includes("State already discarded") || msg.includes("Unknown Block")) {
          log.warn("skipping pruned block", { block: n });
          // Skipped blocks still advance the cursor to avoid infinite retry.
          await db
            .insert(schema.processorCursor)
            .values({ id: "main", lastProcessedBlock: n, updatedAt: BigInt(Date.now()) })
            .onConflictDoUpdate({
              target: schema.processorCursor.id,
              set: { lastProcessedBlock: n, updatedAt: BigInt(Date.now()) },
            });
          continue;
        }
        // Non-pruning error: bail without advancing so next head triggers retry.
        throw err;
      }
    }
  }

  async function runLive(): Promise<void> {
    log.info("subscribing to finalized heads");
    await api.rpc.chain.subscribeFinalizedHeads(async (header) => {
      const height = header.number.toNumber();
      if (catchUpInFlight) {
        // A prior callback is still running. It will see the new head via its
        // own height read on the next iteration only if we chain this one on.
        // Simplest correct behavior: wait, then run ours; duplicates will be
        // handled by cursor-based resume.
        await catchUpInFlight;
      }
      catchUpInFlight = (async () => {
        try {
          await catchUpTo(height);
        } catch (err) {
          log.error("block processing failed", { block: height, error: String(err) });
        } finally {
          catchUpInFlight = null;
        }
      })();
      await catchUpInFlight;
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
