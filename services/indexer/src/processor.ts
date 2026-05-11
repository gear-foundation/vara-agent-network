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
import { formatError, log } from "./helpers/logger.js";
import {
  type BlockContext,
  type GearEvent,
  type Hex,
} from "./helpers/types.js";
import { db, schema } from "./model/db.js";

export interface ProcessorHooks {
  onBlock: (ctx: BlockContext) => Promise<void>;
}

// polkadot.js exposes apiAt.runtimeVersion as `RuntimeVersionPartial` at runtime,
// but its `api.at(blockHash, knownVersion)` parameter is typed as `RuntimeVersion`.
// The internal cache lookup (_getBlockRegistryViaVersion) only inspects
// specName/specVersion, both of which the partial type has. Use the api.at
// parameter type as the cache type and cast at the discovery boundary.
type CachedRuntimeVersion = NonNullable<Parameters<ApiPromise["at"]>[1]>;

export async function createProcessor(hooks: ProcessorHooks) {
  const config = requireProcessorConfig();
  const backfillFetchConcurrency = Math.max(1, config.processorBackfillFetchConcurrency);
  const revalidateEveryN = Math.max(0, config.processorRuntimeRevalidateEveryNBlocks);
  const provider = new WsProvider(config.varaRpcUrl);
  let stopped = false;
  let stopReason: Error | null = null;
  let failProcessor!: (error: Error) => void;
  const waitUntilStopped = new Promise<never>((_, reject) => {
    failProcessor = reject;
  });

  function asError(reason: unknown): Error {
    if (reason instanceof Error) return reason;
    const meta = formatError(reason);
    return new Error(typeof meta.message === "string" ? meta.message : String(reason));
  }

  function fail(reason: unknown): void {
    if (stopped || stopReason) return;
    stopReason = asError(reason);
    failProcessor(stopReason);
  }

  provider.on("connected", () => {
    log.info("rpc connected", { endpoint: config.varaRpcUrl });
  });
  provider.on("disconnected", () => {
    log.warn("rpc disconnected", { endpoint: config.varaRpcUrl });
    fail(new Error("RPC provider disconnected"));
  });
  provider.on("error", (error: unknown) => {
    log.error("rpc provider error", { endpoint: config.varaRpcUrl, error: formatError(error) });
    fail(error);
  });

  const api = await Promise.race([
    ApiPromise.create({ provider }),
    waitUntilStopped,
  ]);
  const chain = (await api.rpc.system.chain()).toString();
  log.info("connected", { chain, endpoint: config.varaRpcUrl });

  const targetProgramIdLower = config.programId.toLowerCase();

  // Runtime-version cache. Anchored to a specific historical block, NOT the
  // node's current head — initializing from `api.rpc.state.getRuntimeVersion()`
  // (unqualified) would silently mis-decode historical events on a chain that
  // has had a runtime upgrade between then and now. Discovery happens on the
  // first block of each run via api.at(blockHash) without knownVersion, which
  // populates polkadot.js's internal #registries cache and lets every
  // subsequent call short-circuit `state_getRuntimeVersion`.
  let runtimeVersion: CachedRuntimeVersion | undefined = undefined;
  // Counter for telemetry / verification. Increments on every slow-path
  // (no-knownVersion) discovery call.
  let runtimeDiscoveryCount = 0;
  // Tracks blocks applied since the last revalidation probe. Reset every
  // `revalidateEveryN` applied blocks.
  let blocksSinceRevalidate = 0;
  // Single-flight gate. Without this, the first batch of N parallel fetchInner
  // calls all observe `runtimeVersion === undefined` and each does its own
  // slow-path discovery — wasting N-1 redundant RPCs at boot and after every
  // CodeUpdated drain. Verified: with concurrency=10, discoveryCount went 1→10
  // on the first batch before this gate; with the gate, exactly 1.
  let runtimeDiscoveryInFlight: Promise<void> | null = null;

  async function discoverRuntimeAt(blockHash: Hex): Promise<void> {
    if (runtimeVersion) return;
    if (!runtimeDiscoveryInFlight) {
      runtimeDiscoveryInFlight = (async () => {
        // Slow path: forces polkadot.js to fetch chain.getHeader +
        // state.getRuntimeVersion for this hash (see
        // @polkadot/api/base/Init.js:_getBlockRegistryViaHash). After this
        // call, the resolved (specName, specVersion) lives in the #registries
        // array and matches against api.at(blockHash, runtimeVersion) hit
        // the fast path.
        const apiAt = await api.at(blockHash);
        runtimeVersion = apiAt.runtimeVersion as CachedRuntimeVersion;
        runtimeDiscoveryCount += 1;
        log.info("runtime discovered", {
          blockHash,
          specName: runtimeVersion.specName.toString(),
          specVersion: runtimeVersion.specVersion.toNumber(),
          discoveryCount: runtimeDiscoveryCount,
        });
      })().finally(() => {
        runtimeDiscoveryInFlight = null;
      });
    }
    await runtimeDiscoveryInFlight;
  }

  function isPrunedBlockError(error: unknown): boolean {
    const msg = String(error);
    return msg.includes("State already discarded") || msg.includes("Unknown Block");
  }

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

  async function fetchInner(blockNumber: number): Promise<BlockContext> {
    const blockHash = (await api.rpc.chain.getBlockHash(blockNumber)).toHex() as Hex;

    if (!runtimeVersion) {
      // First block of the run, or just after a CodeUpdated drain.
      await discoverRuntimeAt(blockHash);
    }

    const apiAt = await api.at(blockHash, runtimeVersion);
    // Batch events + timestamp into a single `state_queryStorageAt` RPC.
    // Previously these were two separate Promise.all'd calls — same wall-clock
    // sometimes, but doubles the WS message volume. queryMulti folds both
    // storage reads into one network roundtrip and one server-side lookup.
    const [rawEvents, timestampRaw] = await apiAt.queryMulti([
      apiAt.query.system.events,
      apiAt.query.timestamp.now,
    ]);
    const timestamp = (timestampRaw as unknown as { toBigInt(): bigint }).toBigInt();

    const events: GearEvent[] = [];
    let containsCodeUpdated = false;
    let idx = 0;
    for (const record of rawEvents as unknown as Array<{
      event: { section: string; method: string; data: { toJSON(): unknown } };
    }>) {
      const { section, method, data } = record.event;

      // Detect runtime upgrades. Substrate semantics: `set_code` executes
      // under the parent runtime, `system.CodeUpdated` is emitted by the same
      // block under that old runtime, and the new code applies from N+1.
      // Decoding the current block with the cached (old) version is therefore
      // correct; processRange will drain any in-flight successor blocks and
      // rediscover the post-upgrade runtime at N+1.
      if (section === "system" && method === "CodeUpdated") {
        containsCodeUpdated = true;
        idx++;
        continue;
      }

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
        const source = normalizeActorId(stored.source);
        if (source !== targetProgramIdLower) {
          idx++;
          continue;
        }
        events.push({
          kind: "UserMessageSent",
          messageId: normalizeActorId(stored.id ?? "0x"),
          source,
          destination: normalizeActorId(stored.destination ?? "0x"),
          payload: (stored.payload ?? "0x") as Hex,
          value: String(stored.value ?? "0"),
          hasReplyDetails: stored.details != null,
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

    // Debug hook: PROCESSOR_SYNTHETIC_CODE_UPDATED_AT_BLOCK=<N> forces this
    // block to be tagged as if it contained system.CodeUpdated. Lets us
    // exercise the drain path without waiting for a real runtime upgrade.
    if (
      config.processorSyntheticCodeUpdatedAtBlock > 0 &&
      blockNumber === config.processorSyntheticCodeUpdatedAtBlock
    ) {
      log.warn("synthetic CodeUpdated injected", { block: blockNumber });
      containsCodeUpdated = true;
    }

    return {
      substrateBlockNumber: blockNumber,
      substrateBlockHash: blockHash,
      substrateBlockTs: timestamp,
      events,
      containsCodeUpdated,
    };
  }

  async function fetchBlockContext(blockNumber: number): Promise<BlockContext> {
    try {
      return await fetchInner(blockNumber);
    } catch (firstErr) {
      // Pruned blocks must propagate as-is so processRange can skip them.
      if (isPrunedBlockError(firstErr)) throw firstErr;
      // Reset cache; the second call will hit discoverRuntimeAt's slow path
      // and rebuild against actual chain state. If that also fails, surface
      // both errors via Error.cause so debugging keeps the original context.
      runtimeVersion = undefined;
      try {
        return await fetchInner(blockNumber);
      } catch (secondErr) {
        throw new Error(`fetchBlockContext(${blockNumber}) failed twice`, {
          cause: { firstErr, secondErr },
        });
      }
    }
  }

  async function applyBlockContext(ctx: BlockContext): Promise<void> {
    await hooks.onBlock(ctx);
  }

  async function updateCursor(blockNumber: number): Promise<void> {
    // Bench/debug escape hatch — see processorDisableCursorWrites in config.ts.
    // Prevents a no-op-handler fetch benchmark from advancing the cursor in
    // whatever DATABASE_URL it happens to be pointed at.
    if (config.processorDisableCursorWrites) return;
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

  async function processBlock(blockNumber: number): Promise<void> {
    const ctx = await fetchBlockContext(blockNumber);
    await applyBlockContext(ctx);
    await updateCursor(blockNumber);
  }

  async function resumePoint(): Promise<number> {
    // When cursor writes are disabled (bench mode), also ignore cursor reads
    // so a stale row from a previous real run doesn't skew the start point.
    if (config.processorDisableCursorWrites) return config.startBlock;
    const cursor = await db
      .select()
      .from(schema.processorCursor)
      .where(eq(schema.processorCursor.id, "main"))
      .limit(1);
    if (cursor[0]) return cursor[0].lastProcessedBlock + 1;
    return config.startBlock;
  }

  /** Most public Vara RPCs run with pruning — state reads older than ~256
   *  blocks fail with "State already discarded". Production should use an
   *  archive endpoint and replay every missing block. Local/dev pruned RPCs
   *  may opt into clamping with PROCESSOR_PRUNED_RPC_BACKFILL_DEPTH. */
  async function clampedResumePoint(finalizedHeight: number): Promise<number> {
    const raw = await resumePoint();
    const depth = config.processorPrunedRpcBackfillDepth;
    if (depth <= 0) return raw;
    const floor = Math.max(0, finalizedHeight - depth);
    if (raw < floor) {
      log.warn("pruned RPC — clamping backfill", {
        wantedFrom: raw,
        clampedFrom: floor,
        finalized: finalizedHeight,
        depth,
      });
      return floor;
    }
    return raw;
  }

  async function runBackfill(toBlock: number): Promise<void> {
    let from = await clampedResumePoint(toBlock);
    if (from > toBlock) return;
    log.info("backfill start", { from, to: toBlock, fetchConcurrency: backfillFetchConcurrency });
    await processRange(from, toBlock, "backfill");
    log.info("backfill done", { at: toBlock });
  }

  // Single-flight guard for the finalized-head catch-up loop. Substrate
  // finalized heads can arrive faster than we can process them; without this
  // guard, two async callbacks would both read a stale cursor, both try to
  // process the same blocks, and race on cursor writes. (Finding #1.)
  let catchUpInFlight: Promise<void> | null = null;
  let unsubscribeFinalizedHeads: (() => void) | null = null;
  async function catchUpTo(height: number): Promise<void> {
    const resume = await clampedResumePoint(height);
    await processRange(resume, height, "live");
  }

  /** Pre-batch revalidation. Runs before any block of the upcoming batch is
   *  fetched/applied so a missed `CodeUpdated` is detected BEFORE stale
   *  projections are written and the cursor is advanced. Probes the runtime
   *  at the first block of the next batch via raw JSON-RPC (api.at would
   *  short-circuit on the #registries[*].lastBlockHash match set earlier).
   *
   *  On mismatch, resets `runtimeVersion=undefined`. The very next
   *  fetchInner call triggers discoverRuntimeAt's slow path, which both
   *  refetches the runtime AND repopulates polkadot.js's metadata cache
   *  against the new (specName, specVersion).
   */
  async function maybeRevalidateBeforeBatch(nextBlockNumber: number): Promise<void> {
    if (revalidateEveryN <= 0) return;
    if (blocksSinceRevalidate < revalidateEveryN) return;
    blocksSinceRevalidate = 0;
    if (!runtimeVersion) return; // Nothing to validate yet; fetchInner will discover.
    const probeHash = (await api.rpc.chain.getBlockHash(nextBlockNumber)).toHex() as Hex;
    const fresh = (await api.rpc.state.getRuntimeVersion(probeHash)) as unknown as CachedRuntimeVersion;
    if (
      runtimeVersion.specName.eq(fresh.specName) &&
      runtimeVersion.specVersion.eq(fresh.specVersion)
    ) {
      log.info("runtime revalidation ok", {
        nextBlock: nextBlockNumber,
        specVersion: fresh.specVersion.toNumber(),
      });
      return;
    }
    log.error("runtime revalidation mismatch — missed CodeUpdated; resetting cache", {
      nextBlock: nextBlockNumber,
      prev: `${runtimeVersion.specName.toString()}@${runtimeVersion.specVersion.toNumber()}`,
      fresh: `${fresh.specName.toString()}@${fresh.specVersion.toNumber()}`,
    });
    runtimeVersion = undefined;
  }

  async function processRange(from: number, to: number, label: "backfill" | "live"): Promise<void> {
    if (from > to) return;

    let batchFrom = from;
    while (batchFrom <= to) {
      // Pre-batch: if we've crossed the revalidation threshold, probe the
      // chain BEFORE fetching this batch so a missed runtime upgrade is
      // caught before any stale projection is committed.
      await maybeRevalidateBeforeBatch(batchFrom);

      const batchTo = Math.min(to, batchFrom + backfillFetchConcurrency - 1);
      const fetched = await Promise.all(
        Array.from({ length: batchTo - batchFrom + 1 }, async (_, i) => {
          const block = batchFrom + i;
          try {
            return { block, ctx: await fetchBlockContext(block) } as const;
          } catch (error) {
            return { block, error } as const;
          }
        }),
      );

      // Default: advance past this batch. Overridden below if a CodeUpdated
      // boundary is found inside the batch — successor results were decoded
      // against a now-stale registry and must be re-fetched.
      let nextBatchFrom = batchTo + 1;

      for (let i = 0; i < fetched.length; i++) {
        const result = fetched[i]!;
        if ("error" in result) {
          if (isPrunedBlockError(result.error)) {
            log.warn("skipping pruned block", { block: result.block });
            // Skipped blocks still advance the cursor to avoid infinite retry.
            await updateCursor(result.block);
            continue;
          }
          // Non-pruning error: bail without advancing so the next restart/head
          // retries from the first unprocessed block.
          throw result.error;
        }

        await applyBlockContext(result.ctx);
        await updateCursor(result.block);
        if (label === "backfill" && result.block % 50 === 0) {
          log.info("backfill progress", { at: result.block, to });
        }

        if (result.ctx.containsCodeUpdated) {
          // Drop remaining pre-fetched results in this batch — they were
          // decoded against the pre-upgrade registry. Reset the cache so the
          // next fetchBlockContext call rediscovers the post-upgrade runtime
          // at result.block + 1 via the slow path. Classify the dropped
          // tail by ok/error so we don't silently swallow a real fetch
          // failure that happened to land after the upgrade boundary.
          let droppedOk = 0;
          let droppedErr = 0;
          for (let j = i + 1; j < fetched.length; j++) {
            if ("error" in fetched[j]!) droppedErr += 1;
            else droppedOk += 1;
          }
          log.warn("CodeUpdated detected; draining batch", {
            at: result.block,
            droppedOk,
            droppedErr,
          });
          runtimeVersion = undefined;
          blocksSinceRevalidate = 0;
          nextBatchFrom = result.block + 1;
          break;
        }

        // Count applied blocks toward the next revalidation probe. Probe
        // itself runs pre-batch (see top of while loop), not post-apply,
        // so a missed upgrade is caught before stale blocks are written.
        blocksSinceRevalidate += 1;
      }

      batchFrom = nextBatchFrom;
    }
  }

  async function runLive(): Promise<void> {
    log.info("subscribing to finalized heads");
    unsubscribeFinalizedHeads = await api.rpc.chain.subscribeFinalizedHeads(async (header) => {
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
          log.error("block processing failed", { block: height, error: formatError(err) });
          fail(err);
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
    waitUntilStopped,
    async stop() {
      stopped = true;
      if (unsubscribeFinalizedHeads) {
        unsubscribeFinalizedHeads();
        unsubscribeFinalizedHeads = null;
      }
      await api.disconnect();
    },
  };
}
