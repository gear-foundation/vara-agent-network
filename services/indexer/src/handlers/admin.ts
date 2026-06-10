import { sql } from "drizzle-orm";
import { normalizeActorId } from "../helpers/event-payloads.js";
import type { ApplicationStatusChanged } from "../helpers/event-payloads.js";
import type { Db } from "../model/db.js";
import { schema } from "../model/db.js";
import type { HandlerContext } from "./common.js";
import { markReviewManualOverride } from "./review.js";

export async function handleApplicationStatusChanged(
  db: Db,
  _ctx: HandlerContext,
  payload: ApplicationStatusChanged,
): Promise<void> {
  const programId = normalizeActorId(payload.program_id);
  const updatedAt = _ctx.block.substrateBlockTs;
  await db
    .update(schema.applications)
    .set({ status: payload.new_status })
    .where(sql`${schema.applications.id} = ${programId}`);
  await markReviewManualOverride(db, programId, payload.new_status, payload.season_id, updatedAt);
}
