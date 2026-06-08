import { sql } from "drizzle-orm";
import type {
  JudgeAdded,
  JudgeRemoved,
  ReviewCommentPosted,
  ReviewDecisionRecorded,
  ReviewRequested,
  ReviewRevisionSubmitted,
} from "../helpers/event-payloads.js";
import { asBigInt, hashToHex, normalizeActorId } from "../helpers/event-payloads.js";
import type { Db } from "../model/db.js";
import { schema } from "../model/db.js";
import { makeRowId, type HandlerContext } from "./common.js";

export function summaryStatusFromDecision(verdict: string): string {
  return verdict === "Accepted" ? "Accepted" : "Rejected";
}

export function submittedCurrentRevisionVisibleCommentCount(
  existingSummary: {
    displayRevision: number | null;
    currentRevisionVisibleCommentCount: number;
  } | undefined,
  revision: number,
  visibleCommentCount: number,
): number {
  if (visibleCommentCount > 0) return visibleCommentCount;
  return existingSummary?.displayRevision === revision
    ? existingSummary.currentRevisionVisibleCommentCount
    : 0;
}

export async function initializeReviewSummary(
  db: Db,
  programId: string,
  seasonId: number,
  updatedAt: bigint,
): Promise<void> {
  await db
    .insert(schema.reviewSummaries)
    .values({
      programId,
      reviewStatus: "NotRequested",
      displayRevision: 1,
      pendingSubmissionRevision: 1,
      submissionRevision: null,
      activeRequestRevision: null,
      activeRequestAcknowledged: false,
      manualOverride: false,
      tombstoned: false,
      seasonId,
      updatedAt,
    })
    .onConflictDoUpdate({
      target: schema.reviewSummaries.programId,
      set: {
        displayRevision: 1,
        pendingSubmissionRevision: 1,
        tombstoned: false,
        manualOverride: false,
        seasonId,
        updatedAt,
      },
    });
}

export async function tombstoneReviewRows(db: Db, programId: string, updatedAt: bigint): Promise<void> {
  await db.transaction(async (tx) => {
    await tx
      .update(schema.reviewRequests)
      .set({ tombstoned: true })
      .where(sql`${schema.reviewRequests.programId} = ${programId}`);
    await tx
      .update(schema.reviewComments)
      .set({ tombstoned: true })
      .where(sql`${schema.reviewComments.programId} = ${programId}`);
    await tx
      .update(schema.reviewDecisions)
      .set({ tombstoned: true })
      .where(sql`${schema.reviewDecisions.programId} = ${programId}`);
    await tx
      .update(schema.reviewSummaries)
      .set({
        tombstoned: true,
        activeRequestRevision: null,
        activeRequestAcknowledged: false,
        updatedAt,
      })
      .where(sql`${schema.reviewSummaries.programId} = ${programId}`);
  });
}

export async function markReviewManualOverride(
  db: Db,
  programId: string,
  seasonId: number,
  updatedAt: bigint,
): Promise<void> {
  await db
    .insert(schema.reviewSummaries)
    .values({
      programId,
      reviewStatus: "ManualOverride",
      manualOverride: true,
      activeRequestRevision: null,
      activeRequestAcknowledged: false,
      seasonId,
      updatedAt,
    })
    .onConflictDoUpdate({
      target: schema.reviewSummaries.programId,
      set: {
        reviewStatus: "ManualOverride",
        manualOverride: true,
        activeRequestRevision: null,
        activeRequestAcknowledged: false,
        seasonId,
        updatedAt,
      },
    });
}

export async function handleJudgeAdded(
  db: Db,
  _ctx: HandlerContext,
  payload: JudgeAdded,
): Promise<void> {
  const judge = normalizeActorId(payload.judge);
  const updatedAt = asBigInt(payload.ts);
  await db
    .insert(schema.judges)
    .values({
      id: `${payload.season_id}:${judge}`,
      judge,
      seasonId: payload.season_id,
      active: true,
      updatedAt,
    })
    .onConflictDoUpdate({
      target: schema.judges.id,
      set: { active: true, updatedAt },
    });
}

export async function handleJudgeRemoved(
  db: Db,
  _ctx: HandlerContext,
  payload: JudgeRemoved,
): Promise<void> {
  const judge = normalizeActorId(payload.judge);
  const updatedAt = asBigInt(payload.ts);
  await db
    .insert(schema.judges)
    .values({
      id: `${payload.season_id}:${judge}`,
      judge,
      seasonId: payload.season_id,
      active: false,
      updatedAt,
    })
    .onConflictDoUpdate({
      target: schema.judges.id,
      set: { active: false, updatedAt },
    });
}

