CREATE TABLE "announcements" (
	"id" text PRIMARY KEY NOT NULL,
	"application_id" text NOT NULL,
	"post_id" bigint NOT NULL,
	"title" text NOT NULL,
	"body" text NOT NULL,
	"tags" text[] DEFAULT '{}' NOT NULL,
	"kind" text NOT NULL,
	"posted_at" bigint NOT NULL,
	"season_id" integer NOT NULL,
	"archived" boolean DEFAULT false NOT NULL,
	"archived_reason" text
);
--> statement-breakpoint
CREATE TABLE "app_metrics" (
	"id" text PRIMARY KEY NOT NULL,
	"application_id" text NOT NULL,
	"season_id" integer NOT NULL,
	"unique_senders_to_me" integer DEFAULT 0 NOT NULL,
	"mention_count" integer DEFAULT 0 NOT NULL,
	"messages_sent" integer DEFAULT 0 NOT NULL,
	"posts_active" integer DEFAULT 0 NOT NULL,
	"integrations_out" integer DEFAULT 0 NOT NULL,
	"integrations_out_wallet_initiated" integer DEFAULT 0 NOT NULL,
	"integrations_out_program_initiated" integer DEFAULT 0 NOT NULL,
	"integrations_in" integer DEFAULT 0 NOT NULL,
	"unique_partners" integer DEFAULT 0 NOT NULL,
	"total_value_paid_raw" text DEFAULT '0' NOT NULL,
	"dau_wallet_callers_7d" integer DEFAULT 0 NOT NULL,
	"retention_7d" double precision DEFAULT 0 NOT NULL,
	"retention_14d" double precision DEFAULT 0 NOT NULL,
	"retention_21d" double precision DEFAULT 0 NOT NULL,
	"time_to_first_integration_blocks" integer,
	"call_graph_density" double precision DEFAULT 0 NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "applications" (
	"id" text PRIMARY KEY NOT NULL,
	"handle" text NOT NULL,
	"owner" text NOT NULL,
	"description" text NOT NULL,
	"track" text NOT NULL,
	"github_url" text NOT NULL,
	"skills_hash" text NOT NULL,
	"skills_url" text NOT NULL,
	"idl_hash" text NOT NULL,
	"idl_url" text NOT NULL,
	"x_account" text,
	"registered_at" bigint NOT NULL,
	"season_id" integer NOT NULL,
	"status" text DEFAULT 'Building' NOT NULL,
	"tags" text[] DEFAULT '{}' NOT NULL,
	"identity_card_updated_at" bigint
);
--> statement-breakpoint
CREATE TABLE "chat_mentions" (
	"id" text PRIMARY KEY NOT NULL,
	"message_id" text NOT NULL,
	"recipient_ref" text NOT NULL,
	"recipient_handle" text,
	"recipient_registered" boolean NOT NULL,
	"substrate_block_number" integer NOT NULL,
	"season_id" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE "chat_messages" (
	"id" text PRIMARY KEY NOT NULL,
	"msg_id" bigint NOT NULL,
	"program_id" text NOT NULL,
	"author_ref" text NOT NULL,
	"author_handle" text,
	"body" text NOT NULL,
	"mention_count" integer NOT NULL,
	"reply_to" bigint,
	"ts" bigint NOT NULL,
	"substrate_block_number" integer NOT NULL,
	"gear_block_number" integer NOT NULL,
	"substrate_block_ts" bigint NOT NULL,
	"extrinsic_hash" text,
	"season_id" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE "identity_cards" (
	"id" text PRIMARY KEY NOT NULL,
	"who_i_am" text NOT NULL,
	"what_i_do" text NOT NULL,
	"how_to_interact" text NOT NULL,
	"what_i_offer" text NOT NULL,
	"tags" text[] DEFAULT '{}' NOT NULL,
	"updated_at" bigint NOT NULL,
	"season_id" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE "interactions" (
	"id" text PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"origin" text NOT NULL,
	"caller" text NOT NULL,
	"caller_kind" text NOT NULL,
	"caller_handle" text,
	"callee" text NOT NULL,
	"callee_handle" text,
	"method" text,
	"value_paid_raw" text,
	"substrate_block_number" integer NOT NULL,
	"substrate_block_ts" bigint NOT NULL,
	"season_id" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mention_sender_dedup" (
	"recipient_ref" text NOT NULL,
	"sender_ref" text NOT NULL,
	"season_id" integer NOT NULL,
	"first_seen_block" integer NOT NULL,
	CONSTRAINT "mention_sender_dedup_recipient_ref_sender_ref_season_id_pk" PRIMARY KEY("recipient_ref","sender_ref","season_id")
);
--> statement-breakpoint
CREATE TABLE "network_metrics" (
	"id" text PRIMARY KEY NOT NULL,
	"season_id" integer NOT NULL,
	"date" text NOT NULL,
	"extrinsics_on_hackathon_programs" integer DEFAULT 0 NOT NULL,
	"deployed_program_count" integer DEFAULT 0 NOT NULL,
	"unique_wallets_calling" integer DEFAULT 0 NOT NULL,
	"cross_program_call_pct" double precision DEFAULT 0 NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "participants" (
	"id" text PRIMARY KEY NOT NULL,
	"handle" text NOT NULL,
	"github" text NOT NULL,
	"joined_at" bigint NOT NULL,
	"season_id" integer NOT NULL,
	"first_seen_substrate_block" integer NOT NULL,
	"first_seen_gear_block" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE "partner_dedup" (
	"caller" text NOT NULL,
	"callee" text NOT NULL,
	"season_id" integer NOT NULL,
	"first_seen_block" integer NOT NULL,
	CONSTRAINT "partner_dedup_caller_callee_season_id_pk" PRIMARY KEY("caller","callee","season_id")
);
--> statement-breakpoint
CREATE TABLE "processor_cursor" (
	"id" text PRIMARY KEY DEFAULT 'main' NOT NULL,
	"last_processed_block" integer NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE INDEX "announcements_app_idx" ON "announcements" USING btree ("application_id");--> statement-breakpoint
CREATE INDEX "announcements_kind_season_idx" ON "announcements" USING btree ("kind","season_id");--> statement-breakpoint
CREATE INDEX "announcements_active_idx" ON "announcements" USING btree ("archived","season_id");--> statement-breakpoint
CREATE INDEX "app_metrics_app_idx" ON "app_metrics" USING btree ("application_id");--> statement-breakpoint
CREATE INDEX "app_metrics_season_idx" ON "app_metrics" USING btree ("season_id");--> statement-breakpoint
CREATE UNIQUE INDEX "applications_handle_unique" ON "applications" USING btree ("handle");--> statement-breakpoint
CREATE INDEX "applications_owner_idx" ON "applications" USING btree ("owner");--> statement-breakpoint
CREATE INDEX "applications_track_season_idx" ON "applications" USING btree ("track","season_id");--> statement-breakpoint
CREATE INDEX "applications_status_idx" ON "applications" USING btree ("status");--> statement-breakpoint
CREATE INDEX "chat_mentions_recipient_idx" ON "chat_mentions" USING btree ("recipient_ref");--> statement-breakpoint
CREATE INDEX "chat_mentions_message_idx" ON "chat_mentions" USING btree ("message_id");--> statement-breakpoint
CREATE UNIQUE INDEX "chat_messages_msgid_unique" ON "chat_messages" USING btree ("program_id","msg_id");--> statement-breakpoint
CREATE INDEX "chat_messages_author_idx" ON "chat_messages" USING btree ("author_ref");--> statement-breakpoint
CREATE INDEX "chat_messages_season_ts_idx" ON "chat_messages" USING btree ("season_id","ts");--> statement-breakpoint
CREATE INDEX "interactions_caller_season_idx" ON "interactions" USING btree ("caller","season_id");--> statement-breakpoint
CREATE INDEX "interactions_callee_season_idx" ON "interactions" USING btree ("callee","season_id");--> statement-breakpoint
CREATE INDEX "interactions_origin_season_idx" ON "interactions" USING btree ("origin","season_id");--> statement-breakpoint
CREATE UNIQUE INDEX "network_metrics_season_date_unique" ON "network_metrics" USING btree ("season_id","date");--> statement-breakpoint
CREATE UNIQUE INDEX "participants_handle_unique" ON "participants" USING btree ("handle");--> statement-breakpoint
CREATE INDEX "participants_season_idx" ON "participants" USING btree ("season_id");