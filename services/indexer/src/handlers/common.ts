// Shared types and helpers across handlers.
import type { BlockContext, UserMessageSentEvent } from "../helpers/types.js";

export interface HandlerContext {
  block: BlockContext;
  event: UserMessageSentEvent;
  /** Monotonic extrinsic position within the block if available. */
  extrinsicIdx: number;
  /** Event index within block. */
  eventIdx: number;
  /** Program id this event came from — same value across all handlers, cached
   *  from BlockContext filter. */
  programId: string;
}

/** Deterministic id for append-only rows. */
export function makeRowId(ctx: HandlerContext): string {
  return `${ctx.programId}:${ctx.block.substrateBlockNumber}:${ctx.extrinsicIdx}:${ctx.eventIdx}`;
}
