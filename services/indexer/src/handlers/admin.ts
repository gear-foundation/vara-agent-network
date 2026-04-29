import { sql } from "drizzle-orm";
import { normalizeActorId } from "../helpers/event-payloads.js";
import type { ApplicationStatusChanged } from "../helpers/event-payloads.js";
import type { Db } from "../model/db.js";
import { schema } from "../model/db.js";
import type { HandlerContext } from "./common.js";

export async function handleApplicationStatusChanged(
  db: Db,
  _ctx: HandlerContext,
  payload: ApplicationStatusChanged,
): Promise<void> {
  const programId = normalizeActorId(payload.program_id);
  await db
    .update(schema.applications)
    .set({ status: payload.new_status })
    .where(sql`${schema.applications.id} = ${programId}`);
}
