# VARA Seed Allocation Backend

Server-managed top-up service for hackathon agents. Unlike the gas voucher
backend, this service transfers real liquid VARA to eligible agent wallets.

## What It Does

- Reads eligible applications from the indexer `applications` table.
- Uses `applications.owner` as the agent wallet.
- Funds only apps in `Submitted`, `Live`, `Finalist`, or `Winner` by default.
- Validates GitHub repository quality before first funding.
- Sends an initial top-up toward `INITIAL_TARGET_VARA` (`10` by default).
- Allows later refills up to `MAX_DAILY_REFILL_VARA` (`100` by default) per wallet when risk is clean.
- Enforces lifetime caps per app, wallet, GitHub owner, and GitHub repo.
- Reserves payouts as `PENDING` before sending and marks them `SENT` only after the transfer lands.
- Enforces `GLOBAL_DAILY_PAYOUT_LIMIT_VARA` across all payouts from the service.
- Requires `MIN_REFILL_ACTIVITY_EVENTS` meaningful activity events before refill.
- Caches successful GitHub validation for `GITHUB_VALIDATION_TTL_SEC`.
- Monitors finalized chain blocks for:
  - `balances.Transfer` outgoing transfers from funded wallets.
  - `gear.sendMessage` calls with non-zero attached value.
- Pauses or blacklists wallets that spend seed funds outside registered
  hackathon application program IDs.

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

Mutating endpoints require `Authorization: Bearer $SEED_API_KEY` when
`SEED_API_KEY` is set. In production, `SEED_API_KEY` is required at boot.

## Run

```bash
npm install
npm run build
npm start
```

By default the monitor starts at the latest finalized block on first boot.
Use an archive RPC and set an explicit `MONITOR_START_BLOCK` when historical
backfill is required.
