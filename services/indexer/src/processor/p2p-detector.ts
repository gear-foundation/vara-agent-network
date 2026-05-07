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
import { decodeAddress } from "@polkadot/util-crypto";
import { u8aToHex } from "@polkadot/util";
import { log } from "../helpers/logger.js";
import type { Hex, ProgramMessageEvent } from "../helpers/types.js";

interface StoredMessageJSON {
  id?: unknown;
  source?: unknown;
  destination?: unknown;
  details?: { to?: unknown; code?: unknown } | null;
}

/**
 * Coerce a polkadot-js JSON value to a lowercase 0x-hex string. Accepts:
 *   - hex strings ("0x...")
 *   - SS58 strings (decoded to public key bytes)
 *   - Uint8Array / number[] (raw bytes hex-encoded)
 * Returns null on anything else so callers can drop the row.
 *
 * Mirrors the behaviour of `normalizeActorId` in processor.ts to keep ActorId
 * normalisation consistent with the event path. A separate copy because the
 * processor.ts version is a closure-local helper.
 */
function toLowerHex(v: unknown): Hex | null {
  if (typeof v === "string") {
    if (v.length === 0) return null;
    if (v.startsWith("0x")) return v.toLowerCase() as Hex;
    try {
      return u8aToHex(decodeAddress(v)).toLowerCase() as Hex;
    } catch {
      return null;
    }
  }
  if (v instanceof Uint8Array) {
    return u8aToHex(v).toLowerCase() as Hex;
  }
  if (Array.isArray(v) && v.every((b) => typeof b === "number")) {
    return u8aToHex(new Uint8Array(v as number[])).toLowerCase() as Hex;
  }
  return null;
}

/**
 * Read all `gearMessenger.dispatches` keys at a block hash and return a map
 * of message id → StoredMessage projection. Defensive against polkadot-js
 * JSON shape drift: a missing field returns null rather than throwing.
 */
async function dispatchesAt(
  api: ApiPromise,
  at: Hex,
): Promise<Map<Hex, StoredMessageJSON>> {
  const apiAt = await api.at(at);
  const out = new Map<Hex, StoredMessageJSON>();
  const entries = await apiAt.query.gearMessenger.dispatches.entries();
  for (const [, node] of entries) {
    const json = (node as unknown as { toJSON(): unknown }).toJSON();
    // LinkedNode shape: { next, value: StoredDispatch }; StoredDispatch:
    // { kind, message: StoredMessage, context: Option<...> }. We tolerate
    // either { value: { message } } or a flatter shape if metadata changes.
    const message = extractMessage(json);
    const id = toLowerHex(message?.id);
    if (id && message) out.set(id, message);
  }
  return out;
}

/**
 * Read all `gearMessenger.waitlist` keys at a block hash. Stored as a double
 * map keyed by `(programId, messageId) → (StoredDispatch, Interval)`. We
 * project the message id and inner StoredMessage with shape tolerance.
 */
async function waitlistAt(
  api: ApiPromise,
  at: Hex,
): Promise<Map<Hex, StoredMessageJSON>> {
  const apiAt = await api.at(at);
  const out = new Map<Hex, StoredMessageJSON>();
  const entries = await apiAt.query.gearMessenger.waitlist.entries();
  for (const [, val] of entries) {
    const json = (val as unknown as { toJSON(): unknown }).toJSON();
    // Tuple `(StoredDispatch, Interval)` typically arrives as a 2-element
    // array, but some metadata variants wrap as `{ 0, 1 }` or `[ a, b ]` of
    // typed objects. Probe both shapes for the StoredDispatch.
    const dispatch =
      (Array.isArray(json) ? json[0] : (json as { 0?: unknown } | null)?.[0]) ??
      json;
    const message = extractMessage(dispatch);
    const id = toLowerHex(message?.id);
    if (id && message) out.set(id, message);
  }
  return out;
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
 * Stateful detector. Holds the previous block's snapshots so live operation
 * does one set of `.entries()` reads per block instead of two — halves the
 * public-RPC load. Cold-start or cache miss falls back to dual reads.
 */
export class P2PDetector {
  private lastBlockHash: Hex | null = null;
  private lastDispatches: Map<Hex, StoredMessageJSON> = new Map();
  private lastWaitlist: Map<Hex, StoredMessageJSON> = new Map();
  private shapeWarned = false;

  /**
   * Returns ProgramMessage events for every dispatch / waitlist entry that
   * appeared at `blockHash` but not at `parentHash`. The caller decides
   * whether to swallow errors (best-effort overlay) or surface them.
   */
  async detect(input: DetectorInput): Promise<ProgramMessageEvent[]> {
    const { api, blockHash, parentHash, baseIndex } = input;

    let dispBefore: Map<Hex, StoredMessageJSON>;
    let waitBefore: Map<Hex, StoredMessageJSON>;

    if (this.lastBlockHash === parentHash) {
      // Fast path: previous block's snapshot is reusable.
      dispBefore = this.lastDispatches;
      waitBefore = this.lastWaitlist;
    } else {
      // Cold start, restart, or skipped block: re-read parent state.
      [dispBefore, waitBefore] = await Promise.all([
        dispatchesAt(api, parentHash),
        waitlistAt(api, parentHash),
      ]);
    }

    const [dispAfter, waitAfter] = await Promise.all([
      dispatchesAt(api, blockHash),
      waitlistAt(api, blockHash),
    ]);

    // Update cache for next call.
    this.lastBlockHash = blockHash;
    this.lastDispatches = dispAfter;
    this.lastWaitlist = waitAfter;

    const out = new Map<Hex, ProgramMessageEvent>();
    let cursor = baseIndex;

    const recordEdge = (
      id: Hex,
      m: StoredMessageJSON,
      detectedVia: ProgramMessageEvent["detectedVia"],
    ) => {
      const source = toLowerHex(m.source);
      const destination = toLowerHex(m.destination);
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
      const replyTo = toLowerHex(m.details?.to);
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

    for (const [id, m] of dispAfter) {
      // Cross-storage dedup: a dispatch already observed in the waitlist at
      // the parent block isn't a new edge. Same logical message moving
      // between storage layers stays a single emission across this run.
      if (dispBefore.has(id) || waitBefore.has(id)) continue;
      recordEdge(id, m, "dispatches_storage");
    }
    for (const [id, m] of waitAfter) {
      if (waitBefore.has(id) || dispBefore.has(id)) continue;
      recordEdge(id, m, "waitlist_storage");
    }

    if (out.size > 0) {
      log.debug("p2p detector: edges", {
        block: blockHash,
        count: out.size,
        cacheHit: this.lastBlockHash === blockHash,
      });
    }
    return Array.from(out.values());
  }

  /** Clear the cache (e.g. after a long gap that invalidates the previous snapshot). */
  reset(): void {
    this.lastBlockHash = null;
    this.lastDispatches = new Map();
    this.lastWaitlist = new Map();
  }
}