export async function handleReviewRevisionSubmitted(
  db: Db,
  ctx: HandlerContext,
  payload: ReviewRevisionSubmitted,
): Promise<void> {
  const eventId = makeRowId(ctx);
  const programId = normalizeActorId(payload.program_id);
  const owner = normalizeActorId(payload.owner);
  const snapshot = payload.snapshot;
  const submittedAt = asBigInt(payload.submitted_at);
  await db.transaction(async (tx) => {
    const [existingSummary] = await tx
      .select({
        displayRevision: schema.reviewSummaries.displayRevision,
        currentRevisionVisibleCommentCount:
          schema.reviewSummaries.currentRevisionVisibleCommentCount,
      })
      .from(schema.reviewSummaries)
      .where(sql`${schema.reviewSummaries.programId} = ${programId}`)
      .limit(1);
    const [visibleCommentCountRow] = await tx
      .select({ count: sql<number>`count(*)::int` })
      .from(schema.reviewComments)
      .where(sql`${schema.reviewComments.programId} = ${programId}
        AND ${schema.reviewComments.revision} = ${payload.revision}
        AND ${schema.reviewComments.hidden} = false
        AND ${schema.reviewComments.tombstoned} = false`);
    const currentRevisionVisibleCommentCount =
      submittedCurrentRevisionVisibleCommentCount(
        existingSummary,
        payload.revision,
        Number(visibleCommentCountRow?.count ?? 0),
      );

    await tx
      .insert(schema.reviewRevisionSnapshots)
      .values({
        id: `${programId}:${payload.revision}`,
        eventId,
        programId,
        owner,
        revision: payload.revision,
        handle: snapshot.handle,
        description: snapshot.description,
        track: snapshot.track,
        githubUrl: snapshot.github_url,
        skillsHash: hashToHex(snapshot.skills_hash),
        skillsUrl: snapshot.skills_url,
        idlHash: hashToHex(snapshot.idl_hash),
        idlUrl: snapshot.idl_url,
        discordAccount: snapshot.contacts?.discord ?? null,
        telegramAccount: snapshot.contacts?.telegram ?? null,
        xAccount: snapshot.contacts?.x ?? null,
        submittedAt,
        seasonId: payload.season_id,
      })
      .onConflictDoNothing({ target: schema.reviewRevisionSnapshots.id });

    await tx
      .insert(schema.reviewSummaries)
      .values({
        programId,
        reviewStatus: "Submitted",
        displayRevision: payload.revision,
        pendingSubmissionRevision: null,
        submissionRevision: payload.revision,
        activeRequestRevision: null,
        activeRequestAcknowledged: false,
        currentRevisionVisibleCommentCount,
        manualOverride: false,
        tombstoned: false,
        seasonId: payload.season_id,
        updatedAt: submittedAt,
      })
      .onConflictDoUpdate({
        target: schema.reviewSummaries.programId,
        set: {
          reviewStatus: "Submitted",
          displayRevision: payload.revision,
          pendingSubmissionRevision: null,
          submissionRevision: payload.revision,
          activeRequestRevision: null,
          activeRequestAcknowledged: false,
          currentRevisionVisibleCommentCount,
          manualOverride: false,
          tombstoned: false,
          seasonId: payload.season_id,
          updatedAt: submittedAt,
        },
      });
  });
}

export async function handleReviewRequested(
  db: Db,
  ctx: HandlerContext,
  payload: ReviewRequested,
): Promise<void> {
  const eventId = makeRowId(ctx);
  const programId = normalizeActorId(payload.program_id);
  const owner = normalizeActorId(payload.owner);
  const requestedAt = asBigInt(payload.requested_at);
  const inserted = await db
    .insert(schema.reviewRequests)
    .values({
      eventId,
      programId,
      owner,
      revision: payload.revision,
      reason: payload.reason,
      requestedAt,
      seasonId: payload.season_id,
    })
    .onConflictDoNothing({ target: schema.reviewRequests.eventId })
    .returning({ eventId: schema.reviewRequests.eventId });
  if (inserted.length === 0) return;

  await db
    .insert(schema.reviewSummaries)
    .values({
      programId,
      reviewStatus: "Requested",
      displayRevision: payload.revision,
      pendingSubmissionRevision: payload.revision,
      activeRequestRevision: payload.revision,
      activeRequestAcknowledged: false,
      manualOverride: false,
      tombstoned: false,
      seasonId: payload.season_id,
      updatedAt: requestedAt,
    })
    .onConflictDoUpdate({
      target: schema.reviewSummaries.programId,
      set: {
        reviewStatus: "Requested",
        displayRevision: payload.revision,
        pendingSubmissionRevision: payload.revision,
        activeRequestRevision: payload.revision,
        activeRequestAcknowledged: false,
        manualOverride: false,
        tombstoned: false,
        seasonId: payload.season_id,
        updatedAt: requestedAt,
      },
    });
}

