ALTER TABLE "applications" ADD COLUMN IF NOT EXISTS "discord_account" text;
--> statement-breakpoint
ALTER TABLE "applications" ADD COLUMN IF NOT EXISTS "telegram_account" text;
