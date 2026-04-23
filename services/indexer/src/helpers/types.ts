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

export type GearEvent = UserMessageSentEvent | MessageQueuedEvent;

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

/** Only UserMessageSent events with no reply details are Sails service events. */
export function isSailsEvent(e: UserMessageSentEvent): boolean {
  return !e.hasReplyDetails;
}

export interface DecodedEvent<T = unknown> {
  service: string;
  event: string;
  payload: T;
}
