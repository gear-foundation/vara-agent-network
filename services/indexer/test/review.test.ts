import assert from "node:assert/strict";
import test from "node:test";
import {
  submittedCurrentRevisionVisibleCommentCount,
  summaryStatusAfterComment,
  summaryStatusFromDecision,
} from "../src/handlers/review.js";

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
