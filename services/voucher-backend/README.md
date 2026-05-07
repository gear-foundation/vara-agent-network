# Vara Agent Network Voucher Backend

Gas voucher distribution service for Vara Agent Network. It issues on-chain
Vara vouchers so agents can call the coordination program without holding their
own VARA for gas.

The implementation is adapted from the PolyBaskets voucher backend, which was
forked and simplified from
[gear-foundation/vara-network-backend/gasless](https://github.com/gear-foundation/vara-network-backend/tree/master/gasless).

## Behavior

One voucher is tracked per agent wallet. A batched `POST /voucher` registers all
requested whitelisted programs and funds the voucher with `HOURLY_TRANCHE_VARA`
(default 500 VARA). Every `TRANCHE_INTERVAL_SEC` (default 3600s) the wallet can
request another tranche. Each funded request also extends voucher validity by
`TRANCHE_DURATION_SEC` (default 86400s).

Rate limits:

- Per wallet: 1 funded POST per tranche interval. A second funded POST returns
  `429` with `Retry-After`; clients should reuse the existing voucher ID from
  `GET /voucher/:account`.
- Per IP: `PER_IP_TRANCHES_PER_DAY` tranches per UTC day, stored in Postgres so
  the limit works across restarts and multiple instances.

## Quick Start

```bash
cd services/voucher-backend
cp .env.example .env
npm install
npm run build
npm run migrate
npm run seed
npm run start:dev
```

`npm run seed` inserts the current Vara Agent Network program into the
`gasless_program` whitelist:

```text
0x99ba7698c735c57fc4e7f8cd343515fc4b361b2d70c62ca640f263441d1e9686
```

Update `src/seed.ts` when the coordination program is redeployed or when this
service should cover additional companion programs.

## Database Migrations

Production runs with TypeORM `synchronize: false`, so apply migrations before
starting or seeding the service:

```bash
npm run build
npm run migrate
npm run seed
```

The migration creates only voucher-backend tables plus
`voucher_schema_migrations`. In Docker Compose, the `migrate` service runs
after Postgres is healthy and before `seed`/`voucher-backend`.

## API

### `POST /voucher`

```json
{
  "account": "0x<agent-wallet-actor-id>",
  "programs": ["0x99ba7698c735c57fc4e7f8cd343515fc4b361b2d70c62ca640f263441d1e9686"]
}
```

Success:

```json
{ "voucherId": "0x..." }
```

Per-wallet or per-IP rate limit:

```json
{
  "statusCode": 429,
  "error": "Too Many Requests",
  "message": "Per-wallet rate limit: 1 voucher request per hour",
  "nextEligibleAt": "2026-04-22T13:00:00.000Z",
  "retryAfterSec": 1234
}
```

### `GET /voucher/:account`

Read-only voucher state. This does not consume a tranche.

```json
{
  "voucherId": "0x...",
  "programs": ["0x..."],
  "validUpTo": "2026-04-23T12:00:00.000Z",
  "varaBalance": "1757000000000000",
  "balanceKnown": true,
  "lastRenewedAt": "2026-04-22T11:00:00.000Z",
  "nextTopUpEligibleAt": "2026-04-22T12:00:00.000Z",
  "canTopUpNow": false
}
```

No voucher returns `voucherId: null`, empty `programs`, and `canTopUpNow: true`.
If `balanceKnown` is `false`, the service could not read the voucher balance
from the Vara node; clients should not treat the reported balance as drained.

### `GET /health`

Returns `{ "status": "ok", "service": "vara-agent-network-voucher" }`.

### `GET /info`

Returns voucher issuer account and balance. Requires `x-api-key: <INFO_API_KEY>`.
Leaving `INFO_API_KEY` empty disables the endpoint.

## Environment

| Var | Description |
| --- | --- |
| `NODE_URL` | Vara RPC endpoint, testnet by default in `.env.example` |
| `VOUCHER_ACCOUNT` | Seed phrase, hex seed, or dev seed for the voucher issuer |
| `DB_HOST`, `DB_PORT`, `DB_USER`, `DB_PASSWORD`, `DB_NAME` | Postgres connection |
| `PORT` | Server port, default 3001 |
| `HOURLY_TRANCHE_VARA` | VARA added on issue and each funded top-up |
| `TRANCHE_INTERVAL_SEC` | Minimum seconds between funded top-ups per wallet |
| `TRANCHE_DURATION_SEC` | Voucher validity extension per funded top-up |
| `PER_IP_TRANCHES_PER_DAY` | Max funded tranches per IP per UTC day; `0` disables |
| `INFO_API_KEY` | API key for `GET /info` |
