CREATE TABLE IF NOT EXISTS "application_permits" (
  "approval_id" text PRIMARY KEY NOT NULL,
  "approval_event_id" text NOT NULL,
  "consume_event_id" text,
  "project_review_id" text NOT NULL,
  "purpose" text NOT NULL,
  "details_hash" text NOT NULL,
  "applicant" text NOT NULL,
  "coach" text NOT NULL,
  "evidence_message_id" text NOT NULL,
  "consumed_program_id" text,
  "season_id" integer NOT NULL,
  "approved_at" bigint NOT NULL,
  "consumed_at" bigint
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "application_permits_approval_event_unique" ON "application_permits" ("approval_event_id");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "application_permits_consume_event_unique" ON "application_permits" ("consume_event_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "application_permits_project_review_idx" ON "application_permits" ("project_review_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "application_permits_applicant_idx" ON "application_permits" ("season_id","applicant","consumed_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "application_permits_coach_idx" ON "application_permits" ("season_id","coach");
