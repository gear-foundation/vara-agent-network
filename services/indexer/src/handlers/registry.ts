// Registry handler. Projects ParticipantRegistered, ApplicationRegistered,
// ApplicationUpdated, and ApplicationSubmitted event payloads.
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
  ApplicationSubmitted,
  ApplicationUpdated,
  ParticipantRegistered,
} from "../helpers/event-payloads.js";
import { asBigInt, hashToHex, normalizeActorId } from "../helpers/event-payloads.js";
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
  const wallet = normalizeActorId(payload.wallet);
  await claimHandleOrThrow(
    db,
    payload.handle,
    "Participant",
    wallet,
    payload.season_id,
    joinedAt,
  );
  await db
    .insert(schema.participants)
    .values({
      id: wallet,
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
  const programId = normalizeActorId(payload.program_id);
  const owner = normalizeActorId(payload.owner);
  await claimHandleOrThrow(
    db,
    payload.handle,
    "Application",
    programId,
    payload.season_id,
    registeredAt,
  );
  const skillsHash = hashToHex(payload.skills_hash);
  const idlHash = hashToHex(payload.idl_hash);
  await db
    .insert(schema.applications)
    .values({
      id: programId,
      handle: payload.handle,
      owner,
      description: payload.description,
      track: payload.track,
      githubUrl: payload.github_url,
      skillsHash,
      skillsUrl: payload.skills_url,
      idlHash,
      idlUrl: payload.idl_url,
      discordAccount: payload.contacts?.discord ?? null,
      telegramAccount: payload.contacts?.telegram ?? null,
      xAccount: payload.contacts?.x ?? null,
      registeredAt,
      seasonId: payload.season_id,
      status: payload.status,
      tags: [],
    })
    .onConflictDoUpdate({
      target: schema.applications.id,
      set: {
        handle: payload.handle,
        owner,
        description: payload.description,
        track: payload.track,
        githubUrl: payload.github_url,
        skillsHash,
        skillsUrl: payload.skills_url,
        idlHash,
        idlUrl: payload.idl_url,
        discordAccount: payload.contacts?.discord ?? null,
        telegramAccount: payload.contacts?.telegram ?? null,
        xAccount: payload.contacts?.x ?? null,
        registeredAt,
        seasonId: payload.season_id,
        status: payload.status,
      },
    });

  const registrationPostId = asBigInt(payload.registration_announcement_id);
  const announcementId = `${programId}:${registrationPostId}`;
  await db
    .insert(schema.announcements)
    .values({
      id: announcementId,
      applicationId: programId,
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
  await bumpMetric(db, programId, payload.season_id, "postsActive", registeredAt);
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
  if (patch.skills_url != null) updates.skillsUrl = patch.skills_url;
  if (patch.idl_url != null) updates.idlUrl = patch.idl_url;

  // contacts is Option<Option<ContactLinks>>. Some decoders omit outer None,
  // others may materialize it as `null`, so only treat `null` as an explicit
  // clear when contacts is the only applied field in this patch.
  if (patch.contacts != null) {
    updates.discordAccount = patch.contacts?.discord ?? null;
    updates.telegramAccount = patch.contacts?.telegram ?? null;
    updates.xAccount = patch.contacts?.x ?? null;
  } else if (
    Object.prototype.hasOwnProperty.call(patch, "contacts") &&
    Object.keys(updates).length === 0
  ) {
    updates.discordAccount = null;
    updates.telegramAccount = null;
    updates.xAccount = null;
  }

  const programId = normalizeActorId(payload.program_id);
  if (Object.keys(updates).length === 0) return;

  await db
    .update(schema.applications)
    .set(updates)
    .where(sql`${schema.applications.id} = ${programId}`);
}

export async function handleApplicationSubmitted(
  db: Db,
  _ctx: HandlerContext,
  payload: ApplicationSubmitted,
): Promise<void> {
  const programId = normalizeActorId(payload.program_id);
  await db
    .update(schema.applications)
    .set({ status: "Submitted" })
    .where(sql`${schema.applications.id} = ${programId}`);
}
