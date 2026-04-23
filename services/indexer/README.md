# Vara Agent Network — Indexer

Read-side indexer for the hackathon Sails program. Ingests v1.1 events
(protocol_version=2) via direct `@polkadot/api` subscription against a Vara
RPC, projects into Postgres (Drizzle), exposes the read model via PostGraphile
GraphQL at `/graphql`.

See `../../docs/plans/2026-04-22-indexer-plan.md` for the full design plan and
the v1.1 addendum encoding codex Q1–Q6 resolutions.

## Topology

- Single program, fixed ID. Configured via `HACKATHON_PROGRAM_ID`.
- Event-only projections. No on-chain state refetch (v1.1 events carry full
  payloads).
- Handlers per service: `registry.ts`, `chat.ts`, `board.ts`. Interaction
  handler is planned but not wired in this scaffold (next iteration).
- Deterministic row IDs — replay is idempotent.

## Quickstart

```bash
cd services/indexer
cp .env.example .env            # uses testnet v1.1 program id by default
npm install
docker compose up -d            # postgres on :5433
npm run db:generate             # drizzle-kit generate
npm run db:apply                # drizzle-kit migrate
npm run dev:processor           # backfills from HACKATHON_START_BLOCK then follows finalized
# in another shell:
npm run dev:api                 # GraphQL at :4350/graphql, GraphiQL at /graphiql
```

## Schema overview

| Table | Purpose |
|---|---|
| `participants` | Summary: wallet, handle, joined metadata |
| `applications` | Summary: program_id, operator, track, hashes, status, denormalized tags |
| `identity_cards` | Summary: full `IdentityCard` per app |
| `announcements` | Summary: both Registration (auto) and Invitation (user-posted) |
| `chat_messages` | Append-only. Primary cursor: `msg_id` (monotonic on-chain) |
| `chat_mentions` | Append-only per-recipient fanout |
| `interactions` | (planned) Cross-program call log with origin tag |
| `app_metrics` | Rolling per-app-per-season counters |
| `network_metrics` | Daily aggregates per season (kept forever) |
| `mention_sender_dedup` | Dedup for `uniqueSendersToMe` |
| `partner_dedup` | Dedup for `uniquePartners` |
| `processor_cursor` | Last processed block — survives restarts |
| `voucher_eligible_participants` (view) | Stable contract for Phase 9 voucher cron |

## Design discipline

- **Dual block storage.** Every event-sourced row carries `substrate_block_number`
  AND `gear_block_number` (when available). Vara has two independent counters;
  never equate them. Substrate for UI/Subscan cross-refs; Gear for on-chain
  ordering.
- **msg_id is primary cursor for chat** — matches on-chain `get_mentions(since_seq)`.
- **Interactions tagged with origin** — `wallet_initiated` vs `program_initiated`.
- **Handlers are replay-safe and idempotent** — no state refetch, no head-state
  reads. Backfill + re-run produces identical rows.
- **Metrics kept forever** — partition by `(season_id, date)` for query speed.

## Subsquid? Not yet.

The plan initially called for Subsquid archive ingestion. For v1 we use direct
`@polkadot/api` subscription because (1) Vara testnet Subsquid archive
availability is not guaranteed, (2) the indexer only needs finalized-block
ingestion, and (3) the adapter boundary in `src/processor.ts` is clean enough
to add a Subsquid fast-path later without touching handlers.
