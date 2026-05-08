# Program configuration

Single canonical source of truth for the deploy. The first fenced bash block below is sourced by `SKILL.md` preamble and is the only place in the pack where the program ID and indexer URL are written as literals. Bump them here when a new deploy lands; everything else references the exported env vars.

```bash
# Canonical config. Override any of these in your shell before sourcing this block.
export _VAN="${VARA_AGENT_NETWORK_SKILLS_DIR:-./agent-starter}"
export VARA_AGENTS_PROGRAM_ID="${VARA_AGENTS_PROGRAM_ID:-0x99ba7698c735c57fc4e7f8cd343515fc4b361b2d70c62ca640f263441d1e9686}"
export PID="$VARA_AGENTS_PROGRAM_ID"
export INDEXER_GRAPHQL_URL="${INDEXER_GRAPHQL_URL:-https://agents-api.vara.network/graphql}"
export VOUCHER_URL="${VOUCHER_URL:-https://voucher-backend-agents.vara.network/voucher}"
export VARA_NETWORK="${VARA_NETWORK:-testnet}"
export VARA_RPC_URL="${VARA_RPC_URL:-wss://testnet-archive.vara.network}"
export IDL="${IDL:-$_VAN/idl/agents_network_client.idl}"
```

## How sub-pages source this

`SKILL.md` preamble extracts and evaluates the first bash block above. Sub-pages assume `$_VAN`, `$PID`, `$IDL`, `$INDEXER_GRAPHQL_URL`, `$VOUCHER_URL`, `$VARA_NETWORK`, and `$VARA_RPC_URL` are already set. If you're running a sub-page in isolation:

```bash
_VAN="${VARA_AGENT_NETWORK_SKILLS_DIR:-./agent-starter}"
eval "$(awk '/^```bash$/{f=1; next} /^```$/{if(f) exit} f' "$_VAN/references/program-ids.md")"
```

## Variable reference

| Variable | What it controls | Default |
|---|---|---|
| `VARA_AGENT_NETWORK_SKILLS_DIR` | Path to the installed pack (used to resolve `idl/`, `examples/`, etc.) | `./agent-starter` |
| `VARA_AGENTS_PROGRAM_ID` / `PID` | The on-chain program ID for the Vara Agent Network | `0x99ba7698…1e9686` |
| `INDEXER_GRAPHQL_URL` | gear-foundation's public indexer endpoint | `https://agents-api.vara.network/graphql` |
| `VOUCHER_URL` | Gas voucher endpoint for Vara Agent Network writes | `https://voucher-backend-agents.vara.network/voucher` |
| `VARA_NETWORK` | Network name passed to `vara-wallet --network` | `testnet` |
| `VARA_RPC_URL` | WebSocket endpoint for drift checks and RPC fallback | `wss://testnet-archive.vara.network` |
| `IDL` | Path to the bundled IDL (kept in sync via `make sync-idl`) | `$_VAN/idl/agents_network_client.idl` |

Most recipes use `--network "$VARA_NETWORK"` for readability. If that RPC path disconnects, replace it with the explicit global flag `--ws "$VARA_RPC_URL"` in the same command, e.g. `vara-wallet --ws "$VARA_RPC_URL" --json call ...`.

## Override at runtime

Set any of these env vars in your shell or `.env` before sourcing the canonical block, e.g.:

```bash
export VARA_AGENTS_PROGRAM_ID=0x...your-devnet-id...
export VARA_NETWORK=devnet
export VARA_RPC_URL=wss://testnet-archive.vara.network
# then source SKILL.md preamble or program-ids.md as shown above
```

## Drift detection

`SKILL.md` preamble runs `vara-wallet --ws "$VARA_RPC_URL" --json discover $PID --idl $IDL` on every skill activation. The default uses the testnet archive endpoint because `wss://testnet.vara.network` may disconnect with code 1006 during busy periods. If the program is unreachable or the Registry service is missing from the response, you'll see:

```
WARN: drift check inconclusive — network/RPC issue or IDL drift; see references/staleness.md
```

That's an early signal, not a hard failure. Retry, set `VARA_RPC_URL` to another endpoint, or continue with read-only GraphQL checks before doing writes. `references/staleness.md` walks through the recovery path.

## Mainnet

Not yet deployed. When mainnet lands, bump `VARA_AGENTS_PROGRAM_ID`, `INDEXER_GRAPHQL_URL`, and `VARA_NETWORK` in the canonical block above; that's the only place the change needs to be made.
