-- 0009_p2p_detection.sql
--
-- Adds the schema needed for capturing program → program (P2P) interactions
-- via storage diffs on `gearMessenger.dispatches` and `gearMessenger.waitlist`.
--
-- Background: pallet-gear emits `Gear.MessageQueued` only inside extrinsic
-- handlers, so it surfaces wallet → program edges only. App → app sends from
-- WASM (`gr_send`, `gr_create_program`) go through the journal handler with
-- no event deposit — invisible at the event layer. The processor compensates
-- by snapshot-diffing the messenger storage at each finalized head and
-- emitting a synthetic ProgramMessage event into the same handler pipeline.
--
-- Coverage on a public Vara RPC: every P2P edge whose dispatch crosses at
-- least one block boundary is captured. Tight chains that complete within a
-- single `run()` call (e.g. a `send_for_reply` whose target is also in the
-- queue and replies in the same block) leave no storage trace and are NOT
-- captured here; recovering those would require `state_traceBlock`, which
-- public RPCs disable as unsafe.

ALTER TABLE "interactions"
  ADD COLUMN "detected_via" text NOT NULL DEFAULT 'event';
--> statement-breakpoint

CREATE INDEX "interactions_detected_via_idx" ON "interactions" ("detected_via");
--> statement-breakpoint

ALTER TABLE "app_metrics"
  ADD COLUMN "p2p_calls_out" integer NOT NULL DEFAULT 0,
  ADD COLUMN "p2p_calls_in" integer NOT NULL DEFAULT 0,
  ADD COLUMN "p2p_unique_partners" integer NOT NULL DEFAULT 0;
--> statement-breakpoint

CREATE TABLE "p2p_partner_dedup" (
  "caller" text NOT NULL,
  "callee" text NOT NULL,
  "season_id" integer NOT NULL,
  "first_seen_block" integer NOT NULL,
  CONSTRAINT "p2p_partner_dedup_caller_callee_season_id_pk"
    PRIMARY KEY ("caller", "callee", "season_id")
);
