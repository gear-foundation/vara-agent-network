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
- Handles the X social reward campaign: one claim per registered
  participant wallet, one claim per tweet ID, and one claim per X username.
- Optionally verifies an X repost through the X API when
  `SOCIAL_X_REQUIRED_REPOST_TWEET_ID` and `SOCIAL_X_BEARER_TOKEN` are set.
  Without those settings, it validates only URL shape, tweet snowflake
  timestamp, campaign freshness, participant age, and rate limits before
  queueing the `100 VARA` reward.

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
- `GET /social/x-claim/:wallet` returns the participant's current X reward claim, if any.
- `POST /social/x-claim` with `{ "wallet": "...", "tweetUrl": "https://x.com/.../status/..." }`.

Cancelling a `PENDING` payout means the transfer is confirmed not to have been
sent. The next payout attempt for the same scope gets a new `:attempt-N`
idempotency key. Existing `PENDING` or `SENT` payouts still block retries.

Mutating endpoints require `Authorization: Bearer $SEED_API_KEY` when
`SEED_API_KEY` is set. In production, `SEED_API_KEY` and `GITHUB_TOKEN` are
required at boot.
Allocation and payout listing endpoints are admin/debug data and use the same
API key guard.

The social reward endpoint should normally be reached through the frontend
proxy so `SEED_API_KEY` is never exposed to the browser. A submitted social
claim is stored as `PENDING`; the worker pays it later when
`SOCIAL_X_PAYOUT_INTERVAL_SEC > 0` and hourly/daily budget remains.

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

The migration creates only `seed_*`/`social_x_*` tables plus `seed_schema_migrations`; it
does not create or mutate indexer tables. The runtime service validates that
the indexer-owned `applications` and `participants` tables exist with the
required columns.

Recommended database permissions:

- migration role: `CREATE` on the target schema and write access to `seed_*`/`social_x_*`.
- runtime role: `SELECT` on `applications`, `participants`, and `interactions`; read/write on
  `seed_*`/`social_x_*`; no write access to indexer-owned tables.

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

## Social X Reward Limits

Defaults are intentionally conservative:

- `SOCIAL_X_REWARD_VARA=100`
- `SOCIAL_X_PARTICIPANT_MIN_AGE_SEC=900`
- `SOCIAL_X_MAX_PAYOUTS_PER_HOUR=10`
- `SOCIAL_X_MAX_PAYOUTS_PER_DAY=50`
- `SOCIAL_X_GLOBAL_DAILY_LIMIT_VARA=5000`
- `SOCIAL_X_IP_ATTEMPTS_PER_HOUR=5`
- `SOCIAL_X_IP_ATTEMPTS_PER_DAY=20`
- `SOCIAL_X_SUBNET_CLAIMS_PER_DAY=30`
- `SOCIAL_X_PAYOUT_INTERVAL_SEC=60`
- `SOCIAL_X_CAMPAIGN_START_ISO=2026-05-10T00:00:00.000Z`
- `SOCIAL_X_BEARER_TOKEN=` optional X API v2 bearer token for repost verification
- `SOCIAL_X_REQUIRED_REPOST_TWEET_ID=` optional campaign post tweet ID that claimants must repost
- `SOCIAL_X_API_BASE_URL=https://api.twitter.com/2`

These limits mean a bot can create pending rows only within tight submission
limits, and liquid VARA leaves the service gradually through the payout queue.
