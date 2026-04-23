// Shared types and helpers across handlers.
import type { Db } from "../model/db.js";
import { schema } from "../model/db.js";
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

/**
 * Event-level idempotency gate. Handlers that mutate rolling counters (metric
 * bumps, dedup tables) call this FIRST. Returns `true` when this is the first
 * time we've seen the given key, `false` on replay/concurrent-duplicate.
 *
 * Handlers that only do `INSERT ... ON CONFLICT DO NOTHING/UPDATE` on
 * deterministic-id rows can skip this — those are already idempotent.
 *
 * Key convention: `${service_event}:${deterministic_row_id}` so bumps from
 * different event kinds keyed on the same row id don't collide.
 */
export async function isFirstTimeEvent(db: Db, key: string): Promise<boolean> {
  const rows = await db
    .insert(schema.eventProcessed)
    .values({ key, processedAt: BigInt(Date.now()) })
    .onConflictDoNothing()
    .returning({ key: schema.eventProcessed.key });
  return rows.length > 0;
}