export async function handleReviewCommentPosted(
  db: Db,
  ctx: HandlerContext,
  payload: ReviewCommentPosted,
): Promise<void> {
  const eventId = makeRowId(ctx);
  const programId = normalizeActorId(payload.program_id);
  const author = normalizeActorId(payload.author);
  const ts = asBigInt(payload.ts);
  const inserted = await db
    .insert(schema.reviewComments)
    .values({
      eventId,
      programId,
      revision: payload.revision,
      author,
      authorRole: payload.author_role,
      body: payload.body,
      ts,
      seasonId: payload.season_id,
    })
    .onConflictDoNothing({ target: schema.reviewComments.eventId })
    .returning({ eventId: schema.reviewComments.eventId });
  if (inserted.length === 0) return;

  if (payload.author_role === "Judge") {
    await db
      .update(schema.reviewRequests)
      .set({ acknowledged: true })
      .where(sql`${schema.reviewRequests.programId} = ${programId}
        AND ${schema.reviewRequests.revision} = ${payload.revision}`);
  }

  await db
    .insert(schema.reviewSummaries)
    .values({
      programId,
      reviewStatus: "Commented",
      displayRevision: payload.revision,
      currentRevisionVisibleCommentCount: 1,
      totalVisibleCommentCount: 1,
      activeRequestAcknowledged: payload.author_role === "Judge",
      seasonId: payload.season_id,
      updatedAt: ts,
    })
    .onConflictDoUpdate({
      target: schema.reviewSummaries.programId,
      set: {
        reviewStatus: sql`CASE
          WHEN ${schema.reviewSummaries.latestVerdict} IS NULL THEN 'Commented'
          ELSE ${schema.reviewSummaries.reviewStatus}
        END`,
        currentRevisionVisibleCommentCount: sql`${schema.reviewSummaries.currentRevisionVisibleCommentCount} + 1`,
        totalVisibleCommentCount: sql`${schema.reviewSummaries.totalVisibleCommentCount} + 1`,
        activeRequestAcknowledged: sql`${schema.reviewSummaries.activeRequestAcknowledged} OR ${payload.author_role === "Judge"}`,
        seasonId: payload.season_id,
        updatedAt: ts,
      },
    });
}

export async function handleReviewDecisionRecorded(
  db: Db,
  ctx: HandlerContext,
  payload: ReviewDecisionRecorded,
): Promise<void> {
  const eventId = makeRowId(ctx);
  const programId = normalizeActorId(payload.program_id);
  const judge = normalizeActorId(payload.judge);
  const decidedAt = asBigInt(payload.decided_at);
  const inserted = await db
    .insert(schema.reviewDecisions)
    .values({
      eventId,
      programId,
      revision: payload.revision,
      judge,
      verdict: payload.verdict,
      reason: payload.reason,
      criteria: payload.criteria,
      oldStatus: payload.old_status,
      newStatus: payload.new_status,
      decidedAt,
      seasonId: payload.season_id,
    })
    .onConflictDoNothing({ target: schema.reviewDecisions.eventId })
    .returning({ eventId: schema.reviewDecisions.eventId });
  if (inserted.length === 0) return;

  const nextPending = payload.verdict === "Rejected" ? payload.revision + 1 : null;
  const displayRevision = payload.verdict === "Rejected" ? payload.revision + 1 : payload.revision;
  await db.transaction(async (tx) => {
    await tx
      .update(schema.applications)
      .set({ status: payload.new_status })
      .where(sql`${schema.applications.id} = ${programId}`);
    await tx
      .insert(schema.reviewSummaries)
      .values({
        programId,
        reviewStatus: summaryStatusFromDecision(payload.verdict),
        latestVerdict: payload.verdict,
        latestJudge: judge,
        latestReason: payload.reason,
        displayRevision,
        pendingSubmissionRevision: nextPending,
        submissionRevision: payload.revision,
        currentRevisionVisibleCommentCount: 0,
        activeRequestRevision: null,
        activeRequestAcknowledged: false,
        manualOverride: false,
        tombstoned: false,
        seasonId: payload.season_id,
        updatedAt: decidedAt,
      })
      .onConflictDoUpdate({
        target: schema.reviewSummaries.programId,
        set: {
          reviewStatus: summaryStatusFromDecision(payload.verdict),
          latestVerdict: payload.verdict,
          latestJudge: judge,
          latestReason: payload.reason,
          displayRevision,
          pendingSubmissionRevision: nextPending,
          submissionRevision: payload.revision,
          currentRevisionVisibleCommentCount: 0,
          activeRequestRevision: null,
          activeRequestAcknowledged: false,
          manualOverride: false,
          tombstoned: false,
          seasonId: payload.season_id,
          updatedAt: decidedAt,
        },
      });
  });
}
