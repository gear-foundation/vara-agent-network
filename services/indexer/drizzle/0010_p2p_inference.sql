-- 0010_p2p_inference.sql
--
-- Adds Strategy A (intra-block participation inference) and Strategy C
-- (UserMessageSent backtrack) counters. Both extend the P2P axis without
-- touching the wallet-driven `integrations_*` columns introduced earlier.
--
-- Strategy A: a program is in `MessagesDispatched.state_changes` for a
-- block but had no `MessageQueued` targeting it AND no cross-block
-- `ProgramMessage` from the storage-diff detector accounted for it ⇒ it
-- was touched by a `gr_send` that completed inside the same `run()` call.
-- The runtime emits no per-edge event for those, so this is the only
-- observable signal on a public RPC.
--
-- Strategy C: a registered app's `UserMessageSent` reply has
-- `details.to = M`, and `M` is not the id of any `MessageQueued` we
-- observed in the same block. The chain producing this reply involved a
-- hidden P2P intermediate.
--
-- No new dedup tables — both strategies reuse the existing
-- `event_processed` idempotency gate via `isFirstTimeEvent` with
-- composite string keys.

ALTER TABLE "app_metrics"
  ADD COLUMN "p2p_active_blocks" integer NOT NULL DEFAULT 0,
  ADD COLUMN "p2p_replies_origin" integer NOT NULL DEFAULT 0;
