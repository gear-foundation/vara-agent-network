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

export type GearEvent = UserMessageSentEvent | MessageQueuedEvent | ProgramMessageEvent;

/** Context for a single block processed end-to-end. */
export interface BlockContext {
  substrateBlockNumber: number;
  substrateBlockHash: Hex;
  substrateBlockTs: bigint; // ms
  events: GearEvent[];
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

/** Only UserMessageSent events with no reply details are Sails service events. */
export function isSailsEvent(e: UserMessageSentEvent): boolean {
  return !e.hasReplyDetails;
}

export interface DecodedEvent<T = unknown> {
  service: string;
  event: string;
  payload: T;
}
