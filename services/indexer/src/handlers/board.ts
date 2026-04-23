// Board handler. Projects IdentityCardUpdated, AnnouncementPosted (kind=Invitation
// only; Registration comes from Registry.ApplicationRegistered auto-announce),
// AnnouncementEdited, AnnouncementArchived. All payloads carry full content
// under v1.1 — no state refetch.
import { eq, sql } from "drizzle-orm";
import type { Db } from "../model/db.js";
import { schema } from "../model/db.js";
import {
  asBigInt,
  type AnnouncementArchived,
  type AnnouncementEdited,
  type AnnouncementPosted,
  type IdentityCardUpdated,
} from "../helpers/event-payloads.js";
import type { HandlerContext } from "./common.js";

export async function handleIdentityCardUpdated(
  db: Db,
  _ctx: HandlerContext,
  payload: IdentityCardUpdated,
): Promise<void> {
  const card = payload.card;
  const updatedAt = asBigInt(card.updated_at);
  await db
    .insert(schema.identityCards)
    .values({
      id: payload.app,
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
    .where(eq(schema.applications.id, payload.app));
}

export async function handleAnnouncementPosted(
  db: Db,
  _ctx: HandlerContext,
  payload: AnnouncementPosted,
): Promise<void> {
  const postedAt = asBigInt(payload.ts);
  const postId = asBigInt(payload.id);
  const id = `${payload.app}:${postId}`;
  await db
    .insert(schema.announcements)
    .values({
      id,
      applicationId: payload.app,
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
      // Idempotent rewrite on replay — body/tags/title might have been edited
      // later but the Posted event is the authoritative initial state.
      set: {
        title: payload.title,
        body: payload.body,
        tags: payload.tags,
        kind: payload.kind,
        postedAt,
        seasonId: payload.season_id,
      },
    });

  // postsActive metric bump.
  const metricsId = `${payload.app}:${payload.season_id}`;
  await db
    .insert(schema.appMetrics)
    .values({
      id: metricsId,
      applicationId: payload.app,
      seasonId: payload.season_id,
      postsActive: 1,
      updatedAt: postedAt,
    })
    .onConflictDoUpdate({
      target: schema.appMetrics.id,
      set: {
        postsActive: sql`${schema.appMetrics.postsActive} + 1`,
        updatedAt: postedAt,
      },
    });
}

export async function handleAnnouncementEdited(
  db: Db,
  _ctx: HandlerContext,
  payload: AnnouncementEdited,
): Promise<void> {
  const id = `${payload.app}:${asBigInt(payload.id)}`;
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
  _ctx: HandlerContext,
  payload: AnnouncementArchived,
): Promise<void> {
  const id = `${payload.app}:${asBigInt(payload.id)}`;
  await db
    .update(schema.announcements)
    .set({ archived: true, archivedReason: payload.reason })
    .where(eq(schema.announcements.id, id));

  // postsActive metric decrement.
  const metricsId = `${payload.app}:${payload.season_id}`;
  await db
    .update(schema.appMetrics)
    .set({
      postsActive: sql`GREATEST(${schema.appMetrics.postsActive} - 1, 0)`,
    })
    .where(eq(schema.appMetrics.id, metricsId));
}
