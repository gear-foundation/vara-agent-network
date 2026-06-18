import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  initialProjectReviewSummaryValues,
  initialReviewSummaryValues,
  manualOverrideRevisionUpdates,
  submittedCurrentRevisionVisibleCommentCount,
  summaryStatusAfterComment,
  summaryStatusFromDecision,
} from "../src/handlers/review.js";

const reviewHandlerSource = readFileSync(new URL("../src/handlers/review.ts", import.meta.url), "utf8");
const processorSource = readFileSync(new URL("../src/main.ts", import.meta.url), "utf8");

test("review decision statuses match public summary badges", () => {
  assert.equal(summaryStatusFromDecision("ApprovedForListing"), "ApprovedForListing");
  assert.equal(summaryStatusFromDecision("RevisionRequested"), "RevisionRequested");
});

test("submitted revisions preserve current visible review comments", () => {
  assert.equal(
    submittedCurrentRevisionVisibleCommentCount(
      { displayRevision: 1, currentRevisionVisibleCommentCount: 2 },
      1,
      0,
    ),
    2,
  );
  assert.equal(
    submittedCurrentRevisionVisibleCommentCount(
      { displayRevision: 1, currentRevisionVisibleCommentCount: 0 },
      1,
      3,
    ),
    3,
  );
  assert.equal(
    submittedCurrentRevisionVisibleCommentCount(
      { displayRevision: 1, currentRevisionVisibleCommentCount: 2 },
      2,
      0,
    ),
    0,
  );
});

test("comments keep submitted revisions in the decision queue", () => {
  assert.equal(
    summaryStatusAfterComment(
      { reviewStatus: "Submitted", latestVerdict: null, submissionRevision: 2 },
      2,
    ),
    "Submitted",
  );
  assert.equal(
    summaryStatusAfterComment(
      { reviewStatus: "Requested", latestVerdict: null, submissionRevision: null },
      2,
    ),
    "Commented",
  );
  assert.equal(
    summaryStatusAfterComment(
      { reviewStatus: "RevisionRequested", latestVerdict: "RevisionRequested", submissionRevision: 1 },
      2,
    ),
    "RevisionRequested",
  );
});

test("registration reset clears stale review summary state", () => {
  assert.deepEqual(
    initialReviewSummaryValues("0xabc", 2, 123n),
    {
      programId: "0xabc",
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
      seasonId: 2,
      updatedAt: 123n,
    },
  );
});

test("manual reopen advances pending and display revision from the indexed summary", () => {
  assert.deepEqual(
    manualOverrideRevisionUpdates(
      {
        displayRevision: 1,
        pendingSubmissionRevision: null,
        submissionRevision: 1,
      },
      "Building",
    ),
    {
      displayRevision: 2,
      pendingSubmissionRevision: 2,
      currentRevisionVisibleCommentCount: 0,
    },
  );

  assert.deepEqual(
    manualOverrideRevisionUpdates(
      {
        displayRevision: 2,
        pendingSubmissionRevision: 2,
        submissionRevision: 1,
      },
      "Building",
    ),
    {},
  );

  assert.deepEqual(
    manualOverrideRevisionUpdates(
      {
        displayRevision: 2,
        pendingSubmissionRevision: null,
        submissionRevision: 2,
      },
      "Live",
    ),
    {},
  );
});

test("project review submission initializes public queue summary", () => {
  assert.deepEqual(
    initialProjectReviewSummaryValues(
      "7",
      "0xabc",
      "https://github.com/alice/agent",
      "build an integration scout",
      1,
      123n,
    ),
    {
      projectReviewId: "7",
      owner: "0xabc",
      githubUrl: "https://github.com/alice/agent",
      idea: "build an integration scout",
      status: "Submitted",
      linkedProgramId: null,
      commentCount: 0,
      latestGuidanceOutcome: null,
      latestGuidance: null,
      latestReviewer: null,
      seasonId: 1,
      createdAt: 123n,
      updatedAt: 123n,
      hidden: false,
      tombstoned: false,
    },
  );
});

test("coach role and project review approval events are projected", () => {
  for (const token of [
    "handleCoachAdded",
    "handleCoachRemoved",
    "handleProjectReviewSubmissionApproved",
    "handleProjectReviewApprovalConsumed",
  ]) {
    assert.match(reviewHandlerSource, new RegExp(token));
    assert.match(processorSource, new RegExp(token));
  }
  assert.match(reviewHandlerSource, /onConflictDoNothing\(\{ target: schema\.projectReviewApprovals\.approvalId \}\)/);
  assert.match(reviewHandlerSource, /consumedAt\} IS NULL/);
});
