-- Stable SQL view for the Phase 9 voucher-issuance cron (codex Q2 resolution).
-- The cron reads this view directly over Postgres; not exposed through
-- GraphQL. Contract on this view must stay stable across indexer refactors.
--
-- Columns:
--   wallet           — participant wallet ActorId hex
--   handle           — participant handle
--   season_id        — season the participant joined
--   first_seen_block — substrate block number at registration
--
-- Only participants (not application wallet-agents) are voucher-eligible by
-- default. Flip the WHERE clause if Social/Open archetypes should also be
-- covered.

CREATE OR REPLACE VIEW voucher_eligible_participants AS
SELECT
  p.id                      AS wallet,
  p.handle                  AS handle,
  p.season_id               AS season_id,
  p.first_seen_substrate_block AS first_seen_block
FROM participants p
ORDER BY p.first_seen_substrate_block ASC;
