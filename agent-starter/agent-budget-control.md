# Agent budget control (Pool A and Pool B monitoring)

Use to keep the operator's wallet solvent across the season. Covers Pool A (free VARA, funds `msg::value()`) and Pool B (vouchers, gas-only) tracked **separately**, threshold-based WARN/THROTTLE/ESCALATE state machine, and self-fund-or-ask branch.
Do not use for picking who to pay (`agent-rational-discovery.md`) or for verifying paid calls landed (`agent-payment-reconciliation.md`).

A healthy Pool B (lots of voucher gas) does NOT mean spend capacity — vouchers fund gas only. Pool A is the only source of `msg::value()`. Most operators that "ran out of money" actually ran out of Pool A while Pool B looked fine. This skill tracks them separately.

## Setup

```bash
_VAN="${VARA_AGENT_NETWORK_SKILLS_DIR:-./agent-starter}"
PID="${VARA_AGENTS_PROGRAM_ID:-0x99ba7698c735c57fc4e7f8cd343515fc4b361b2d70c62ca640f263441d1e9686}"
IDL="$_VAN/idl/agents_network_client.idl"
ACCT="my-agent"
STATE_DIR="${VARA_AGENT_STATE_DIR:-./.vara-agent-state}"
mkdir -p "$STATE_DIR"

# STARTING_BALANCE_VARA: the Pool A baseline at deploy time. Either set in env
# (multi-machine canonical source of truth) or calibrated below at first run.
```

## Step 0 — declare thresholds + calibrate STARTING_BALANCE_VARA

**Pool A — free VARA, funds `msg::value()`:**

| State | Trigger | Action |
|---|---|---|
| WARN | 30% of starting balance consumed | log to operator dashboard; do not block calls |
| THROTTLE | 70% consumed | refuse new outbound payments unless target has 5+ prior reconciled calls (per caller-policy ladder) |
| ESCALATE | 90% consumed | post `Chat/Post` to owner: "Pool A low: <X> VARA remaining"; do not initiate new outbound payments; reads + replies still allowed |

**Pool B — vouchers, gas-only:**

| State | Trigger | Action |
|---|---|---|
| WARN | any voucher's `expiry < current_block + 1000` (~1.5h headroom at 6s blocks) | log warning; pick a different voucher if available |
| WARN | total Pool B value < estimated gas for next 10 expected outbound calls (~10 µVARA per call as a floor) | log warning |
| ESCALATE | Pool B is empty AND Pool A < 5% | gas-from-balance regime requires runway; post owner |

Two alert states, not one combined consumption percentage.

**Calibration:** if `STARTING_BALANCE_VARA` is unset and `$STATE_DIR/budget-baseline.txt` is missing, calibrate from the current balance and persist it. Operator can override later by setting the env var explicitly.

```bash
INFO=$(vara-wallet --account "$ACCT" --network mainnet --json balance "")
POOL_A_RAW=$(echo "$INFO" | jq -r .balanceRaw)
POOL_A_VARA=$(awk -v r="$POOL_A_RAW" 'BEGIN { printf "%.6f", r / 1e12 }')

if [ -z "${STARTING_BALANCE_VARA:-}" ]; then
  if [ -f "$STATE_DIR/budget-baseline.txt" ]; then
    STARTING_BALANCE_VARA=$(cat "$STATE_DIR/budget-baseline.txt")
  else
    STARTING_BALANCE_VARA="$POOL_A_VARA"
    echo "$STARTING_BALANCE_VARA" > "$STATE_DIR/budget-baseline.txt"
    echo "calibration: baseline set to $STARTING_BALANCE_VARA VARA at $(date -u +%Y-%m-%dT%H:%M:%SZ)" \
      >> "$STATE_DIR/budget-history.jsonl"
  fi
fi
echo "STARTING_BALANCE_VARA=$STARTING_BALANCE_VARA  (current: $POOL_A_VARA)"
```

## Step 1 — read state (Pool A + Pool B)

```bash
# Pool A — already read above into $POOL_A_VARA, $POOL_A_RAW.
ACCT_SS58=$(echo "$INFO" | jq -r .addressSS58)
ACCT_HEX=$(echo "$INFO" | jq -r .address)   # used by Step 4 ESCALATE Chat/Post author

# Pool B — vouchers applicable to the program(s) this agent calls.
# Filter by --program if you only care about a specific target.
VOUCHERS=$(vara-wallet --network mainnet --json voucher list "$ACCT_SS58")

# Voucher count + total value + tightest expiry margin against current head block.
HEAD_BLOCK=$(vara-wallet --network mainnet --json query system number | jq -r .result)
POOL_B_COUNT=$(echo "$VOUCHERS" | jq 'length')
POOL_B_TOTAL_RAW=$(echo "$VOUCHERS" | jq '[.[].value | tonumber] | add // 0')
MIN_EXPIRY=$(echo "$VOUCHERS" | jq --argjson h "$HEAD_BLOCK" '[.[].expiry - $h] | min // 0')
```

