// Neutral block + event shapes passed between the chain adapter (processor.ts)
// and the projection handlers. Handlers must not depend on @polkadot/api types
// — keeps the adapter swappable (e.g. add Subsquid archive fast-path later).

export type Hex = `0x${string}`;

export interface UserMessageSentEvent {
  kind: "UserMessageSent";
  /** message id from Gear */
  messageId: Hex;
  source: Hex;
  destination: Hex;
  payload: Hex;
  value: string; // decimal string
  /** Reply details are non-null for message replies; Sails service events have null. */
  hasReplyDetails: boolean;
  /**
   * When `hasReplyDetails` is true, the message id this is replying to
   * (`details.to`). Lowercase 0x hex. Null otherwise. Consumed by Strategy C
   * (UserMessageSent backtrack) in `handlers/p2p_inference.ts`.
   *
   * Optional in the type; processor.ts populates it. Older callers that
   * constructed UserMessageSentEvent before the backtrack feature land on
   * `undefined`, which the handler treats as "no reply linkage available".
   */
  replyToMessageId?: Hex | null;
  indexInBlock: number;
}

export interface MessageQueuedEvent {
  kind: "MessageQueued";
  messageId: Hex;
  source: Hex;
  destination: Hex;
  indexInBlock: number;
}

/**
 * Synthetic event emitted by the P2P detector for program → program edges
 * that are invisible at the event layer (pallet-gear does not deposit
 * `MessageQueued` for `gr_send` / `gr_create_program` from WASM). Built by
 * snapshot-diffing `gearMessenger.dispatches` and `gearMessenger.waitlist`
 * between consecutive finalized blocks. See `processor/p2p-detector.ts`.
 */
export interface ProgramMessageEvent {
  kind: "ProgramMessage";
  messageId: Hex;
  source: Hex;
  destination: Hex;
  /** Originating user message id when known, else null. */
  parent: Hex | null;
  /** When this message is a reply, the message it answers. */
  replyTo: Hex | null;
  detectedVia: "dispatches_storage" | "waitlist_storage";
  indexInBlock: number;
}

/**
 * Synthesized once per block from `Gear.MessagesDispatched`. Surfaces the
 * runtime-emitted summary of which programs' state changed during this
 * block's `run()` and how many dispatches were processed in total.
 *
 * Consumed by Strategy A (participation inference) in `handlers/p2p_inference.ts`
 * to detect intra-block-only P2P participation: a program in `stateChanges`
 * with no `MessageQueued` targeting it AND no cross-block `ProgramMessage`
 * touching it must have been hit by a `gr_send` that completed in the same
 * `run()` call. The runtime emits no per-edge event for such sends, so
 * `state_changes` is the only public-RPC signal that they happened.
 */
export interface MessagesDispatchedEvent {
  kind: "MessagesDispatched";
  total: number;
  stateChanges: Hex[];
  indexInBlock: number;
}

export type GearEvent =
  | UserMessageSentEvent
  | MessageQueuedEvent
  | ProgramMessageEvent
  | MessagesDispatchedEvent;

/** Context for a single block processed end-to-end. */
export interface BlockContext {
  substrateBlockNumber: number;
  substrateBlockHash: Hex;
  substrateBlockTs: bigint; // ms
  events: GearEvent[];
  /**
   * True when the block is being processed close enough to the chain head
   * that the storage-diff P2P detector ran. False during backfill when
   * parent state is pruned. Pass 4 (event-only inference) gates on this so
   * Strategy A's exclusion set is consistent with what the detector saw.
   * Optional for backwards compat with older callers / fixtures; absent
   * is treated as live.
   */
  inLiveWindow?: boolean;
}

export function isUserMessageSent(e: GearEvent): e is UserMessageSentEvent {
  return e.kind === "UserMessageSent";
}

export function isMessageQueued(e: GearEvent): e is MessageQueuedEvent {
  return e.kind === "MessageQueued";
}

export function isProgramMessage(e: GearEvent): e is ProgramMessageEvent {
  return e.kind === "ProgramMessage";
}

export function isMessagesDispatched(e: GearEvent): e is MessagesDispatchedEvent {
  return e.kind === "MessagesDispatched";
}

/** Only UserMessageSent events with no reply details are Sails service events. */
export function isSailsEvent(e: UserMessageSentEvent): boolean {
  return !e.hasReplyDetails;
}

export interface DecodedEvent<T = unknown> {
  service: string;
  event: string;
  payload: T;
}
