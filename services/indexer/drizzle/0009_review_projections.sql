CREATE TABLE IF NOT EXISTS "reviewers" (
  "id" text PRIMARY KEY NOT NULL,
  "reviewer" text NOT NULL,
  "season_id" integer NOT NULL,
  "active" boolean DEFAULT true NOT NULL,
  "updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "reviewers_reviewer_season_unique" ON "reviewers" ("reviewer","season_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "reviewers_active_season_idx" ON "reviewers" ("season_id","active");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "review_revision_snapshots" (
  "id" text PRIMARY KEY NOT NULL,
  "event_id" text NOT NULL,
  "program_id" text NOT NULL,
  "owner" text NOT NULL,
  "revision" integer NOT NULL,
  "handle" text NOT NULL,
  "description" text NOT NULL,
  "track" text NOT NULL,
  "github_url" text NOT NULL,
  "skills_hash" text NOT NULL,
  "skills_url" text NOT NULL,
  "idl_hash" text NOT NULL,
  "idl_url" text NOT NULL,
  "discord_account" text,
  "telegram_account" text,
  "x_account" text,
  "submitted_at" bigint NOT NULL,
  "season_id" integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "review_snapshots_app_revision_unique" ON "review_revision_snapshots" ("program_id","revision");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "review_snapshots_event_unique" ON "review_revision_snapshots" ("event_id");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "review_requests" (
  "event_id" text PRIMARY KEY NOT NULL,
  "program_id" text NOT NULL,
  "owner" text NOT NULL,
  "revision" integer NOT NULL,
  "reason" text NOT NULL,
  "requested_at" bigint NOT NULL,
  "season_id" integer NOT NULL,
  "acknowledged" boolean DEFAULT false NOT NULL,
  "hidden" boolean DEFAULT false NOT NULL,
  "tombstoned" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "review_requests_app_revision_idx" ON "review_requests" ("program_id","revision");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "review_requests_queue_idx" ON "review_requests" ("season_id","acknowledged","hidden","tombstoned");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "review_comments" (
  "event_id" text PRIMARY KEY NOT NULL,
  "program_id" text NOT NULL,
  "revision" integer NOT NULL,
  "author" text NOT NULL,
  "author_role" text NOT NULL,
  "body" text NOT NULL,
  "ts" bigint NOT NULL,
  "season_id" integer NOT NULL,
  "hidden" boolean DEFAULT false NOT NULL,
  "tombstoned" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "review_comments_app_revision_idx" ON "review_comments" ("program_id","revision","event_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "review_comments_visible_idx" ON "review_comments" ("program_id","hidden","tombstoned");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "review_decisions" (
  "event_id" text PRIMARY KEY NOT NULL,
  "program_id" text NOT NULL,
  "revision" integer NOT NULL,
  "reviewer" text NOT NULL,
  "verdict" text NOT NULL,
  "reason" text NOT NULL,
  "criteria" jsonb NOT NULL,
  "old_status" text NOT NULL,
  "new_status" text NOT NULL,
  "decided_at" bigint NOT NULL,
  "season_id" integer NOT NULL,
  "tombstoned" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "review_decisions_app_revision_idx" ON "review_decisions" ("program_id","revision");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "review_decisions_season_decided_idx" ON "review_decisions" ("season_id","decided_at");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "review_summaries" (
  "program_id" text PRIMARY KEY NOT NULL,
  "review_status" text,
  "latest_verdict" text,
  "latest_reviewer" text,
  "latest_reason" text,
  "display_revision" integer,
  "pending_submission_revision" integer,
  "submission_revision" integer,
  "current_revision_visible_comment_count" integer DEFAULT 0 NOT NULL,
  "total_visible_comment_count" integer DEFAULT 0 NOT NULL,
  "active_request_revision" integer,
  "active_request_acknowledged" boolean DEFAULT false NOT NULL,
  "manual_override" boolean DEFAULT false NOT NULL,
  "tombstoned" boolean DEFAULT false NOT NULL,
  "season_id" integer NOT NULL,
  "updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "review_summaries_queue_idx" ON "review_summaries" ("season_id","review_status","manual_override","tombstoned");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "hidden_review_event_ids" (
  "event_id" text PRIMARY KEY NOT NULL,
  "reason" text NOT NULL,
  "hidden_at" bigint NOT NULL
);
