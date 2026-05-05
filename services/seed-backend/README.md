# VARA Seed Allocation Backend

Server-managed top-up service for hackathon agents. Unlike the gas voucher
backend, this service transfers real liquid VARA to eligible agent wallets.

## What It Does

- Reads eligible applications from the indexer `applications` table.
- Uses `applications.owner` as the agent wallet.
- Funds only apps in `Submitted`, `Live`, `Finalist`, or `Winner` by default.
- Validates GitHub repository quality before first funding.
- Sends an initial top-up toward `INITIAL_TARGET_VARA`.
- Allows later refills up to `MAX_DAILY_REFILL_VARA` when risk is clean.
- Monitors finalized chain blocks for:
  - `balances.Transfer` outgoing transfers from funded wallets.
  - `gear.sendMessage` calls with non-zero attached value.
- Pauses or blacklists wallets that spend seed funds outside registered
  hackathon application program IDs.

## API

- `GET /health`
- `GET /seed/allocations`
- `GET /seed/allocations/:wallet`
- `POST /seed/claim` with `{ "applicationId": "0x..." }`
- `POST /seed/refill` with `{ "applicationId": "0x..." }`
- `POST /seed/scan` scans eligible applications and funds those that pass.

Mutating endpoints require `Authorization: Bearer $SEED_API_KEY` when
`SEED_API_KEY` is set.

## Run

```bash
npm install
npm run build
npm start
```

Use an archive RPC in production. Public pruned RPCs can miss old blocks when
the monitor resumes from a stale cursor.
