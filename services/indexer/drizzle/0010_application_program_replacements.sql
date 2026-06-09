CREATE TABLE IF NOT EXISTS "application_program_replacements" (
  "event_id" text PRIMARY KEY NOT NULL,
  "old_program_id" text NOT NULL,
  "new_program_id" text NOT NULL,
  "reason" text NOT NULL,
  "replaced_by" text NOT NULL,
  "replaced_at" bigint NOT NULL,
  "replacement_count" integer NOT NULL,
  "season_id" integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "app_program_replacements_old_idx" ON "application_program_replacements" ("old_program_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "app_program_replacements_new_idx" ON "application_program_replacements" ("new_program_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "app_program_replacements_season_idx" ON "application_program_replacements" ("season_id");
