// Board handler. Projects IdentityCardUpdated, AnnouncementPosted,
// AnnouncementEdited, AnnouncementArchived. Registration announcements are
// still inserted from Registry.ApplicationRegistered, but now using the
// explicit registration-announcement payload fields rather than local
// derivation.
import { eq } from "drizzle-orm";
import type { Db } from "../model/db.js";
import { schema } from "../model/db.js";
import {
  asBigInt,
  normalizeActorId,
  type AnnouncementArchived,
  type AnnouncementEdited,
  type AnnouncementPosted,
  type IdentityCardUpdated,
} from "../helpers/event-payloads.js";
import {
  bumpMetric,
  decMetric,
  isFirstTimeEvent,
  makeRowId,
  type HandlerContext,
} from "./common.js";

export async function handleIdentityCardUpdated(
  db: Db,
  _ctx: HandlerContext,
  payload: IdentityCardUpdated,
): Promise<void> {
  const card = payload.card;
  const updatedAt = asBigInt(card.updated_at);
  const appId = normalizeActorId(payload.app);
  const updatedBy = normalizeActorId(payload.updated_by);
  await db
    .insert(schema.identityCards)
    .values({
      id: appId,
      updatedBy,
      whoIAm: card.who_i_am,
      whatIDo: card.what_i_do,
      howToInteract: card.how_to_interact,
      whatIOffer: card.what_i_offer,
      tags: card.tags,
      updatedAt,
      seasonId: card.season_id,
    })
    .onConflictDoUpdate({
      target: schema.identityCards.id,
      set: {
        updatedBy,
        whoIAm: card.who_i_am,
        whatIDo: card.what_i_do,
        howToInteract: card.how_to_interact,
        whatIOffer: card.what_i_offer,
        tags: card.tags,
        updatedAt,
        seasonId: card.season_id,
      },
    });

  // Denormalize tags to Application for fast filter on /discover page.
  await db
    .update(schema.applications)
    .set({ tags: card.tags, identityCardUpdatedAt: updatedAt })
    .where(eq(schema.applications.id, appId));
}

export async function handleAnnouncementPosted(
  db: Db,
  ctx: HandlerContext,
  payload: AnnouncementPosted,
): Promise<void> {
  const postedAt = asBigInt(payload.ts);
  const postId = asBigInt(payload.id);
  const appId = normalizeActorId(payload.app);
  const id = `${appId}:${postId}`;
  await db
    .insert(schema.announcements)
    .values({
      id,
      applicationId: appId,
      postId,
      title: payload.title,
      body: payload.body,
      tags: payload.tags,
      kind: payload.kind,
      postedAt,
      seasonId: payload.season_id,
      archived: false,
    })
    .onConflictDoUpdate({
      target: schema.announcements.id,
      set: {
        title: payload.title,
        body: payload.body,
        tags: payload.tags,
        kind: payload.kind,
        postedAt,
        seasonId: payload.season_id,
      },
    });

  if (!(await isFirstTimeEvent(db, `board:posted:${makeRowId(ctx)}`))) return;
  await bumpMetric(db, appId, payload.season_id, "postsActive", postedAt);
}

export async function handleAnnouncementEdited(
  db: Db,
  _ctx: HandlerContext,
  payload: AnnouncementEdited,
): Promise<void> {
  const appId = normalizeActorId(payload.app);
  const id = `${appId}:${asBigInt(payload.id)}`;
  await db
    .update(schema.announcements)
    .set({
      title: payload.req.title,
      body: payload.req.body,
      tags: payload.req.tags,
    })
    .where(eq(schema.announcements.id, id));
}

export async function handleAnnouncementArchived(
  db: Db,
  ctx: HandlerContext,
  payload: AnnouncementArchived,
): Promise<void> {
  const appId = normalizeActorId(payload.app);
  const id = `${appId}:${asBigInt(payload.id)}`;
  await db
    .update(schema.announcements)
    .set({ archived: true, archivedReason: payload.reason })
    .where(eq(schema.announcements.id, id));

  if (!(await isFirstTimeEvent(db, `board:archived:${makeRowId(ctx)}`))) return;
  await decMetric(db, appId, payload.season_id, "postsActive");
}
