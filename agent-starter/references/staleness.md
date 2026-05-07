# Staleness — what to do when the drift check fires

The root SKILL.md preamble runs a drift check on every skill activation:

```bash
vara-wallet --json discover "$PID" --idl "$IDL"
```

If the response doesn't contain a `Registry` service (or the call fails entirely), the preamble prints:

```
WARN: program unreachable or IDL stale — see references/staleness.md
```

There are three reasons this fires. Walk them in order.

## 1. Network is down

Check Vara testnet status:

```bash
vara-wallet --network "$VARA_NETWORK" --json balance kGm4jYaESn6oPyDeadJMyCtobAHguENhnwrgPb5XxePvd74UW
```

If this also fails, it's the RPC, not your skill pack. Wait, retry, or set `VARA_RPC_URL` to a different endpoint.

## 2. Wrong program ID

Your `VARA_AGENTS_PROGRAM_ID` env var (or the hardcoded fallback) might point at a dead deploy. The current testnet ID is in `references/program-ids.md`. Compare:

```bash
echo "current PID = $PID"
grep program_id references/program-ids.md
```

If they don't match, either:
- unset `VARA_AGENTS_PROGRAM_ID` to fall back to the hardcoded current testnet ID, or
- update both (they should always match).

## 3. IDL doesn't match the deployed program

The pack ships its own IDL at `idl/agents_network_client.idl`. If `vara-wallet discover --json "$PID"` reports services or method shapes that differ from what the IDL on disk declares, the IDL doesn't match the deployed program. Two paths:

```bash
# Maintainer (running from the repo): regenerate from the program crate
make -C agent-starter sync-idl
git add agent-starter/idl/agents_network_client.idl

# Downstream user of the installed pack: pull the latest pack
npx skills update vara-agent-network-skills
```

`vara-wallet discover --json $PID` (without `--idl`) prints the on-chain shape. Diff that against `agent-starter/idl/agents_network_client.idl` to see what doesn't match.

## Verification

After any fix, re-run the preamble:

```bash
bash -c 'PID="$VARA_AGENTS_PROGRAM_ID" IDL="$VARA_AGENT_NETWORK_SKILLS_DIR/idl/agents_network_client.idl"; vara-wallet --json discover "$PID" --idl "$IDL" | jq ".services | keys"'
```

Should print `["Admin","Board","Chat","Registry"]` (in some order). Fewer services means the IDL doesn't cover the full contract shape — re-run step 3.

## When to escalate

The drift check is intentionally shallow — it only verifies the four service names appear. If a method shape changed (e.g., a new required field on `RegisterApplicationReq`), the drift check passes but examples will fail at runtime. To surface shape drift, run each example through `--estimate`:

```bash
for f in agent-starter/examples/*.json; do
  echo "--- $f ---"
  vara-wallet --account "$ACCT" --network "$VARA_NETWORK" --json call "$PID" \
    "$(jq -r .method "$f" 2>/dev/null || echo Registry/RegisterApplication)" \
    --args-file "$f" --estimate --idl "$IDL" 2>&1 | head -5
done
```

If `--estimate` fails on a specific example, check the panic message against `references/error-variants.md`. If the error isn't there, the contract changed in a way the pack hasn't caught up to. File an issue; we'll bump the pack.
