// Registry handler. Projects ParticipantRegistered, ApplicationRegistered,
// and ApplicationUpdated from protocol_version=3 event payloads.
//
// No state refetch anywhere — the events carry all projectable fields.
// The kind=Registration announcement is still inserted from
// ApplicationRegistered because the contract emits no separate
// AnnouncementPosted on that path, but the event now carries the real
// announcement id + full payload so there is no local derivation.
import { sql } from "drizzle-orm";
import type { Db } from "../model/db.js";
import { schema } from "../model/db.js";
import type {
  ApplicationRegistered,
  ApplicationUpdated,
  ParticipantRegistered,
} from "../helpers/event-payloads.js";
import { asBigInt } from "../helpers/event-payloads.js";
import {
  bumpMetric,
  claimHandleOrThrow,
  isFirstTimeEvent,
  makeRowId,
  type HandlerContext,
} from "./common.js";

export async function handleParticipantRegistered(
  db: Db,
  _ctx: HandlerContext,
  payload: ParticipantRegistered,
): Promise<void> {
  const joinedAt = asBigInt(payload.joined_at);
  await claimHandleOrThrow(
    db,
    payload.handle,
    "Participant",
    payload.wallet,
    payload.season_id,
    joinedAt,
  );
  await db
    .insert(schema.participants)
    .values({
      id: payload.wallet,
      handle: payload.handle,
      github: payload.github,
      joinedAt,
      seasonId: payload.season_id,
      firstSeenSubstrateBlock: _ctx.block.substrateBlockNumber,
      firstSeenGearBlock: 0, // participants don't carry gear block in events
    })
    .onConflictDoUpdate({
      target: schema.participants.id,
      // Idempotent: re-running the same event overwrites with identical
      // values. If a second ParticipantRegistered fires for same wallet
      // (should be impossible per contract), we pick the latest.
      set: {
        handle: payload.handle,
        github: payload.github,
        joinedAt,
        seasonId: payload.season_id,
        firstSeenSubstrateBlock: _ctx.block.substrateBlockNumber,
      },
    });
}

export async function handleApplicationRegistered(
  db: Db,
  ctx: HandlerContext,
  payload: ApplicationRegistered,
): Promise<void> {
  const registeredAt = asBigInt(payload.registered_at);
  await claimHandleOrThrow(
    db,
    payload.handle,
    "Application",
    payload.program_id,
    payload.season_id,
    registeredAt,
  );
  await db
    .insert(schema.applications)
    .values({
      id: payload.program_id,
      handle: payload.handle,
      owner: payload.owner,
      description: payload.description,
      track: payload.track,
      githubUrl: payload.github_url,
      skillsHash: payload.skills_hash,
      skillsUrl: payload.skills_url,
      idlHash: payload.idl_hash,
      idlUrl: payload.idl_url,
      xAccount: payload.x_account ?? null,
      registeredAt,
      seasonId: payload.season_id,
      status: payload.status,
      tags: [],
    })
    .onConflictDoUpdate({
      target: schema.applications.id,
      set: {
        handle: payload.handle,
        owner: payload.owner,
        description: payload.description,
        track: payload.track,
        githubUrl: payload.github_url,
        skillsHash: payload.skills_hash,
        skillsUrl: payload.skills_url,
        idlHash: payload.idl_hash,
        idlUrl: payload.idl_url,
        xAccount: payload.x_account ?? null,
        registeredAt,
        seasonId: payload.season_id,
        status: payload.status,
      },
    });

  const registrationPostId = asBigInt(payload.registration_announcement_id);
  const announcementId = `${payload.program_id}:${registrationPostId}`;
  await db
    .insert(schema.announcements)
    .values({
      id: announcementId,
      applicationId: payload.program_id,
      postId: registrationPostId,
      title: payload.registration_announcement_title,
      body: payload.registration_announcement_body,
      tags: payload.registration_announcement_tags,
      kind: payload.registration_announcement_kind,
      postedAt: registeredAt,
      seasonId: payload.season_id,
      archived: false,
    })
    .onConflictDoNothing({ target: schema.announcements.id });

  if (!(await isFirstTimeEvent(db, `registry:app-registered:${makeRowId(ctx)}`))) return;
  await bumpMetric(db, payload.program_id, payload.season_id, "postsActive", registeredAt);
}

export async function handleApplicationUpdated(
  db: Db,
  _ctx: HandlerContext,
  payload: ApplicationUpdated,
): Promise<void> {
  // Build a partial update object from the applied patch. Only non-null arms
  // of the patch changed on-chain, so only those are written here.
  const patch = payload.patch;
  const updates: Record<string, unknown> = {};
  if (patch.description != null) updates.description = patch.description;
  if (patch.skills_hash != null) updates.skillsHash = patch.skills_hash;
  if (patch.skills_url != null) updates.skillsUrl = patch.skills_url;
  if (patch.idl_hash != null) updates.idlHash = patch.idl_hash;
  if (patch.idl_url != null) updates.idlUrl = patch.idl_url;
  // x_account is Option<Option<String>> — inner None (`undefined` here after
  // JSON decode) clears the field. Outer None (missing key) means unchanged.
  if ("x_account" in patch) {
    updates.xAccount = patch.x_account ?? null;
  }
  if (patch.status != null) updates.status = patch.status;

  if (Object.keys(updates).length === 0) return;

  await db
    .update(schema.applications)
    .set(updates)
    .where(sql`${schema.applications.id} = ${payload.program_id}`);
}
