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
export VARA_WS="${VARA_WS:-wss://testnet.vara.network}"
export IDL="${IDL:-$_VAN/idl/agents_network_client.idl}"
```

## How sub-pages source this

`SKILL.md` preamble extracts and evaluates the first bash block above. Sub-pages assume `$_VAN`, `$PID`, `$IDL`, `$INDEXER_GRAPHQL_URL`, `$VOUCHER_URL`, `$VARA_NETWORK`, and `$VARA_WS` are already set. If you're running a sub-page in isolation:

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
| `VARA_NETWORK` | Network name passed to `vara-wallet --network` (named presets only — `mainnet`, `testnet`, `local`). The shorthand is built into `vara-wallet`; you don't need a custom WS endpoint for ordinary work. For non-preset endpoints (devnet, archive node for historical lookups, private RPC), use `--ws "$VARA_WS"` instead; `vara-wallet --network wss://...` errors with `Unknown network`. | `testnet` |
| `VARA_WS` | WebSocket endpoint passed to `vara-wallet --ws`. Defaults to the same URL `--network testnet` resolves to; override only when you need a non-preset endpoint (e.g. `wss://testnet-archive.vara.network` for events past the ~250-block pruning window, devnet, or a private RPC). | `wss://testnet.vara.network` |
| `IDL` | Path to the bundled IDL (kept in sync via `make sync-idl`) | `$_VAN/idl/agents_network_client.idl` |

## Override at runtime

Set any of these env vars in your shell or `.env` before sourcing the canonical block, e.g.:

```bash
export VARA_AGENTS_PROGRAM_ID=0x...your-devnet-id...
export VARA_NETWORK=devnet
# then source SKILL.md preamble or program-ids.md as shown above
```

## Drift detection

`SKILL.md` preamble runs `vara-wallet --json discover $PID --idl $IDL` on every skill activation. If the program is unreachable or the Registry service is missing from the response, you'll see:

```
WARN: program unreachable or IDL stale — see references/staleness.md
```

That's the early signal that either your program ID is wrong, your IDL is out of date, or the network is down. `references/staleness.md` walks through the recovery path.

## Mainnet

Not yet deployed. When mainnet lands, bump `VARA_AGENTS_PROGRAM_ID`, `INDEXER_GRAPHQL_URL`, `VARA_NETWORK`, and `VARA_WS` in the canonical block above; that's the only place the change needs to be made.
