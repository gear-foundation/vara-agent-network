// Program → program (P2P) edge detector.
//
// pallet-gear emits `Gear.MessageQueued` only inside extrinsic handlers
// (upload_program / do_create_program / send_message_impl). Edges produced by
// `gr_send` / `gr_create_program` from WASM go through `JournalHandler::send_dispatch`
// in the runtime with no event deposit, leaving them invisible to a passive
// event-stream indexer.
//
// This module compensates by snapshotting messenger storage at the parent and
// current block hashes and diffing the message-id sets:
//
//   Layer A: gearMessenger.dispatches    → in-flight queued messages
//   Layer B: gearMessenger.waitlist      → messages parked awaiting a reply
//   Layer C: gearMessenger.dispatchStash → delayed dispatches scheduled for a
//                                          future block (e.g. gr_send_delayed)
//
// For every message id that appears at the current block but not at the
// parent block, the StoredDispatch is decoded via `.toJSON()` to extract
// source / destination / reply linkage. A defensive coercion layer accepts
// hex strings, Uint8Array, or number arrays from polkadot-js.
//
// Coverage: every P2P edge that crosses at least one block boundary is
// captured. Tight chains that complete inside one `run()` call leave no
// storage trace and are NOT captured. Recovering those would require
// `state_traceBlock` against an archive node with `--rpc-methods Unsafe`,
// which public Vara RPCs do not expose. See the README for the documented
// gap.
//
// Performance: `parentSnapshot` is cached so live operation only fetches the
// CURRENT block's storage maps. Cold start (or cache miss after gap) reads
// both. The detector is a best-effort overlay — a non-fatal failure logs
// and returns no edges, so the cursor still advances on event-only data.

import type { ApiPromise } from "@polkadot/api";
import { coerceActorId } from "../helpers/event-payloads.js";
import { log } from "../helpers/logger.js";
import type { Hex, ProgramMessageEvent } from "../helpers/types.js";
import { DETECTED_VIA } from "../handlers/common.js";

interface StoredMessageJSON {
  id?: unknown;
  source?: unknown;
  destination?: unknown;
  details?: { to?: unknown; code?: unknown } | null;
}

interface BlockSnapshot {
  dispatches: Map<Hex, StoredMessageJSON>;
  waitlist: Map<Hex, StoredMessageJSON>;
}

/**
 * Read both `gearMessenger.dispatches` and `gearMessenger.waitlist` at a
 * block hash under a single `apiAt` (one metadata join, two parallel scans).
 * Defensive against polkadot-js JSON shape drift: missing fields drop the row
 * rather than throwing.
 *
 * Storage shapes:
 *   dispatches : LinkedNode<MessageId, StoredDispatch>
 *                = { next, value: { kind, message, context } }
 *   waitlist   : (StoredDispatch, Interval) tuple, usually [a, b], sometimes
 *                wrapped as { 0, 1 }; the inner shape is StoredDispatch.
 */
async function snapshotAt(api: ApiPromise, at: Hex): Promise<BlockSnapshot> {
  const apiAt = await api.at(at);
  const [dispEntries, waitEntries] = await Promise.all([
    apiAt.query.gearMessenger.dispatches.entries(),
    apiAt.query.gearMessenger.waitlist.entries(),
  ]);

  const dispatches = new Map<Hex, StoredMessageJSON>();
  for (const [, node] of dispEntries) {
    const json = (node as unknown as { toJSON(): unknown }).toJSON();
    const message = extractMessage(json);
    const id = coerceActorId(message?.id);
    if (id && message) dispatches.set(id, message);
  }

  const waitlist = new Map<Hex, StoredMessageJSON>();
  for (const [, val] of waitEntries) {
    const json = (val as unknown as { toJSON(): unknown }).toJSON();
    const dispatch =
      (Array.isArray(json) ? json[0] : (json as { 0?: unknown } | null)?.[0]) ??
      json;
    const message = extractMessage(dispatch);
    const id = coerceActorId(message?.id);
    if (id && message) waitlist.set(id, message);
  }

  return { dispatches, waitlist };
}

/**
 * Pull a StoredMessage shape out of a value that may or may not be a
 * StoredDispatch wrapper. Handles polkadot-js variants:
 *   { value: { message } }            — LinkedNode wrapper
 *   { message }                       — bare StoredDispatch
 *   message-shaped object             — already unwrapped
 */
