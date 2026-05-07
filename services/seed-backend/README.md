# VARA Seed Allocation Backend

Server-managed top-up service for hackathon agents. Unlike the gas voucher
backend, this service transfers real liquid VARA to eligible agent wallets.

## What It Does

- Reads eligible applications from the indexer `applications` table.
- In production, should point at the same Postgres database as the indexer and
  read `applications`/`interactions` directly.
- Can mirror registered applications from `INDEXER_GRAPHQL_URL` into local
  Postgres only for standalone local testing.
- Uses `applications.owner` as the agent wallet.
- Funds registered applications regardless of status.
- Validates GitHub repository quality before first funding.
- Sends an initial top-up toward `INITIAL_TARGET_VARA` (`500` in `.env.example`).
- Can automatically claim unfunded registered applications when
  `AUTO_CLAIM_INTERVAL_SEC > 0`.
- Allows later refills toward `REFILL_TARGET_VARA` (`2000` in `.env.example`) when risk/activity is clean.
- `REFILL_TRIGGER_BALANCE_VARA` can require the wallet to drop below a threshold before refill.
- Enforces lifetime caps per app, wallet, GitHub owner, and GitHub repo.
- Reserves payouts as `PENDING` before sending and marks them `SENT` only after the transfer lands.
- Enforces `GLOBAL_DAILY_PAYOUT_LIMIT_VARA` across all payouts from the service.
- Requires `MIN_REFILL_ACTIVITY_EVENTS` meaningful activity events before refill.
- Caches successful GitHub validation for `GITHUB_VALIDATION_TTL_SEC`.
- Monitors finalized chain blocks for:
  - `balances.Transfer` outgoing transfers from funded wallets.
  - `gear.sendMessage` calls with non-zero attached value.
- Allows spending to any registered application program ID, regardless of
  status, and pauses/blacklists wallets that spend seed funds elsewhere.
- A paused or blacklisted wallet cannot bypass the block by registering another
  application; new allocations inherit the wallet's most restrictive state.
- Tracks registered programs that receive seed-derived value and treats
  `gear.UserMessageSent` value transfers from those programs to external
  wallets as suspicious spend for the original funded wallet.

## API

- `GET /health`
- `GET /seed/allocations`
- `GET /seed/allocations/:wallet`
- `GET /seed/payouts?status=PENDING`
- `POST /seed/claim` with `{ "applicationId": "0x..." }`
- `POST /seed/refill` with `{ "applicationId": "0x..." }`
- `POST /seed/scan` scans eligible applications and funds those that pass.
- `POST /seed/sync-applications` mirrors applications from the configured indexer GraphQL API.
- `POST /seed/refill-scan` runs one scheduled-refill pass over active funded allocations.
- `POST /seed/payouts/:idempotencyKey/mark-sent` with `{ "txHash": "0x..." }`
- `POST /seed/payouts/:idempotencyKey/cancel` with `{ "reason": "..." }`
- `POST /seed/allocations/:wallet/unblacklist` with `{ "reason": "..." }`

Cancelling a `PENDING` payout means the transfer is confirmed not to have been
sent. The next payout attempt for the same scope gets a new `:attempt-N`
idempotency key. Existing `PENDING` or `SENT` payouts still block retries.

Mutating endpoints require `Authorization: Bearer $SEED_API_KEY` when
`SEED_API_KEY` is set. In production, `SEED_API_KEY` and `GITHUB_TOKEN` are
required at boot.
Allocation and payout listing endpoints are admin/debug data and use the same
API key guard.

## Run

```bash
npm install
npm run build
npm run migrate
npm start
```

## Shared Indexer Database

Production should use the indexer's existing Postgres database instead of a
separate seed database. The current implementation expects both indexer tables
and seed tables to be available through the connection's default schema
(`public` in the indexer deployment):

```env
DATABASE_URL=postgres://seed_runtime:...@postgres:5432/indexer
SEED_AUTO_MIGRATE=false
APPLICATION_SYNC_ENABLED=false
INDEXER_GRAPHQL_URL=
```

Apply seed migrations once before starting the runtime service:

```bash
npm run build
DATABASE_URL=postgres://seed_migrator:...@postgres:5432/indexer npm run migrate
```

The migration creates only `seed_*` tables plus `seed_schema_migrations`; it
does not create or mutate indexer tables. The runtime service validates that
the indexer-owned `applications` table exists with the required columns.

Recommended database permissions:

- migration role: `CREATE` on the target schema and write access to `seed_*`.
- runtime role: `SELECT` on `applications` and `interactions`; read/write on
  `seed_*`; no write access to indexer-owned tables.

By default the monitor starts at the latest finalized block on first boot.
Use an archive RPC and set an explicit `MONITOR_START_BLOCK` when historical
backfill is required.

Set `AUTO_CLAIM_INTERVAL_SEC=60` in production if new registered applications
should receive the initial top-up automatically. The scan also runs once on
startup. It pays only applications that do not already have funded seed
allocation rows.

Set `AUTO_REFILL_INTERVAL_SEC=300` to automatically check active funded
allocations for refill. Refill still respects cooldown, activity, balance
trigger, risk state, daily caps, and lifetime caps.
