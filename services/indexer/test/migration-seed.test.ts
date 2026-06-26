import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const seedSql = readFileSync(
  new URL("../drizzle/0014_seed_coach_migrated_read_model.sql", import.meta.url),
  "utf8",
);
const applicationPermitsSql = readFileSync(
  new URL("../drizzle/0015_application_permits.sql", import.meta.url),
  "utf8",
);
const projectReviewRepairSql = readFileSync(
  new URL("../drizzle/0016_repair_project_review_summary_collision.sql", import.meta.url),
  "utf8",
);
const journal = readFileSync(new URL("../drizzle/meta/_journal.json", import.meta.url), "utf8");

test("coach migration read-model seed is journaled with expected counts", () => {
  assert.match(journal, /0014_seed_coach_migrated_read_model/);
  assert.match(seedSql, /c_participants <> 68/);
  assert.match(seedSql, /c_applications <> 91/);
  assert.match(seedSql, /c_identity_cards <> 54/);
  assert.match(seedSql, /c_announcements <> 157/);
  assert.match(seedSql, /c_reviewers <> 0/);
  assert.match(seedSql, /c_coaches <> 1/);
  assert.match(seedSql, /processor_cursor/);
  assert.match(seedSql, /DELETE FROM "project_review_guidance"/);
  assert.doesNotMatch(seedSql, /project_review_guidances/);
});

test("application permits projection table is journaled", () => {
  assert.match(journal, /0015_application_permits/);
  assert.match(applicationPermitsSql, /CREATE TABLE IF NOT EXISTS "application_permits"/);
  assert.match(applicationPermitsSql, /"approval_id" text PRIMARY KEY NOT NULL/);
  assert.match(applicationPermitsSql, /"details_hash" text NOT NULL/);
  assert.match(applicationPermitsSql, /application_permits_approval_event_unique/);
  assert.match(applicationPermitsSql, /application_permits_consume_event_unique/);
});

test("project review summary collision repair is journaled", () => {
  assert.match(journal, /0016_repair_project_review_summary_collision/);
  assert.match(projectReviewRepairSql, /project_review_id"/);
  assert.match(projectReviewRepairSql, /00-moodmosaic/);
  assert.match(projectReviewRepairSql, /ON CONFLICT \("project_review_id"\) DO UPDATE/);
});
