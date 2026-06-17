import assert from "node:assert/strict";
import test from "node:test";
import {
  deletedProjectReviewLinkUpdates,
  replacementLinkedProjectReviewUpdates,
  replaceCompositeProgramId,
  reviewStatusFromReplacementSummary,
} from "../src/handlers/registry.js";
import type { ApplicationProgramReplaced } from "../src/helpers/event-payloads.js";

const basePayload = {
  review_summary: {
    program_id: "0xnew",
    pending_submission_revision: 1,
    submission_revision: null,
    display_revision: 1,
    active_request_revision: null,
    active_request_acknowledged: false,
    latest_verdict: null,
    latest_reviewer: null,
    latest_reason: null,
    current_revision_comment_count: 0,
    total_comment_count: 0,
    manual_override: false,
    deleted: false,
  },
} as ApplicationProgramReplaced;

test("replacement summary status preserves active request precedence", () => {
  const payload = {
    ...basePayload,
    review_summary: {
      ...basePayload.review_summary,
      active_request_revision: 2,
      latest_verdict: "RevisionRequested",
      submission_revision: 1,
    },
  } as ApplicationProgramReplaced;

  assert.equal(reviewStatusFromReplacementSummary(payload), "Requested");
});

test("replacement summary status mirrors latest verdict when no request is active", () => {
  const payload = {
    ...basePayload,
    review_summary: {
      ...basePayload.review_summary,
      latest_verdict: "ApprovedForListing",
      submission_revision: 1,
    },
  } as ApplicationProgramReplaced;

  assert.equal(reviewStatusFromReplacementSummary(payload), "ApprovedForListing");
});

test("replacement composite ids preserve the row suffix", () => {
  assert.equal(
    replaceCompositeProgramId("0xold:42", "0xold", "0xnew"),
    "0xnew:42",
  );
  assert.equal(
    replaceCompositeProgramId("0xother:42", "0xold", "0xnew"),
    "0xother:42",
  );
});

test("replacement updates linked project review summaries to the new program id", () => {
  assert.deepEqual(replacementLinkedProjectReviewUpdates("0xnew", 123n), {
    linkedProgramId: "0xnew",
    updatedAt: 123n,
  });
});

test("deletion clears linked project review summaries", () => {
  assert.deepEqual(deletedProjectReviewLinkUpdates(456n), {
    linkedProgramId: null,
    updatedAt: 456n,
  });
});