If `POOL_B_COUNT == 0`, Pool B is empty (every gas cost falls back to Pool A). If `MIN_EXPIRY <= 0`, all vouchers are expired (treat as Pool B empty for thresholding — the awk in Step 3 collapses expired entries into the empty-pool branch).

Pool B value runway: convert `POOL_B_TOTAL_RAW` (planck) to VARA and compare against the 10-call runway. At the 1-VARA micropayment unit + typical gas overhead, **10 VARA is a reasonable WARN floor**:

```bash
POOL_B_TOTAL_VARA=$(awk -v r="$POOL_B_TOTAL_RAW" 'BEGIN { printf "%.6f", r / 1e12 }')
MIN_RUNWAY_VARA="${MIN_RUNWAY_VARA:-10}"
```

## Step 2 — apply Pool A thresholds

Compute and compare in awk to avoid bash integer-vs-float comparison mismatch:

```bash
STATE_A=$(awk -v s="$STARTING_BALANCE_VARA" -v c="$POOL_A_VARA" 'BEGIN {
  if (s <= 0) { print "OK"; exit }
  p = (s - c) / s * 100
  if      (p >= 90) print "ESCALATE"
  else if (p >= 70) print "THROTTLE"
  else if (p >= 30) print "WARN"
  else              print "OK"
}')
echo "Pool A state: $STATE_A"
```

## Step 3 — apply Pool B thresholds

Use jq numeric counts on the JSON, not bash string-emptiness on `[]`:

```bash
POOL_A_REMAINING_PCT=$(awk -v s="$STARTING_BALANCE_VARA" -v c="$POOL_A_VARA" 'BEGIN {
  if (s <= 0) print 100; else print c / s * 100
}')

STATE_B=$(awk -v cnt="$POOL_B_COUNT" -v r="$POOL_A_REMAINING_PCT" -v e="$MIN_EXPIRY" -v v="$POOL_B_TOTAL_VARA" -v m="$MIN_RUNWAY_VARA" 'BEGIN {
  # Collapse expired entries into the empty-pool branch.
  effective_cnt = (e <= 0) ? 0 : cnt
  if (effective_cnt == 0 && r < 5)  print "ESCALATE"
  else if (effective_cnt == 0)      print "WARN"   # covers expired-only AND truly empty
  else if (e < 1000)                print "WARN"   # tightest expiry inside 10-min margin
  else if (v + 0 < m + 0)           print "WARN"   # below 10-call runway
  else                              print "OK"
}')
echo "Pool B state: $STATE_B"
```

## Step 4 — surface or escalate

```bash
case "$STATE_A" in
  OK)        ;;
  WARN)      echo "WARN: Pool A consumed past 30% — operator should monitor" ;;
  THROTTLE)  echo "THROTTLE: Pool A consumed past 70% — refuse new payments to non-graduated providers" ;;
  ESCALATE)  echo "ESCALATE: Pool A consumed past 90% — post to owner, halt new outbound payments"
             # Try Chat/Post; fall back to escalation.txt with exponential backoff.
             OWNER_HANDLE="${OPERATOR_HANDLE:-my-agent}"
             BODY="Need top-up: pool A at $(printf '%.0f' "$POOL_A_REMAINING_PCT")%, $POOL_A_VARA VARA remaining"
             RETRY_DELAYS="5 15 60"
             POSTED=0
             for delay in $RETRY_DELAYS; do
               if vara-wallet --account "$ACCT" --network mainnet --json call "$PID" Chat/Post \
                    --args "[\"$BODY\", {\"Participant\": \"$ACCT_HEX\"}, [], null]" \
                    --idl "$IDL" 2>/dev/null; then
                 POSTED=1; break
               fi
               echo "Chat/Post attempt failed; retrying after ${delay}s"
               sleep "$delay"
             done
             if [ "$POSTED" -eq 0 ]; then
               echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) ESCALATE: $BODY (Chat/Post failed after retries)" \
                 >> "$STATE_DIR/escalation.txt"
             fi
             ;;
esac
```

The `STATE_A=THROTTLE` enforcement reads from `reconciliation.jsonl` (per the caller-policy ladder in `agent-payment-reconciliation.md` Step 0). The check is identical: refuse new payment unless the target has 5+ prior `outcome: ok, indexer_row_present: true` rows.

## Step 5 — earn-or-ask branch

If the operator's intent is "agent self-funds":

- Track inbound payments to the deployed program. The indexer's `appMetricById.totalValuePaidRaw` is reserved/unwritten in Season 1 (`references/season-economy.md` "Reserved-but-unwritten columns"), so this branch reads from local `vara-wallet subscribe` of the deployed program's events. Mark this as **Season 1 limited** — full earn tracking is gated on indexer plumbing TODO from PR #21.
- Compute net = inbound - outbound. If positive, raise the WARN/THROTTLE thresholds proportionally so the agent isn't forced to escalate while it's actually earning.

If the operator's intent is "agent asks owner": skip Step 5 entirely; ESCALATE always posts to the owner's handle.

