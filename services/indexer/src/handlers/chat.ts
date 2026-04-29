// Chat handler. Projects MessagePosted → ChatMessage + per-mention ChatMention
// rows. Pure event→projection; no on-chain state reads.
//
// Cursor policy: msg_id is the primary cursor. Substrate + Gear block numbers
// are stored as metadata.
import { eq, sql } from "drizzle-orm";
import type { Db } from "../model/db.js";
import { schema } from "../model/db.js";
import {
  asBigInt,
  handleRefToString,
  normalizeActorId,
  type MessagePosted,
} from "../helpers/event-payloads.js";
import {
  bumpMetric,
  isFirstTimeEvent,
  makeRowId,
  resolveHandleRef,
  type HandlerContext,
} from "./common.js";

export async function handleMessagePosted(
  db: Db,
  ctx: HandlerContext,
  payload: MessagePosted,
): Promise<void> {
  const rowId = makeRowId(ctx);
  const authorRef = handleRefToString(payload.author);
  const authorHandle = await resolveHandleRef(db, payload.author);

  await db
    .insert(schema.chatMessages)
    .values({
      id: rowId,
      msgId: asBigInt(payload.id),
      programId: ctx.programId,
      authorRef,
      authorHandle,
      body: payload.body,
      mentionCount: payload.delivered_mentions.length,
      replyTo: payload.reply_to != null ? asBigInt(payload.reply_to) : null,
      ts: asBigInt(payload.ts),
      substrateBlockNumber: ctx.block.substrateBlockNumber,
      gearBlockNumber: null,
      substrateBlockTs: ctx.block.substrateBlockTs,
      extrinsicHash: null,
      seasonId: payload.season_id,
    })
    .onConflictDoNothing({ target: schema.chatMessages.id });

  // Resolve mention handles in parallel, then insert rows sequentially
  // (they're keyed by `{rowId}:{index}` so ordering matters for determinism).
  const mentionHandles = await Promise.all(
    payload.delivered_mentions.map((m) => resolveHandleRef(db, m)),
  );
  for (let i = 0; i < payload.delivered_mentions.length; i++) {
    const m = payload.delivered_mentions[i]!;
    await db
      .insert(schema.chatMentions)
      .values({
        id: `${rowId}:${i}`,
        messageId: rowId,
        recipientRef: handleRefToString(m),
        recipientHandle: mentionHandles[i],
        recipientRegistered: mentionHandles[i] !== null,
        substrateBlockNumber: ctx.block.substrateBlockNumber,
        seasonId: payload.season_id,
      })
      .onConflictDoNothing({ target: schema.chatMentions.id });
  }

  // Metric bumps gated by isFirstTimeEvent so replay doesn't double-count.
  if (!(await isFirstTimeEvent(db, `chat:msg:${rowId}`))) return;

  const ts = ctx.block.substrateBlockTs;
  const tasks: Promise<void>[] = [];
  if ("application" in payload.author) {
    tasks.push(
      bumpMetric(
        db,
        normalizeActorId(payload.author.application),
        payload.season_id,
        "messagesSent",
        ts,
      ),
    );
  }
  for (const m of payload.delivered_mentions) {
    if ("application" in m) {
      tasks.push(
        bumpMentionCountAndSender(
          db,
          normalizeActorId(m.application),
          authorRef,
          payload.season_id,
          ctx,
        ),
      );
    }
  }
  await Promise.all(tasks);
}

async function bumpMentionCountAndSender(
  db: Db,
  recipientAppId: string,
  senderRef: string,
  seasonId: number,
  ctx: HandlerContext,
): Promise<void> {
  const ts = ctx.block.substrateBlockTs;
  await bumpMetric(db, recipientAppId, seasonId, "mentionCount", ts);

  // Unique-sender dedup. First-time (recipient, sender, season) triple bumps
  // uniqueSendersToMe; subsequent mentions from same sender do not.
  const insertRes = await db
    .insert(schema.mentionSenderDedup)
    .values({
      recipientRef: `Application:${recipientAppId}`,
      senderRef,
      seasonId,
      firstSeenBlock: ctx.block.substrateBlockNumber,
    })
    .onConflictDoNothing()
    .returning({ recipientRef: schema.mentionSenderDedup.recipientRef });
  if (insertRes.length > 0) {
    const id = `${recipientAppId}:${seasonId}`;
    await db
      .update(schema.appMetrics)
      .set({ uniqueSendersToMe: sql`${schema.appMetrics.uniqueSendersToMe} + 1` })
      .where(eq(schema.appMetrics.id, id));
  }
}
