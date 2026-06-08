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
  ApplicationDeleted,
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
import { initializeReviewSummary, tombstoneReviewRows } from "./review.js";

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
  await initializeReviewSummary(db, programId, payload.season_id, registeredAt);

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
  const programId = normalizeActorId(payload.program_id);
  const app = payload.application;
  const owner = normalizeActorId(app.owner);
  const registeredAt = asBigInt(app.registered_at);
  const updates = {
    handle: app.handle,
    owner,
    description: app.description,
    track: app.track,
    githubUrl: app.github_url,
    skillsHash: hashToHex(app.skills_hash),
    skillsUrl: app.skills_url,
    idlHash: hashToHex(app.idl_hash),
    idlUrl: app.idl_url,
    discordAccount: app.contacts?.discord ?? null,
    telegramAccount: app.contacts?.telegram ?? null,
    xAccount: app.contacts?.x ?? null,
    registeredAt,
    seasonId: app.season_id,
    status: app.status,
  };

  await db.transaction(async (tx) => {
    await tx
      .delete(schema.handleClaims)
      .where(sql`${schema.handleClaims.ownerKind} = 'Application'
        AND ${schema.handleClaims.ownerId} = ${programId}`);
    const inserted = await tx
      .insert(schema.handleClaims)
      .values({
        handle: app.handle,
        ownerKind: "Application",
        ownerId: programId,
        seasonId: app.season_id,
        claimedAt: _ctx.block.substrateBlockTs,
      })
      .onConflictDoNothing()
      .returning({ handle: schema.handleClaims.handle });
    if (inserted.length === 0) {
      throw new Error(`global handle namespace violation for ${app.handle}`);
    }
    await tx
      .update(schema.applications)
      .set(updates)
      .where(sql`${schema.applications.id} = ${programId}`);
  });
}

export async function handleApplicationDeleted(
  db: Db,
  _ctx: HandlerContext,
  payload: ApplicationDeleted,
): Promise<void> {
  const programId = normalizeActorId(payload.program_id);
  const deletedAt = asBigInt(payload.deleted_at);
  await db.transaction(async (tx) => {
    await tx
      .delete(schema.handleClaims)
      .where(sql`${schema.handleClaims.ownerKind} = 'Application'
        AND ${schema.handleClaims.ownerId} = ${programId}`);
    await tx
      .delete(schema.identityCards)
      .where(sql`${schema.identityCards.id} = ${programId}`);
    await tx
      .delete(schema.announcements)
      .where(sql`${schema.announcements.applicationId} = ${programId}`);
    await tx
      .delete(schema.appMetrics)
      .where(sql`${schema.appMetrics.applicationId} = ${programId}`);
    await tx
      .delete(schema.applications)
      .where(sql`${schema.applications.id} = ${programId}`);
  });
  await tombstoneReviewRows(db, programId, deletedAt);
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
