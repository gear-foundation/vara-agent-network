import assert from "node:assert/strict";
import test from "node:test";
import {
  submittedCurrentRevisionVisibleCommentCount,
  summaryStatusFromDecision,
} from "../src/handlers/review.js";

test("review decision statuses match public summary badges", () => {
  assert.equal(summaryStatusFromDecision("Accepted"), "Accepted");
  assert.equal(summaryStatusFromDecision("Rejected"), "Rejected");
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