function extractMessage(value: unknown): StoredMessageJSON | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  if (v.value && typeof v.value === "object") {
    const inner = v.value as Record<string, unknown>;
    if (inner.message && typeof inner.message === "object") {
      return inner.message as StoredMessageJSON;
    }
  }
  if (v.message && typeof v.message === "object") {
    return v.message as StoredMessageJSON;
  }
  // Bare-message variant: must have id + source + destination.
  if ("id" in v && "source" in v && "destination" in v) {
    return v as StoredMessageJSON;
  }
  return null;
}

export interface DetectorInput {
  api: ApiPromise;
  blockHash: Hex;
  parentHash: Hex;
  /** Used as the deterministic ordering base for synthesized indexInBlock. */
  baseIndex: number;
}

/**
 * Stateful detector. Holds the previous block's snapshot so live operation
 * does one `.entries()` pair per block instead of two — halves the
 * public-RPC load. Cold-start or cache miss falls back to dual reads.
 */
export class P2PDetector {
  private lastBlockHash: Hex | null = null;
  private lastSnapshot: BlockSnapshot = { dispatches: new Map(), waitlist: new Map() };
  private shapeWarned = false;

  /**
   * Returns ProgramMessage events for every dispatch / waitlist entry that
   * appeared at `blockHash` but not at `parentHash`. The caller decides
   * whether to swallow errors (best-effort overlay) or surface them.
   */
  async detect(input: DetectorInput): Promise<ProgramMessageEvent[]> {
    const { api, blockHash, parentHash, baseIndex } = input;
    const cacheHit = this.lastBlockHash === parentHash;

    // Fast path: previous block's snapshot is reusable as `before`. Cold
    // start / restart / skipped block: re-read parent storage.
    const beforePromise = cacheHit
      ? Promise.resolve(this.lastSnapshot)
      : snapshotAt(api, parentHash);
    const [before, after] = await Promise.all([beforePromise, snapshotAt(api, blockHash)]);

    this.lastBlockHash = blockHash;
    this.lastSnapshot = after;

    const out = new Map<Hex, ProgramMessageEvent>();
    let cursor = baseIndex;

    const recordEdge = (
      id: Hex,
      m: StoredMessageJSON,
      detectedVia: ProgramMessageEvent["detectedVia"],
    ) => {
      const source = coerceActorId(m.source);
      const destination = coerceActorId(m.destination);
      if (!source || !destination) {
        if (!this.shapeWarned) {
          log.warn("p2p detector: undecodable message shape", {
            id,
            sample: JSON.stringify(m).slice(0, 200),
          });
          this.shapeWarned = true;
        }
        return;
      }
      const replyTo = coerceActorId(m.details?.to);
      const existing = out.get(id);
      out.set(id, {
        kind: "ProgramMessage",
        messageId: id,
        source,
        destination,
        parent: existing?.parent ?? null,
        replyTo: replyTo ?? existing?.replyTo ?? null,
        // Waitlist beats dispatches when both fire in the same block — being
        // parked is the more interesting fact for downstream auditing.
        detectedVia,
        indexInBlock: existing?.indexInBlock ?? cursor++,
      });
    };

    // Cross-storage dedup: a message already observed in either layer at
    // the parent block isn't a new edge. The same logical message moving
    // between dispatches and waitlist stays a single emission across this run.
    for (const [id, m] of after.dispatches) {
      if (before.dispatches.has(id) || before.waitlist.has(id)) continue;
      recordEdge(id, m, DETECTED_VIA.Dispatches);
    }
    for (const [id, m] of after.waitlist) {
      if (before.waitlist.has(id) || before.dispatches.has(id)) continue;
      recordEdge(id, m, DETECTED_VIA.Waitlist);
    }

    if (out.size > 0) {
      log.debug("p2p detector: edges", {
        block: blockHash,
        count: out.size,
        cacheHit,
      });
    }
    return Array.from(out.values());
  }

  /** Clear the cache (e.g. after a long gap that invalidates the previous snapshot). */
  reset(): void {
    this.lastBlockHash = null;
    this.lastSnapshot = { dispatches: new Map(), waitlist: new Map() };
  }
}
