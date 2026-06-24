import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const seedSql = readFileSync(
  new URL("../drizzle/0014_seed_coach_migrated_read_model.sql", import.meta.url),
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
