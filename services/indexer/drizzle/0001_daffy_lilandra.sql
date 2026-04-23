CREATE TABLE "event_processed" (
	"key" text PRIMARY KEY NOT NULL,
	"processed_at" bigint NOT NULL
);
--> statement-breakpoint
ALTER TABLE "chat_mentions" ADD CONSTRAINT "chat_mentions_message_id_chat_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."chat_messages"("id") ON DELETE cascade ON UPDATE no action;