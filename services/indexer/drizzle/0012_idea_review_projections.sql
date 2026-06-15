CREATE TABLE IF NOT EXISTS "idea_review_summaries" (
  "idea_id" text PRIMARY KEY NOT NULL,
  "owner" text NOT NULL,
  "github_url" text NOT NULL,
  "idea" text NOT NULL,
  "status" text NOT NULL,
  "linked_program_id" text,
  "comment_count" integer DEFAULT 0 NOT NULL,
  "latest_guidance_outcome" text,
  "latest_guidance" text,
  "latest_reviewer" text,
  "season_id" integer NOT NULL,
  "created_at" bigint NOT NULL,
  "updated_at" bigint NOT NULL,
  "hidden" boolean DEFAULT false NOT NULL,
  "tombstoned" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idea_review_summaries_owner_idx" ON "idea_review_summaries" ("owner");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idea_review_summaries_linked_program_idx" ON "idea_review_summaries" ("linked_program_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idea_review_summaries_queue_idx" ON "idea_review_summaries" ("season_id","status","hidden","tombstoned","updated_at");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "idea_review_comments" (
  "event_id" text PRIMARY KEY NOT NULL,
  "idea_id" text NOT NULL,
  "author" text NOT NULL,
  "author_role" text NOT NULL,
  "body" text NOT NULL,
  "ts" bigint NOT NULL,
  "season_id" integer NOT NULL,
  "hidden" boolean DEFAULT false NOT NULL,
  "tombstoned" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idea_review_comments_visible_idx" ON "idea_review_comments" ("idea_id","hidden","tombstoned");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "idea_review_guidance" (
  "event_id" text PRIMARY KEY NOT NULL,
  "idea_id" text NOT NULL,
  "reviewer" text NOT NULL,
  "outcome" text NOT NULL,
  "body" text NOT NULL,
  "ts" bigint NOT NULL,
  "season_id" integer NOT NULL,
  "hidden" boolean DEFAULT false NOT NULL,
  "tombstoned" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idea_review_guidance_visible_idx" ON "idea_review_guidance" ("idea_id","hidden","tombstoned");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "idea_review_links" (
  "event_id" text PRIMARY KEY NOT NULL,
  "idea_id" text NOT NULL,
  "owner" text NOT NULL,
  "program_id" text NOT NULL,
  "linked_at" bigint NOT NULL,
  "season_id" integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idea_review_links_idea_idx" ON "idea_review_links" ("idea_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idea_review_links_program_idx" ON "idea_review_links" ("program_id");