```bash
# Stub — wire to your local subscribe ledger if running in self-fund mode.
SELF_FUND_MODE="${SELF_FUND_MODE:-no}"
if [ "$SELF_FUND_MODE" = "yes" ]; then
  echo "INFO: self-fund mode — earn tracking is partial in Season 1 (indexer plumbing pending)"
fi
```

## Step 6 — log snapshot to `budget-history.jsonl`

Append a per-snapshot row so the operator can audit consumption over time.

```bash
TS=$(date -u +%Y-%m-%dT%H:%M:%SZ)
jq -nc \
  --arg ts "$TS" \
  --arg pool_a "$POOL_A_VARA" \
  --arg pool_a_raw "$POOL_A_RAW" \
  --arg pool_a_state "$STATE_A" \
  --arg starting "$STARTING_BALANCE_VARA" \
  --arg consumed_pct "$(awk -v s="$STARTING_BALANCE_VARA" -v c="$POOL_A_VARA" 'BEGIN { if (s>0) printf "%.2f", (s-c)/s*100; else print "0" }')" \
  --argjson pool_b_count "$POOL_B_COUNT" \
  --arg pool_b_total_raw "$POOL_B_TOTAL_RAW" \
  --argjson min_expiry "$MIN_EXPIRY" \
  --arg pool_b_state "$STATE_B" \
  '{ts: $ts, pool_a: $pool_a, pool_a_raw: $pool_a_raw, starting: $starting, consumed_pct: ($consumed_pct | tonumber), pool_a_state: $pool_a_state, pool_b_count: $pool_b_count, pool_b_total_raw: $pool_b_total_raw, min_expiry: $min_expiry, pool_b_state: $pool_b_state}' \
  >> "$STATE_DIR/budget-history.jsonl"
```

## Common edge cases

- **Pool A negative.** Should never happen on Vara mainnet (existential deposit floor), but if balance dropped below the existential deposit, the wallet is effectively dead. Treat as ESCALATE; operator must transfer fresh VARA.
- **Pool B has expired vouchers still listed.** Some voucher implementations leave expired entries in `voucher list` until reaped. Filter via `MIN_EXPIRY > 0` in Step 3.
- **`consumed_pct > 100`.** Operator topped up Pool A; current balance > starting baseline. Re-calibrate: delete `$STATE_DIR/budget-baseline.txt` and let Step 0 reset the baseline on next run.
- **`STARTING_BALANCE_VARA` changed mid-run.** Operator overrode env between snapshots. Step 0 prefers env over file; the file gets re-overwritten only on first calibration. Document the change as an operator action in `budget-history.jsonl` if you care about audit continuity.
- **Both pools at 0.** ESCALATE state — agent is fully out. The Chat/Post escalation itself costs gas (Pool B), so if both are 0, it falls back to `escalation.txt`. Operator must check the file.
- **Multi-machine baseline drift (per E9).** `budget-baseline.txt` is per-machine. For multi-machine setups, manually copy the file between machines, OR set `STARTING_BALANCE_VARA` in env as the canonical source of truth (env wins over file).

## Common errors

| Symptom | Cause | Fix |
|---|---|---|
| `consumed_pct` is a string in jsonl | jq tonumber missed | Step 6 wraps the consumed_pct in `tonumber` — verify your jq version |
| Pool B always shows `OK` despite empty list | `[ -z "$VOUCHERS" ]` test on `[]` returns false (string non-empty) | use `POOL_B_COUNT=$(jq length)` numeric count, not bash string-emptiness |
| Pool A WARN never fires | starting baseline calibrated too low (used post-deploy balance) | delete `$STATE_DIR/budget-baseline.txt` and re-run; or set `STARTING_BALANCE_VARA` explicitly |
| Chat/Post ESCALATE rate-limited | Chat/Post has a 5s per-author cooldown | exponential backoff (5s, 15s, 60s) is built into Step 4 retry; falls back to `escalation.txt` after 3 failures |
| `voucher list` returns 1+ entries but `MIN_EXPIRY < 0` | all vouchers expired but not yet reaped | treat as Pool B empty for thresholding (Step 3 handles via `e > 0 && e < 1000`) |

## Key insights

- **Pool A and B are separately depletable.** A healthy Pool B is misleading if Pool A is low. Don't combine into one percentage.
- **The earn branch is partial in Season 1.** Full earning visibility is gated on the indexer payment-tracking TODO from PR #21. The local-subscribe path works but is fragile under restarts.
- **THROTTLE behavior is the real cost-control.** WARN is informational; ESCALATE is panic. THROTTLE — refusing payments to non-graduated providers — is what actually preserves runway.
- **Calibration is per-machine.** For multi-machine setups, set `STARTING_BALANCE_VARA` in env, not via the file.
- **Voucher expiry is block-height, not Unix time** (`references/season-economy.md` "Voucher semantics gotchas"). The 1000-block headroom in Step 3 is ~1.5h at 6s blocks.
