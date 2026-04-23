// Chat handler. Projects MessagePosted → ChatMessage + per-mention ChatMention
// rows. Pure event→projection; no on-chain state reads.
//
// Cursor policy (Q5 resolution): msg_id is the primary cursor. Substrate +
// Gear block numbers are stored as metadata.
import { eq, sql } from "drizzle-orm";
import type { Db } from "../model/db.js";
import { schema } from "../model/db.js";
import {
  asBigInt,
  handleRefToString,
  type HandleRef,
  type MessagePosted,
} from "../helpers/event-payloads.js";
import type { HandlerContext } from "./common.js";
import { makeRowId } from "./common.js";

export async function handleMessagePosted(
  db: Db,
  ctx: HandlerContext,
  payload: MessagePosted,
): Promise<void> {
  const rowId = makeRowId(ctx);
  const authorRef = handleRefToString(payload.author);
  const authorHandle = await resolveHandle(db, payload.author);

  await db
    .insert(schema.chatMessages)
    .values({
      id: rowId,
      msgId: asBigInt(payload.id),
      programId: ctx.programId,
      authorRef,
      authorHandle,
      body: payload.body,
      mentionCount: payload.mentions.length,
      replyTo: payload.reply_to != null ? asBigInt(payload.reply_to) : null,
      ts: asBigInt(payload.ts),
      substrateBlockNumber: ctx.block.substrateBlockNumber,
      gearBlockNumber: 0, // event payload carries ts, not gear_block — leave 0 in v1
      substrateBlockTs: ctx.block.substrateBlockTs,
      extrinsicHash: null,
      seasonId: payload.season_id,
    })
    .onConflictDoNothing({ target: schema.chatMessages.id });

  for (let i = 0; i < payload.mentions.length; i++) {
    const m = payload.mentions[i]!;
    const recipientRef = handleRefToString(m);
    const recipientHandle = await resolveHandle(db, m);
    const registered = recipientHandle !== null;
    await db
      .insert(schema.chatMentions)
      .values({
        id: `${rowId}:${i}`,
        messageId: rowId,
        recipientRef,
        recipientHandle,
        recipientRegistered: registered,
        substrateBlockNumber: ctx.block.substrateBlockNumber,
        seasonId: payload.season_id,
      })
      .onConflictDoNothing({ target: schema.chatMentions.id });
  }

  // AppMetrics rollups (partial — unique-sender dedup is maintained here,
  // full metrics recompute happens in services/metrics-rollup.ts batch job).
  if ("application" in payload.author) {
    await bumpMessagesSent(db, payload.author.application, payload.season_id, ctx);
  }
  for (const m of payload.mentions) {
    if ("application" in m) {
      await bumpMentionCountAndSender(
        db,
        m.application,
        authorRef,
        payload.season_id,
        ctx,
      );
    }
  }
}

async function resolveHandle(db: Db, ref: HandleRef): Promise<string | null> {
  if ("participant" in ref) {
    const rows = await db
      .select({ handle: schema.participants.handle })
      .from(schema.participants)
      .where(eq(schema.participants.id, ref.participant))
      .limit(1);
    return rows[0]?.handle ?? null;
  }
  const rows = await db
    .select({ handle: schema.applications.handle })
    .from(schema.applications)
    .where(eq(schema.applications.id, ref.application))
    .limit(1);
  return rows[0]?.handle ?? null;
}

async function bumpMessagesSent(
  db: Db,
  appId: string,
  seasonId: number,
  ctx: HandlerContext,
): Promise<void> {
  const id = `${appId}:${seasonId}`;
  await db
    .insert(schema.appMetrics)
    .values({
      id,
      applicationId: appId,
      seasonId,
      messagesSent: 1,
      updatedAt: ctx.block.substrateBlockTs,
    })
    .onConflictDoUpdate({
      target: schema.appMetrics.id,
      set: {
        messagesSent: sql`${schema.appMetrics.messagesSent} + 1`,
        updatedAt: ctx.block.substrateBlockTs,
      },
    });
}

async function bumpMentionCountAndSender(
  db: Db,
  recipientAppId: string,
  senderRef: string,
  seasonId: number,
  ctx: HandlerContext,
): Promise<void> {
  const id = `${recipientAppId}:${seasonId}`;
  await db
    .insert(schema.appMetrics)
    .values({
      id,
      applicationId: recipientAppId,
      seasonId,
      mentionCount: 1,
      updatedAt: ctx.block.substrateBlockTs,
    })
    .onConflictDoUpdate({
      target: schema.appMetrics.id,
      set: {
        mentionCount: sql`${schema.appMetrics.mentionCount} + 1`,
        updatedAt: ctx.block.substrateBlockTs,
      },
    });

  // Unique sender dedup: only bump uniqueSendersToMe on first time we see
  // this (recipient, sender, season) triple.
  const recipientKey = `Application:${recipientAppId}`;
  const insertRes = await db
    .insert(schema.mentionSenderDedup)
    .values({
      recipientRef: recipientKey,
      senderRef,
      seasonId,
      firstSeenBlock: ctx.block.substrateBlockNumber,
    })
    .onConflictDoNothing()
    .returning({ recipientRef: schema.mentionSenderDedup.recipientRef });

  if (insertRes.length > 0) {
    await db
      .update(schema.appMetrics)
      .set({
        uniqueSendersToMe: sql`${schema.appMetrics.uniqueSendersToMe} + 1`,
      })
      .where(eq(schema.appMetrics.id, id));
  }
}
