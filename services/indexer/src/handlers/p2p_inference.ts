// Event-only inference handlers for intra-block P2P participation.
//
// On a public Vara RPC, `state_traceBlock` is rejected as unsafe, so per-edge
// fidelity for chains that complete inside one `run()` call is impossible.
// The cross-block storage-diff detector in `processor/p2p-detector.ts`
// captures everything that crosses a block boundary; this module covers what
// it can't see, using only events the runtime emits today.
//
// Strategy A (handleParticipationInference) — once per (program, season,
// block): bump `p2p_active_blocks` when the program is in
// `MessagesDispatched.state_changes` AND no wallet `MessageQueued` in the
// same block targeted it AND no cross-block `ProgramMessage` event in the
// same block touched it. Filtered by both axes so the metric is strictly
// intra-block-only, orthogonal to the existing `p2p_calls_in`.
//
// Strategy C (handleUserMessageSentBacktrack) — once per replying message
// id: when an indexed app emits `UserMessageSent` with
// `details.to = M` and `M` is not in this block's `MessageQueued` set, the
// chain involved a hidden P2P intermediate. Bumps `p2p_replies_origin` on
// the responder.
//
// Replay-safe: both handlers gate via `isFirstTimeEvent` (event_processed
// table) so re-processing the same block is a no-op.
//
// Coverage caveats are documented in the migration and the README. Strategy
// A's purpose is participation-only — it cannot identify edges. Strategy C
// is a lower bound that overcounts cross-block wallet replies (wait_for
// patterns) and undercounts same-block round-trips.
//
// Failure policy: handler errors PROPAGATE to the processor, which bails
// without advancing the cursor (existing handler-error convention). Replay
// on the next finalized-head tick is gated idempotently by isFirstTimeEvent
// keys.

import { config } from "../config.js";
import type { Db } from "../model/db.js";
import type {
  BlockContext,
  Hex,
  MessagesDispatchedEvent,
  UserMessageSentEvent,
} from "../helpers/types.js";
import { bumpMetric, isFirstTimeEvent, resolveActor } from "./common.js";

/**
 * Strategy A. Caller is responsible for passing:
 *   - `knownMQDestinations`: set of `MessageQueued.destination` from this
 *     block's events (programs the wallet axis already accounts for).
 *   - `programsWithCrossBlockEdge`: set of `ProgramMessage.source` ∪ `.destination`
 *     from this block's events (programs the cross-block storage-diff
 *     detector already accounts for).
 *
 * The two exclusion sets together produce a clean intra-block-only signal.
 */
export async function handleParticipationInference(
  db: Db,
  block: BlockContext,
  dispatched: MessagesDispatchedEvent,
  knownMQDestinations: Set<string>,
  programsWithCrossBlockEdge: Set<string>,
): Promise<void> {
  if (dispatched.stateChanges.length === 0) return;

  const ts = block.substrateBlockTs;

  for (const program of dispatched.stateChanges) {
    if (knownMQDestinations.has(program)) continue;
    if (programsWithCrossBlockEdge.has(program)) continue;

    // Only registered Applications carry an app_metrics row. Unregistered
    // programs in state_changes (e.g. core builtin actors) are silently
    // skipped — there's nothing on the leaderboard to bump for them.
    const actor = await resolveActor(db, program);
    if (!actor.isApplication || !actor.application) continue;

    const seasonId = actor.application.seasonId ?? config.seasonId;
    const gateKey = `p2p_active:${program}:${seasonId}:${block.substrateBlockNumber}`;
    if (!(await isFirstTimeEvent(db, gateKey))) continue;

    await bumpMetric(db, program, seasonId, "p2pActiveBlocks", ts);
  }
}

/**
 * Strategy C. Caller passes `knownMessageIdsThisBlock` — the set of
 * `MessageQueued.messageId` from this block's events. The handler bumps
 * `p2pRepliesOrigin` on the responder when the reply targets a message id
 * NOT in that set.
 */
export async function handleUserMessageSentBacktrack(
  db: Db,
  block: BlockContext,
  event: UserMessageSentEvent,
  knownMessageIdsThisBlock: Set<string>,
): Promise<void> {
  if (!event.hasReplyDetails) return;
  const replyTo = event.replyToMessageId;
  if (!replyTo) return;
  // Reply targets a wallet MQ from this block ⇒ chain is fully observable
  // through the wallet axis, no hidden P2P intermediate.
  if (knownMessageIdsThisBlock.has(replyTo)) return;

  const actor = await resolveActor(db, event.source);
  if (!actor.isApplication || !actor.application) return;

  // Replay gate: one bump per replying messageId. Sufficient because the
  // (responder, replyTo) pair is uniquely identified by the message itself.
  if (!(await isFirstTimeEvent(db, `p2p:backtrack:${event.messageId}`))) return;

  await bumpMetric(
    db,
    event.source,
    actor.application.seasonId ?? config.seasonId,
    "p2pRepliesOrigin",
    block.substrateBlockTs,
  );
}

export interface BlockSets {
  /** `MessageQueued.destination` from this block (wallet-axis programs). */
  knownMQDestinations: Set<Hex>;
  /** `MessageQueued.messageId` from this block (wallet-originated msg ids). */
  knownMessageIds: Set<Hex>;
  /** Programs touched by any cross-block `ProgramMessage` event. */
  programsWithCrossBlockEdge: Set<Hex>;
}

/**
 * Single pass over `ctx.events` that builds the three block-scoped sets the
 * P2P inference handlers need. Replaces three separate iterations.
 */
export function buildBlockSets(events: BlockContext["events"]): BlockSets {
  const knownMQDestinations = new Set<Hex>();
  const knownMessageIds = new Set<Hex>();
  const programsWithCrossBlockEdge = new Set<Hex>();
  for (const e of events) {
    if (e.kind === "MessageQueued") {
      knownMQDestinations.add(e.destination);
      knownMessageIds.add(e.messageId);
    } else if (e.kind === "ProgramMessage") {
      programsWithCrossBlockEdge.add(e.source);
      programsWithCrossBlockEdge.add(e.destination);
    }
  }
  return { knownMQDestinations, knownMessageIds, programsWithCrossBlockEdge };
}

// Single-purpose builders kept as a stable test API so the contract of each
// set can be asserted independently. Production callers should use
// `buildBlockSets` to avoid three separate iterations of `ctx.events`.
export function buildKnownMQDestinations(events: BlockContext["events"]): Set<Hex> {
  return buildBlockSets(events).knownMQDestinations;
}

export function buildKnownMessageIds(events: BlockContext["events"]): Set<Hex> {
  return buildBlockSets(events).knownMessageIds;
}

export function buildProgramsWithCrossBlockEdge(events: BlockContext["events"]): Set<Hex> {
  return buildBlockSets(events).programsWithCrossBlockEdge;
}
