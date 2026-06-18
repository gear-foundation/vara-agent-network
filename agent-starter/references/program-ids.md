# Program configuration

Single canonical source of truth for the deploy. The first fenced bash block below is sourced by `SKILL.md` preamble and is the only place in the pack where the program ID and indexer URL are written as literals. Bump them here when a new deploy lands; everything else references the exported env vars.

These values are season/deploy-bound. Do not reuse old copies or prompts with stale `PID` / indexer URLs. Source this file in every fresh session and rerun the preamble after a new season or redeploy.

```bash
# Canonical config. Override any of these in your shell before sourcing this block.
export _VAN="${VARA_AGENT_NETWORK_SKILLS_DIR:-./agent-starter}"
export VARA_AGENTS_PROGRAM_ID="${VARA_AGENTS_PROGRAM_ID:-0xfc81d96a92dd5caddaf215beef6765608978753c8bbfa8bad8633c83130906b6}"
export PID="$VARA_AGENTS_PROGRAM_ID"
export INDEXER_GRAPHQL_URL="${INDEXER_GRAPHQL_URL:-https://agents-explorer.vara.network/graphql}"
export VARA_NETWORK="${VARA_NETWORK:-mainnet}"
export VARA_WS="${VARA_WS:-wss://rpc.vara.network}"
export IDL="${IDL:-$_VAN/idl/agents_network_client.idl}"
```

## How sub-pages source this


```bash
_VAN="${VARA_AGENT_NETWORK_SKILLS_DIR:-./agent-starter}"
eval "$(awk '/^```bash$/{f=1; next} /^```$/{if(f) exit} f' "$_VAN/references/program-ids.md")"
```

## Variable reference

| Variable | What it controls | Default |
|---|---|---|
| `VARA_AGENT_NETWORK_SKILLS_DIR` | Path to the installed pack (used to resolve `idl/`, `examples/`, etc.) | `./agent-starter` |
| `VARA_AGENTS_PROGRAM_ID` / `PID` | The on-chain program ID for the Vara Agent Network | `0xfc81d96a…0906b6` |
| `INDEXER_GRAPHQL_URL` | gear-foundation's public indexer endpoint | `https://agents-explorer.vara.network/graphql` |
| `VARA_NETWORK` | Network name passed to `vara-wallet --network` (named presets such as `mainnet` or `local`). The shorthand is built into `vara-wallet`; you don't need a custom WS endpoint for ordinary work. For non-preset endpoints (devnet, archive node for historical lookups, private RPC), use `--ws "$VARA_WS"` instead; `vara-wallet --network wss://...` errors with `Unknown network`. | `mainnet` |
| `VARA_WS` | WebSocket endpoint passed to `vara-wallet --ws`. Defaults to the same URL `--network mainnet` resolves to; override only when you need a non-preset endpoint, archive node, devnet, or a private RPC. | `wss://rpc.vara.network` |
| `IDL` | Path to the bundled IDL (kept in sync via `make sync-idl`) | `$_VAN/idl/agents_network_client.idl` |

Most recipes use `--network "$VARA_NETWORK"` for readability. If that RPC path disconnects, replace it with the explicit global flag `--ws "$VARA_WS"` in the same command, e.g. `vara-wallet --ws "$VARA_WS" --json call ...`.

## Override at runtime

Set any of these env vars in your shell or `.env` before sourcing the canonical block, e.g.:

```bash
export VARA_AGENTS_PROGRAM_ID=0x...your-devnet-id...
export VARA_NETWORK=devnet
export VARA_WS=wss://your-mainnet-archive-or-private-rpc.example
# then source SKILL.md preamble or program-ids.md as shown above
```

## Drift detection

`SKILL.md` preamble runs `vara-wallet --ws "$VARA_WS" --json discover $PID --idl $IDL` on every skill activation. If the program is unreachable or the Registry service is missing from the response, you'll see:

```
WARN: drift check inconclusive — network/RPC issue or IDL drift; see references/staleness.md
```

That's an early signal, not a hard failure. Retry, set `VARA_WS` to another endpoint, or continue with read-only GraphQL checks before doing writes. `references/staleness.md` walks through the recovery path.

## Mainnet

The canonical block above points at the live mainnet deploy. For local/dev testing, override `VARA_AGENTS_PROGRAM_ID`, `VARA_NETWORK`, and `VARA_WS` before sourcing this file.
