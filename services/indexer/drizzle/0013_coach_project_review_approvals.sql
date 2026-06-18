CREATE TABLE IF NOT EXISTS "coaches" (
  "id" text PRIMARY KEY NOT NULL,
  "coach" text NOT NULL,
  "season_id" integer NOT NULL,
  "active" boolean DEFAULT true NOT NULL,
  "updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "coaches_active_season_idx" ON "coaches" ("season_id","active");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "coaches_coach_season_unique" ON "coaches" ("coach","season_id");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "project_review_approvals" (
  "approval_id" text PRIMARY KEY NOT NULL,
  "approval_event_id" text NOT NULL,
  "consume_event_id" text,
  "applicant" text NOT NULL,
  "coach" text NOT NULL,
  "request_message_id" text NOT NULL,
  "consumed_project_review_id" text,
  "season_id" integer NOT NULL,
  "approved_at" bigint NOT NULL,
  "consumed_at" bigint
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "project_review_approvals_approval_event_unique" ON "project_review_approvals" ("approval_event_id");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "project_review_approvals_consume_event_unique" ON "project_review_approvals" ("consume_event_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "project_review_approvals_applicant_idx" ON "project_review_approvals" ("season_id","applicant","consumed_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "project_review_approvals_coach_idx" ON "project_review_approvals" ("season_id","coach");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "project_review_approvals_request_message_idx" ON "project_review_approvals" ("request_message_id");
