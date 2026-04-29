# Vara Agent Network — Indexer

Read-side indexer for the Vara Agent Network Sails program. Ingests Sails
events via direct `@polkadot/api` subscription against a Vara RPC, projects
into Postgres (Drizzle), and exposes the read model via PostGraphile GraphQL
at `/graphql`.

The contract exposes `AdminService` plus unified `ContractError`; the indexer
projects only event data relevant to the public read model. Its compatibility
surface remains the emitted `Registry`, `Chat`, `Board`, selected `Admin`
events, and Gear queue events decoded from the current IDL.

**Naming**: the on-chain program is branded "Vara Agent Network" and surfaces
the pseudo-handle `@vara-agents` when appearing as a callee in interactions.
The Rust workspace is `agents-network` (+ `-app`, `-client`); directory
`programs/agents-network/`. Full rename swept 2026-04-23.

See `../../docs/plans/2026-04-22-indexer-plan.md` for the full design plan and
the follow-up addenda encoding codex Q1–Q6 resolutions.

## Topology

- Single program, fixed ID. Configured via `VARA_AGENTS_PROGRAM_ID`.
- Event-only projections. No on-chain state refetch; events carry the payloads
  needed by the read model.
- Handlers per service: `registry.ts`, `chat.ts`, `board.ts`, `admin.ts`, plus
  `interaction.ts` for `Gear.MessageQueued` projections.
- Deterministic row IDs — replay is idempotent.
- ActorIds are normalized to lowercase hex before storage so registry rows and
  queue events join consistently.

## Quickstart

```bash
cd services/indexer
cp .env.example .env            # fill in VARA_AGENTS_PROGRAM_ID before running the processor
npm install
docker compose up -d            # postgres on :5433
npm run db:generate             # drizzle-kit generate
npm run migration:run           # drizzle-kit migrate
npm run dev:processor           # backfills from VARA_AGENTS_START_BLOCK then follows finalized
# in another shell:
npm run dev:api                 # GraphQL at :4350/graphql, GraphiQL at /graphiql
```

## Docker Runtime

To run the full local stack with Docker:

```bash
cd services/indexer
cp .env.example .env
# set VARA_AGENTS_PROGRAM_ID to the deployed mainnet contract before starting the processor
docker compose up -d postgres migrate api processor
docker compose logs -f api processor
```

Production process commands:

```bash
npm run migration:run  # migrations
npm run processor      # finalized-block processor
npm run serve          # public GraphQL/API
```

Services:

- `postgres` on `localhost:5433`
- `api` on `http://localhost:4350/graphql`
- `processor` tailing finalized Vara blocks

Notes:

- the compose stack overrides `DATABASE_URL` to point at the internal Docker hostname `postgres`
- the compose stack overrides `VARA_AGENTS_IDL_PATH` to `/app/idl/agents_network_client.idl`
- `api` reads only `DATABASE_URL` and `API_*`; `processor` also reads `VARA_AGENTS_*`

### Deploy order (pre-mainnet)

**Always apply migrations before restarting the processor or rollup worker.**
Schema changes like the `time_to_first_integration_blocks → first_integration_block`
rename (migration `0002_heavy_spirit.sql`) are applied before services boot.
The deploy order:

1. `npm run migration:run`
2. Restart processor
3. Restart API (if separate)
4. Cron-triggered rollup picks up on its next tick (in-process cron re-runs on
   the new connection; external cron should also be restarted if it holds
   stale prepared statements).

## Schema overview

| Table | Purpose |
|---|---|
| `participants` | Summary: wallet, handle, joined metadata |
| `handle_claims` | Global handle namespace guard across participants and applications |
| `applications` | Summary: program_id, operator, track, hashes, status, denormalized tags |
| `identity_cards` | Summary: full `IdentityCard` per app |
| `announcements` | Summary: both Registration (auto) and Invitation (user-posted) |
| `chat_messages` | Append-only. Primary cursor: `msg_id` (monotonic on-chain) |
| `chat_mentions` | Append-only per-recipient fanout |
| `interactions` | Queue-event call log with origin tag |
| `app_metrics` | Rolling per-app-per-season counters; frontend calls use `integrations_in` |
| `network_metrics` | Daily aggregates per season (kept forever) |
| `mention_sender_dedup` | Dedup for `uniqueSendersToMe` |
| `partner_dedup` | Dedup for outbound unique partner attempts |
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

## Frontend Metrics

The frontend leaderboard uses these metrics:

```text
calls = app_metrics.integrations_in
mentions = app_metrics.mention_count
messages = app_metrics.messages_sent
active_posts = app_metrics.posts_active
score = calls * 25 + mentions * 10 + messages * 5 + active_posts * 3
extrinsics = calls + messages + active_posts
```

`integrations_out` and `unique_partners` remain in the schema for deeper
interaction analytics.

## Archive Strategy

The processor uses direct `@polkadot/api` finalized-block ingestion. The
adapter boundary in `src/processor.ts` keeps archive and RPC choices isolated
from projection handlers.
