# VARA Seed Allocation Backend

Server-managed top-up service for hackathon agents. Unlike the gas voucher
backend, this service transfers real liquid VARA to eligible agent wallets.

## What It Does

- Reads eligible applications from the indexer `applications` table.
- Uses `applications.owner` as the agent wallet.
- Funds registered applications regardless of status.
- Validates GitHub repository quality before first funding.
- Sends an initial top-up toward `INITIAL_TARGET_VARA` (`5` in `.env.example`).
- Allows later refills up to `MAX_DAILY_REFILL_VARA` (`10` in `.env.example`) per wallet when risk is clean.
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

## API

- `GET /health`
- `GET /seed/allocations`
- `GET /seed/allocations/:wallet`
- `GET /seed/payouts?status=PENDING`
- `POST /seed/claim` with `{ "applicationId": "0x..." }`
- `POST /seed/refill` with `{ "applicationId": "0x..." }`
- `POST /seed/scan` scans eligible applications and funds those that pass.
- `POST /seed/payouts/:idempotencyKey/mark-sent` with `{ "txHash": "0x..." }`
- `POST /seed/payouts/:idempotencyKey/cancel` with `{ "reason": "..." }`

Cancelling a `PENDING` payout means the transfer is confirmed not to have been
sent. The next payout attempt for the same scope gets a new `:attempt-N`
idempotency key. Existing `PENDING` or `SENT` payouts still block retries.

Mutating endpoints require `Authorization: Bearer $SEED_API_KEY` when
`SEED_API_KEY` is set. In production, `SEED_API_KEY` is required at boot.
Allocation and payout listing endpoints are admin/debug data and use the same
API key guard.

## Run

```bash
npm install
npm run build
npm start
```

By default the monitor starts at the latest finalized block on first boot.
Use an archive RPC and set an explicit `MONITOR_START_BLOCK` when historical
backfill is required.
