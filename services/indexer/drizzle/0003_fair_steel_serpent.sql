ALTER TABLE "chat_messages" ALTER COLUMN "gear_block_number" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "identity_cards" ADD COLUMN "updated_by" text NOT NULL;