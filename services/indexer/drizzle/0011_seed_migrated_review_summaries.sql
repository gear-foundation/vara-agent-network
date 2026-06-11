INSERT INTO "review_summaries" (
  "program_id",
  "review_status",
  "latest_verdict",
  "latest_reviewer",
  "latest_reason",
  "display_revision",
  "pending_submission_revision",
  "submission_revision",
  "current_revision_visible_comment_count",
  "total_visible_comment_count",
  "active_request_revision",
  "active_request_acknowledged",
  "manual_override",
  "tombstoned",
  "season_id",
  "updated_at"
)
SELECT
  "id",
  'NotRequested',
  NULL,
  NULL,
  NULL,
  1,
  1,
  NULL,
  0,
  0,
  NULL,
  false,
  false,
  false,
  "season_id",
  "registered_at"
FROM "applications"
ON CONFLICT ("program_id") DO NOTHING;
