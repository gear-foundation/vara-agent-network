UPDATE "participants"
SET "id" = lower("id");
--> statement-breakpoint
UPDATE "applications"
SET
  "id" = lower("id"),
  "owner" = lower("owner");
--> statement-breakpoint
UPDATE "handle_claims"
SET "owner_id" = lower("owner_id");
--> statement-breakpoint
UPDATE "identity_cards"
SET
  "id" = lower("id"),
  "updated_by" = lower("updated_by");
--> statement-breakpoint
UPDATE "announcements"
SET
  "application_id" = lower("application_id"),
  "id" = lower("application_id") || ':' || "post_id"::text;
--> statement-breakpoint
UPDATE "app_metrics"
SET
  "application_id" = lower("application_id"),
  "id" = lower("application_id") || ':' || "season_id"::text;
--> statement-breakpoint
UPDATE "interactions"
SET
  "caller" = lower("caller"),
  "callee" = lower("callee");
--> statement-breakpoint
UPDATE "partner_dedup"
SET
  "caller" = lower("caller"),
  "callee" = lower("callee");
--> statement-breakpoint
UPDATE "chat_messages"
SET
  "program_id" = lower("program_id"),
  "author_ref" = CASE
    WHEN "author_ref" LIKE 'Participant:%' THEN 'Participant:' || lower(split_part("author_ref", ':', 2))
    WHEN "author_ref" LIKE 'Application:%' THEN 'Application:' || lower(split_part("author_ref", ':', 2))
    ELSE "author_ref"
  END;
--> statement-breakpoint
UPDATE "chat_mentions"
SET
  "recipient_ref" = CASE
    WHEN "recipient_ref" LIKE 'Participant:%' THEN 'Participant:' || lower(split_part("recipient_ref", ':', 2))
    WHEN "recipient_ref" LIKE 'Application:%' THEN 'Application:' || lower(split_part("recipient_ref", ':', 2))
    ELSE "recipient_ref"
  END;
--> statement-breakpoint
UPDATE "mention_sender_dedup"
SET
  "recipient_ref" = CASE
    WHEN "recipient_ref" LIKE 'Participant:%' THEN 'Participant:' || lower(split_part("recipient_ref", ':', 2))
    WHEN "recipient_ref" LIKE 'Application:%' THEN 'Application:' || lower(split_part("recipient_ref", ':', 2))
    ELSE "recipient_ref"
  END,
  "sender_ref" = CASE
    WHEN "sender_ref" LIKE 'Participant:%' THEN 'Participant:' || lower(split_part("sender_ref", ':', 2))
    WHEN "sender_ref" LIKE 'Application:%' THEN 'Application:' || lower(split_part("sender_ref", ':', 2))
    ELSE "sender_ref"
  END;
