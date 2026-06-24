import { sql } from "drizzle-orm";
import type {
  ApplicationPermitApproved,
  AppStatus,
  CoachAdded,
  CoachRemoved,
  PublishDecisionRecorded,
  ProjectReviewApprovalConsumed,
  ProjectReviewCommentPosted,
  ProjectReviewGuidanceRecorded,
  ProjectReviewLinked,
  ProjectReviewSubmissionApproved,
  ProjectReviewSubmitted,
  ReviewerAdded,
  ReviewerRemoved,
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
  return verdict === "ApprovedForListing" ? "ApprovedForListing" : "RevisionRequested";
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

export function summaryStatusAfterComment(
  existingSummary: {
    reviewStatus: string | null;
    latestVerdict: string | null;
    submissionRevision: number | null;
  } | undefined,
  revision: number,
): string {
  if (
    existingSummary?.reviewStatus === "Submitted" &&
    existingSummary.submissionRevision === revision
  ) {
    return "Submitted";
  }
  if (!existingSummary || existingSummary.latestVerdict === null) return "Commented";
  return existingSummary.reviewStatus ?? "Commented";
}

export function initialReviewSummaryValues(programId: string, seasonId: number, updatedAt: bigint) {
  return {
    programId,
    reviewStatus: "NotRequested",
    latestVerdict: null,
    latestReviewer: null,
    latestReason: null,
    displayRevision: 1,
    pendingSubmissionRevision: 1,
    submissionRevision: null,
    currentRevisionVisibleCommentCount: 0,
    totalVisibleCommentCount: 0,
    activeRequestRevision: null,
    activeRequestAcknowledged: false,
    manualOverride: false,
    tombstoned: false,
    seasonId,
    updatedAt,
  };
}

export function initialProjectReviewSummaryValues(
  projectReviewId: string,
  owner: string,
  githubUrl: string,
  idea: string,
  seasonId: number,
  submittedAt: bigint,
) {
  return {
    projectReviewId,
    owner,
    githubUrl,
    idea,
    status: "Submitted",
    linkedProgramId: null,
    commentCount: 0,
    latestGuidanceOutcome: null,
    latestGuidance: null,
    latestReviewer: null,
    seasonId,
    createdAt: submittedAt,
    updatedAt: submittedAt,
    hidden: false,
    tombstoned: false,
  };
}

export function manualOverrideRevisionUpdates(
  existingSummary: {
    displayRevision: number | null;
    pendingSubmissionRevision: number | null;
    submissionRevision: number | null;
  } | undefined,
  newStatus: AppStatus,
): {
  displayRevision?: number;
  pendingSubmissionRevision?: number;
  currentRevisionVisibleCommentCount?: number;
} {
  if (
    !existingSummary ||
    newStatus !== "Building" ||
    existingSummary.pendingSubmissionRevision !== null
  ) {
    return {};
  }

  const nextRevision =
    Math.max(existingSummary.displayRevision ?? 0, existingSummary.submissionRevision ?? 0) + 1;
  return {
    displayRevision: nextRevision,
    pendingSubmissionRevision: nextRevision,
    currentRevisionVisibleCommentCount: 0,
  };
}

export async function initializeReviewSummary(
  db: Db,
  programId: string,
  seasonId: number,
  updatedAt: bigint,
): Promise<void> {
  const values = initialReviewSummaryValues(programId, seasonId, updatedAt);
  await db
    .insert(schema.reviewSummaries)
    .values(values)
    .onConflictDoUpdate({
      target: schema.reviewSummaries.programId,
      set: {
        reviewStatus: values.reviewStatus,
        latestVerdict: values.latestVerdict,
        latestReviewer: values.latestReviewer,
        latestReason: values.latestReason,
        displayRevision: values.displayRevision,
        pendingSubmissionRevision: values.pendingSubmissionRevision,
        submissionRevision: values.submissionRevision,
        currentRevisionVisibleCommentCount: values.currentRevisionVisibleCommentCount,
        totalVisibleCommentCount: values.totalVisibleCommentCount,
        activeRequestRevision: values.activeRequestRevision,
        activeRequestAcknowledged: values.activeRequestAcknowledged,
        manualOverride: values.manualOverride,
        tombstoned: values.tombstoned,
        seasonId: values.seasonId,
        updatedAt: values.updatedAt,
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
      .delete(schema.reviewRevisionSnapshots)
      .where(sql`${schema.reviewRevisionSnapshots.programId} = ${programId}`);
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
  newStatus: AppStatus,
  seasonId: number,
  updatedAt: bigint,
): Promise<void> {
  const [existingSummary] = await db
    .select({
      displayRevision: schema.reviewSummaries.displayRevision,
      pendingSubmissionRevision: schema.reviewSummaries.pendingSubmissionRevision,
      submissionRevision: schema.reviewSummaries.submissionRevision,
    })
    .from(schema.reviewSummaries)
    .where(sql`${schema.reviewSummaries.programId} = ${programId}`)
    .limit(1);
  const revisionUpdates = manualOverrideRevisionUpdates(existingSummary, newStatus);

  await db
    .insert(schema.reviewSummaries)
    .values({
      programId,
      reviewStatus: "ManualOverride",
      manualOverride: true,
      activeRequestRevision: null,
      activeRequestAcknowledged: false,
      ...revisionUpdates,
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
        ...revisionUpdates,
        seasonId,
        updatedAt,
      },
    });
}

export async function handleReviewerAdded(
  db: Db,
  _ctx: HandlerContext,
  payload: ReviewerAdded,
): Promise<void> {
  const reviewer = normalizeActorId(payload.reviewer);
  const updatedAt = asBigInt(payload.ts);
  await db
    .insert(schema.reviewers)
    .values({
      id: `${payload.season_id}:${reviewer}`,
      reviewer,
      seasonId: payload.season_id,
      active: true,
      updatedAt,
    })
    .onConflictDoUpdate({
      target: schema.reviewers.id,
      set: { active: true, updatedAt },
    });
}

export async function handleReviewerRemoved(
  db: Db,
  _ctx: HandlerContext,
  payload: ReviewerRemoved,
): Promise<void> {
  const reviewer = normalizeActorId(payload.reviewer);
  const updatedAt = asBigInt(payload.ts);
  await db
    .insert(schema.reviewers)
    .values({
      id: `${payload.season_id}:${reviewer}`,
      reviewer,
      seasonId: payload.season_id,
      active: false,
      updatedAt,
    })
    .onConflictDoUpdate({
      target: schema.reviewers.id,
      set: { active: false, updatedAt },
    });
}

export async function handleCoachAdded(
  db: Db,
  _ctx: HandlerContext,
  payload: CoachAdded,
): Promise<void> {
  const coach = normalizeActorId(payload.coach);
  const updatedAt = asBigInt(payload.ts);
  await db
    .insert(schema.coaches)
    .values({
      id: `${payload.season_id}:${coach}`,
      coach,
      seasonId: payload.season_id,
      active: true,
      updatedAt,
    })
    .onConflictDoUpdate({
      target: schema.coaches.id,
      set: { active: true, updatedAt },
    });
}

export async function handleCoachRemoved(
  db: Db,
  _ctx: HandlerContext,
  payload: CoachRemoved,
): Promise<void> {
  const coach = normalizeActorId(payload.coach);
  const updatedAt = asBigInt(payload.ts);
  await db
    .insert(schema.coaches)
    .values({
      id: `${payload.season_id}:${coach}`,
      coach,
      seasonId: payload.season_id,
      active: false,
      updatedAt,
    })
    .onConflictDoUpdate({
      target: schema.coaches.id,
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
  await db.transaction(async (tx) => {
    const inserted = await tx
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

    await tx
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
  await db.transaction(async (tx) => {
    const inserted = await tx
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

    if (payload.author_role === "Reviewer") {
      await tx
        .update(schema.reviewRequests)
        .set({ acknowledged: true })
        .where(sql`${schema.reviewRequests.programId} = ${programId}
          AND ${schema.reviewRequests.revision} = ${payload.revision}`);
    }

    await tx
      .insert(schema.reviewSummaries)
      .values({
        programId,
        reviewStatus: "Commented",
        displayRevision: payload.revision,
        currentRevisionVisibleCommentCount: 1,
        totalVisibleCommentCount: 1,
        activeRequestAcknowledged: payload.author_role === "Reviewer",
        seasonId: payload.season_id,
        updatedAt: ts,
      })
      .onConflictDoUpdate({
        target: schema.reviewSummaries.programId,
        set: {
          reviewStatus: sql`CASE
            WHEN ${schema.reviewSummaries.reviewStatus} = 'Submitted'
              AND ${schema.reviewSummaries.submissionRevision} = ${payload.revision}
              THEN ${schema.reviewSummaries.reviewStatus}
            WHEN ${schema.reviewSummaries.latestVerdict} IS NULL THEN 'Commented'
            ELSE ${schema.reviewSummaries.reviewStatus}
          END`,
          currentRevisionVisibleCommentCount: sql`${schema.reviewSummaries.currentRevisionVisibleCommentCount} + 1`,
          totalVisibleCommentCount: sql`${schema.reviewSummaries.totalVisibleCommentCount} + 1`,
          activeRequestAcknowledged: sql`${schema.reviewSummaries.activeRequestAcknowledged} OR ${payload.author_role === "Reviewer"}`,
          seasonId: payload.season_id,
          updatedAt: ts,
        },
      });
  });
}

export async function handleReviewDecisionRecorded(
  db: Db,
  ctx: HandlerContext,
  payload: ReviewDecisionRecorded,
): Promise<void> {
  const eventId = makeRowId(ctx);
  const programId = normalizeActorId(payload.program_id);
  const reviewer = normalizeActorId(payload.reviewer);
  const decidedAt = asBigInt(payload.decided_at);
  const nextPending = payload.verdict === "RevisionRequested" ? payload.revision + 1 : null;
  const displayRevision = payload.verdict === "RevisionRequested" ? payload.revision + 1 : payload.revision;
  await db.transaction(async (tx) => {
    const inserted = await tx
      .insert(schema.reviewDecisions)
      .values({
        eventId,
        programId,
        revision: payload.revision,
        reviewer,
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
        latestReviewer: reviewer,
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
          latestReviewer: reviewer,
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

export async function handlePublishDecisionRecorded(
  db: Db,
  ctx: HandlerContext,
  payload: PublishDecisionRecorded,
): Promise<void> {
  const { outcome, ...rest } = payload;
  await handleReviewDecisionRecorded(db, ctx, {
    ...rest,
    verdict: outcome === "Published" ? "ApprovedForListing" : "RevisionRequested",
  });
}

export async function handleProjectReviewSubmitted(
  db: Db,
  _ctx: HandlerContext,
  payload: ProjectReviewSubmitted,
): Promise<void> {
  const projectReviewId = asBigInt(payload.project_review_id).toString();
  const owner = normalizeActorId(payload.owner);
  const submittedAt = asBigInt(payload.submitted_at);
  const values = initialProjectReviewSummaryValues(
    projectReviewId,
    owner,
    payload.github_url,
    payload.idea,
    payload.season_id,
    submittedAt,
  );

  await db
    .insert(schema.projectReviewSummaries)
    .values(values)
    .onConflictDoNothing({ target: schema.projectReviewSummaries.projectReviewId });
}

export async function handleProjectReviewSubmissionApproved(
  db: Db,
  ctx: HandlerContext,
  payload: ProjectReviewSubmissionApproved,
): Promise<void> {
  const approvalId = asBigInt(payload.approval_id).toString();
  const applicant = normalizeActorId(payload.applicant);
  const coach = normalizeActorId(payload.coach);
  const requestMessageId = asBigInt(payload.request_message_id).toString();
  const approvedAt = asBigInt(payload.approved_at);

  await db
    .insert(schema.projectReviewApprovals)
    .values({
      approvalId,
      approvalEventId: makeRowId(ctx),
      consumeEventId: null,
      applicant,
      coach,
      requestMessageId,
      consumedProjectReviewId: null,
      seasonId: payload.season_id,
      approvedAt,
      consumedAt: null,
    })
    .onConflictDoNothing({ target: schema.projectReviewApprovals.approvalId });
}

export async function handleApplicationPermitApproved(
  db: Db,
  ctx: HandlerContext,
  payload: ApplicationPermitApproved,
): Promise<void> {
  await db
    .insert(schema.applicationPermits)
    .values({
      approvalId: asBigInt(payload.approval_id).toString(),
      approvalEventId: makeRowId(ctx),
      consumeEventId: null,
      projectReviewId: asBigInt(payload.project_review_id).toString(),
      purpose: payload.purpose,
      detailsHash: hashToHex(payload.details_hash),
      applicant: normalizeActorId(payload.applicant),
      coach: normalizeActorId(payload.coach),
      evidenceMessageId: asBigInt(payload.evidence_message_id).toString(),
      consumedProgramId: null,
      seasonId: payload.season_id,
      approvedAt: asBigInt(payload.approved_at),
      consumedAt: null,
    })
    .onConflictDoNothing({ target: schema.applicationPermits.approvalId });
}

export async function handleProjectReviewApprovalConsumed(
  db: Db,
  ctx: HandlerContext,
  payload: ProjectReviewApprovalConsumed,
): Promise<void> {
  const approvalId = asBigInt(payload.approval_id).toString();
  const projectReviewId = asBigInt(payload.project_review_id).toString();
  const consumedAt = asBigInt(payload.consumed_at);

  await db
    .update(schema.projectReviewApprovals)
    .set({
      consumeEventId: makeRowId(ctx),
      consumedProjectReviewId: projectReviewId,
      consumedAt,
    })
    .where(sql`${schema.projectReviewApprovals.approvalId} = ${approvalId}
      AND ${schema.projectReviewApprovals.consumedAt} IS NULL`);
}

export async function handleProjectReviewCommentPosted(
  db: Db,
  ctx: HandlerContext,
  payload: ProjectReviewCommentPosted,
): Promise<void> {
  const eventId = makeRowId(ctx);
  const projectReviewId = asBigInt(payload.project_review_id).toString();
  const author = normalizeActorId(payload.author);
  const ts = asBigInt(payload.ts);

  await db.transaction(async (tx) => {
    const inserted = await tx
      .insert(schema.projectReviewComments)
      .values({
        eventId,
        projectReviewId,
        author,
        authorRole: payload.author_role,
        body: payload.body,
        ts,
        seasonId: payload.season_id,
      })
      .onConflictDoNothing({ target: schema.projectReviewComments.eventId })
      .returning({ eventId: schema.projectReviewComments.eventId });
    if (inserted.length === 0) return;

    await tx
      .update(schema.projectReviewSummaries)
      .set({
        status: sql`CASE
          WHEN ${schema.projectReviewSummaries.status} = 'Submitted' THEN 'Commented'
          ELSE ${schema.projectReviewSummaries.status}
        END`,
        commentCount: sql`${schema.projectReviewSummaries.commentCount} + 1`,
        updatedAt: ts,
      })
      .where(sql`${schema.projectReviewSummaries.projectReviewId} = ${projectReviewId}`);
  });
}

export async function handleProjectReviewGuidanceRecorded(
  db: Db,
  ctx: HandlerContext,
  payload: ProjectReviewGuidanceRecorded,
): Promise<void> {
  const eventId = makeRowId(ctx);
  const projectReviewId = asBigInt(payload.project_review_id).toString();
  const reviewer = normalizeActorId(payload.reviewer);
  const ts = asBigInt(payload.ts);

  await db.transaction(async (tx) => {
    const inserted = await tx
      .insert(schema.projectReviewGuidance)
      .values({
        eventId,
        projectReviewId,
        reviewer,
        outcome: payload.outcome,
        body: payload.body,
        ts,
        seasonId: payload.season_id,
      })
      .onConflictDoNothing({ target: schema.projectReviewGuidance.eventId })
      .returning({ eventId: schema.projectReviewGuidance.eventId });
    if (inserted.length === 0) return;

    await tx
      .update(schema.projectReviewSummaries)
      .set({
        status: sql`CASE
          WHEN ${schema.projectReviewSummaries.status} = 'Linked' THEN 'Linked'
          ELSE 'GuidanceRecorded'
        END`,
        latestGuidanceOutcome: payload.outcome,
        latestGuidance: payload.body,
        latestReviewer: reviewer,
        updatedAt: ts,
      })
      .where(sql`${schema.projectReviewSummaries.projectReviewId} = ${projectReviewId}`);
  });
}

export async function handleProjectReviewLinked(
  db: Db,
  ctx: HandlerContext,
  payload: ProjectReviewLinked,
): Promise<void> {
  const eventId = makeRowId(ctx);
  const projectReviewId = asBigInt(payload.project_review_id).toString();
  const owner = normalizeActorId(payload.owner);
  const programId = normalizeActorId(payload.program_id);
  const linkedAt = asBigInt(payload.linked_at);

  await db.transaction(async (tx) => {
    const inserted = await tx
      .insert(schema.projectReviewLinks)
      .values({
        eventId,
        projectReviewId,
        owner,
        programId,
        linkedAt,
        seasonId: payload.season_id,
      })
      .onConflictDoNothing({ target: schema.projectReviewLinks.eventId })
      .returning({ eventId: schema.projectReviewLinks.eventId });
    if (inserted.length === 0) return;

    await tx
      .update(schema.projectReviewSummaries)
      .set({
        status: "Linked",
        linkedProgramId: programId,
        updatedAt: linkedAt,
      })
      .where(sql`${schema.projectReviewSummaries.projectReviewId} = ${projectReviewId}`);
  });
}
