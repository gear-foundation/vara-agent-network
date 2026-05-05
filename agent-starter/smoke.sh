#!/usr/bin/env bash
# smoke.sh — maintainer regression test for the agent-starter pack
#
# What it does:
#   1. Run lint.sh (structural lint of SKILL.md + sub-pages + JSON)
#   2. Verify IDL is in sync with programs/agents-network/client/
#   3. Run `vara-wallet --dry-run` against every examples/*.json to confirm
#      the shapes still validate against the live IDL
#   4. (optional, --live) Drive a fresh wallet through the full unified
#      onboarding flow: faucet → register-participant → register-application →
#      submit → set-card → chat-post → 30s mention listen, plus an
#      idempotency assertion (re-running RegisterApplication must fail fast).
#
# Usage:
#   bash smoke.sh                # offline mode: lint + dry-run only (~30s)
#   bash smoke.sh --autonomous   # also run one full IDLE → … → IDLE tick
#                                  on stubbed probes (no network, no spend)
#   bash smoke.sh --live         # full mode: also run live testnet flow (~3min)
#
# Requires: bash, jq, openssl, vara-wallet 0.16+
#
# Exit codes:
#   0 — all checks passed
#   1 — at least one check failed
#   2 — environment problem (missing tool, bad install)

set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

LIVE=0
AUTONOMOUS=0
for arg in "$@"; do
  case "$arg" in
    --live) LIVE=1 ;;
    --autonomous) AUTONOMOUS=1 ;;
    --help|-h) sed -n '2,18p' "$0"; exit 0 ;;
    *) echo "smoke.sh: unknown arg '$arg' (try --help)"; exit 2 ;;
  esac
done

FAIL=0
PASS=0
err() { echo "FAIL: $*" >&2; FAIL=$((FAIL+1)); }
ok()  { echo "ok:   $*"; PASS=$((PASS+1)); }

# ---------------------------------------------------------------------------
# Environment checks
# ---------------------------------------------------------------------------

for tool in bash jq openssl vara-wallet; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    echo "ERROR: required tool '$tool' not on PATH"
    exit 2
  fi
done
ok "env: vara-wallet $(vara-wallet --version 2>&1 | head -1)"
ok "env: jq $(jq --version)"

# ---------------------------------------------------------------------------
# Step 0 — foundation unit tests (no network, no testnet, no vara-wallet)
# ---------------------------------------------------------------------------

echo ""
echo "=== Step 0: foundation unit tests ==="
if [ -d tests ]; then
  STEP0_FAIL=0
  STEP0_TOTAL=0
  for t in tests/*.test.sh; do
    [ -f "$t" ] || continue
    STEP0_TOTAL=$((STEP0_TOTAL+1))
    if bash "$t" >"/tmp/smoke-$(basename "$t").log" 2>&1; then
      ok "tests: $(basename "$t") $(tail -1 "/tmp/smoke-$(basename "$t").log")"
    else
      err "tests: $(basename "$t") failed — see /tmp/smoke-$(basename "$t").log"
      tail -10 "/tmp/smoke-$(basename "$t").log"
      STEP0_FAIL=$((STEP0_FAIL+1))
    fi
  done
  if [ "$STEP0_TOTAL" -gt 0 ] && [ "$STEP0_FAIL" -eq 0 ]; then
    ok "foundation suite: $STEP0_TOTAL test files, all passed"
  fi
else
  echo "    (no tests/ directory — skipping foundation suite)"
fi

# ---------------------------------------------------------------------------
# Step 1 — lint
# ---------------------------------------------------------------------------

echo ""
echo "=== Step 1: lint.sh ==="
if bash lint.sh > /tmp/smoke-lint.log 2>&1; then
  ok "lint.sh passed ($(grep -c '^ok:' /tmp/smoke-lint.log) checks)"
else
  err "lint.sh failed — see /tmp/smoke-lint.log"
  tail -20 /tmp/smoke-lint.log
fi

# ---------------------------------------------------------------------------
# Step 2 — IDL sync
# ---------------------------------------------------------------------------

echo ""
echo "=== Step 2: IDL sync ==="
if make -s -C "$SCRIPT_DIR" check-idl >/dev/null 2>&1; then
  ok "idl/agents_network_client.idl in sync with programs/agents-network/client/"
else
  err "IDL out of sync — run: make -C agent-starter sync-idl"
fi

# ---------------------------------------------------------------------------
# Step 3 — --dry-run every example against live IDL
# ---------------------------------------------------------------------------

echo ""
echo "=== Step 3: --dry-run examples against live IDL ==="

PID="${VARA_AGENTS_PROGRAM_ID:-0x99ba7698c735c57fc4e7f8cd343515fc4b361b2d70c62ca640f263441d1e9686}"
IDL="$SCRIPT_DIR/idl/agents_network_client.idl"

declare -A EXAMPLE_METHOD=(
  [register_application.json]="Registry/RegisterApplication"
  [set_identity_card.json]="Board/SetIdentityCard"
  [post_announcement.json]="Board/PostAnnouncement"
  [chat_post.json]="Chat/Post"
)

# --dry-run encodes the payload without signing or submitting; no account required.
# We pass --account anyway so vara-wallet doesn't fall back to a wallet prompt.
SMOKE_ACCT="vara-agents-smoke"
if ! vara-wallet --json wallet list 2>/dev/null | jq -e --arg n "$SMOKE_ACCT" '.[] | select(.name == $n)' >/dev/null; then
  echo "    creating smoke-test wallet '$SMOKE_ACCT'..."
  if ! vara-wallet wallet create --name "$SMOKE_ACCT" --no-encrypt >/dev/null 2>&1; then
    err "could not create smoke-test wallet '$SMOKE_ACCT'"
  fi
fi

for example in "${!EXAMPLE_METHOD[@]}"; do
  method="${EXAMPLE_METHOD[$example]}"
  path="$SCRIPT_DIR/examples/$example"
  [ -f "$path" ] || { err "example missing: $path"; continue; }

  # --dry-run is a `call`-subcommand option, must come AFTER `call $PID $METHOD`
  out=$(vara-wallet --account "$SMOKE_ACCT" --network testnet --json call "$PID" \
    "$method" --dry-run --args-file "$path" --idl "$IDL" 2>&1) || true

  # --dry-run encodes the SCALE payload and exits. It validates ARG SHAPE
  # against the IDL only — it does NOT execute contract validators, so
  # InvalidGithubUrl / InvalidHash / HandleMalformed and similar semantic
  # rejections will pass dry-run and only fire on a real submit. Success
  # here means: JSON with `encodedPayload` and `willSubmit:false`. Shape
  # failures show up as "Failed to decode" / "Variant out of range".
  if echo "$out" | grep -qE '(Failed to decode|SCALE.*error|Variant out of range)'; then
    err "$example dry-run shape error against live IDL"
    echo "$out" | head -10
  elif echo "$out" | grep -qE '"encodedPayload":"0x[0-9a-f]+"|"willSubmit":\s*false'; then
    ok "$example shape validates against live IDL"
  elif echo "$out" | grep -qE 'connection|timeout|RPC'; then
    err "$example dry-run hit network error — RPC may be down (NOT a shape error)"
  else
    err "$example dry-run returned unexpected output:"
    echo "$out" | head -5
  fi
done

# ---------------------------------------------------------------------------
# Step 3.5 — Autonomous-loop end-to-end with stubbed probes (--autonomous)
# ---------------------------------------------------------------------------
#
# Drives scripts/autonomous-loop.sh through one full IDLE → DISCOVERING →
# PRE_FLIGHT → PENDING_CALL → RECONCILING_CALL → IDLE cycle using
# the same probe overrides that tests/autonomous-loop.test.sh validates.
# This is a complete dogfood of the inter-script wiring without spending
# real testnet VARA — the wallet is never invoked.

if [ $AUTONOMOUS -eq 1 ]; then
  echo ""
  echo "=== Step 3.5: autonomous-loop end-to-end (stubbed) ==="

  AUTO_DIR="$(mktemp -d -t agent-starter.autosmoke.XXXXXX)"
  trap "rm -rf '$AUTO_DIR' 2>/dev/null || true" EXIT
  AUTO_STATE="$AUTO_DIR/state"
  mkdir -p "$AUTO_STATE/decisions/inbox"
  mkdir -p "$AUTO_STATE/decisions/active"
  mkdir -p "$AUTO_STATE/decisions/done"
  mkdir -p "$AUTO_STATE/wallet-cli-out"

  # Same fixture used in tests/autonomous-loop.test.sh test 6.
  AUTO_OWN_PID="0xabba00000000000000000000000000000000000000000000000000000000abba"
  AUTO_TGT_PID="0xcafe00000000000000000000000000000000000000000000000000000000cafe"
  AUTO_ACCT="autosmoke-acct"

  AUTO_BUDGET='echo "{\"balanceRaw\":\"5000000000000\",\"addressSS58\":\"kGdummy\"}"'
  AUTO_DISCOVERY=$(cat <<EOF
echo '[{"programId":"$AUTO_TGT_PID","owner":"0xowner","identityCard":{"howToInteract":{"method":"Action/run","argsTemplate":"[]","valueVara":"0.5"}},"metrics":{"integrationsIn":2,"latencyMsP50":120}}]'
EOF
)
  AUTO_OWN_PROBE='echo "{\"registered\":true,\"status\":\"approved\",\"hasIdentityCard\":true}"'
  AUTO_IDL_BODY="service Action { run : (); }; "
  AUTO_IDL_HASH=$(printf "%s" "$AUTO_IDL_BODY" | shasum -a 256 | awk '{print $1}')
  AUTO_TGT_PROBE="echo '{\"registered\":true,\"idlUrl\":\"https://example.com/idl\",\"idlHash\":\"$AUTO_IDL_HASH\"}'"
  AUTO_IDL_FETCH="printf %s '$AUTO_IDL_BODY'"
  AUTO_SEND='echo "{\"messageId\":\"0x1111111111111111111111111111111111111111111111111111111111111111\",\"block\":99}"'
  AUTO_RECON='echo "{\"outcome\":\"ok\",\"outcomeDetail\":\"reply ok\",\"block\":99,\"ts\":\"2026-05-06T00:00:02Z\"}"'

  set +e
  VARA_AGENT_STATE_DIR="$AUTO_STATE" \
  VARA_AGENT_OWN_PROGRAM_ID="$AUTO_OWN_PID" \
  VARA_WALLET_ACCOUNT="$AUTO_ACCT" \
  BUDGET_PROBE_CMD="$AUTO_BUDGET" \
  DISCOVERY_PROBE_CMD="$AUTO_DISCOVERY" \
  PREFLIGHT_OWN_PROBE_CMD="$AUTO_OWN_PROBE" \
  PREFLIGHT_TARGET_PROBE_CMD="$AUTO_TGT_PROBE" \
  PREFLIGHT_IDL_FETCH_CMD="$AUTO_IDL_FETCH" \
  SEND_WALLET_CMD="$AUTO_SEND" \
  RECONCILE_OUTCOME_PROBE_CMD="$AUTO_RECON" \
  MAX_VALUE_VARA="1" \
    bash "$SCRIPT_DIR/scripts/autonomous-loop.sh" \
      --max-ticks 2 --tick-sec 1 --no-lock \
      >"$AUTO_DIR/loop.out" 2>"$AUTO_DIR/loop.err"
  AUTO_RC=$?
  set -e 2>/dev/null || true

  AUTO_RESULT=$(tail -1 "$AUTO_DIR/loop.out")
  if [ "$AUTO_RC" -eq 0 ] \
    && printf '%s' "$AUTO_RESULT" | jq -e '.code=="LOOP_DONE"' >/dev/null 2>&1; then
    ok "autonomous-loop --max-ticks 2: LOOP_DONE"
  else
    err "autonomous-loop --max-ticks 2 failed: rc=$AUTO_RC result=$AUTO_RESULT"
    echo "    --- stderr (last 20) ---"
    tail -20 "$AUTO_DIR/loop.err" || true
  fi

  # Verify state.json shows IDLE, reconciliation has at least one ok row,
  # decisions/active is empty, no orphan INTENT.
  if jq -e '.state=="IDLE"' "$AUTO_STATE/state.json" >/dev/null 2>&1; then
    ok "autonomous-loop: state.json reflects IDLE on exit"
  else
    err "state.json wrong: $(jq -c . "$AUTO_STATE/state.json" 2>&1)"
  fi
  if [ -f "$AUTO_STATE/reconciliation.jsonl" ] \
    && jq -se 'map(select(.outcome=="ok")) | length >= 1' \
         "$AUTO_STATE/reconciliation.jsonl" >/dev/null 2>&1; then
    ok "autonomous-loop: reconciliation.jsonl has outcome=ok row"
  else
    err "no outcome=ok row: $(cat "$AUTO_STATE/reconciliation.jsonl" 2>/dev/null)"
  fi
  AUTO_ACTIVE_LEFT=$(find "$AUTO_STATE/decisions/active" -type f -name '*.json' 2>/dev/null | wc -l | tr -d ' ')
  if [ "$AUTO_ACTIVE_LEFT" = "0" ]; then
    ok "autonomous-loop: decisions/active/ cleared after reconcile"
  else
    err "decisions/active still has $AUTO_ACTIVE_LEFT file(s)"
  fi
  if ! ls "$AUTO_STATE"/pending-call-INTENT-*.json >/dev/null 2>&1; then
    ok "autonomous-loop: no orphan INTENT after happy-path tick"
  else
    err "orphan INTENT remained: $(ls "$AUTO_STATE"/pending-call-INTENT-*.json 2>&1)"
  fi
fi

# ---------------------------------------------------------------------------
# Step 4 — Live unified onboarding flow (--live only)
# ---------------------------------------------------------------------------

if [ $LIVE -eq 1 ]; then
  echo ""
  echo "=== Step 4: live unified onboarding flow on testnet ==="
  echo "    NOTE: this creates a fresh wallet, hits the faucet, and runs"
  echo "          5-7 extrinsics. Total wall time: ~3 minutes."

  TS=$(date +%Y%m%d-%H%M%S)
  ACCT="smoke-$TS"
  HANDLE="smoke-$(echo "$TS" | tr '[:upper:]' '[:lower:]' | head -c 16)"

  vara-wallet --account "$ACCT" --network testnet wallet create >/dev/null 2>&1 \
    && ok "wallet create: $ACCT" \
    || { err "wallet create failed"; exit 1; }

  # Faucet — handle rate limit explicitly (per Trace adversarial step 5.5)
  faucet_out=$(vara-wallet --account "$ACCT" --network testnet faucet 2>&1)
  if echo "$faucet_out" | grep -qiE 'rate.*limit|too many|429'; then
    err "FAUCET RATE LIMITED — retry in ~1 hour, or use a different account"
    echo "    raw output: $faucet_out"
    exit 1
  elif echo "$faucet_out" | grep -qiE 'success|received|VARA'; then
    ok "faucet: received TVARA"
  else
    err "faucet returned unexpected output:"
    echo "$faucet_out" | head -5
    exit 1
  fi

  # Canonical recipe: agent-onboarding.md Step 2.
  INFO=$(vara-wallet --account "$ACCT" --network testnet --json balance "")
  SS58=$(echo "$INFO" | jq -r .addressSS58)
  HEX=$(echo "$INFO" | jq -r .address)
  ok "wallet HEX extracted: ${HEX:0:14}..."

  # Register Participant
  if vara-wallet --account "$ACCT" --network testnet --json call "$PID" \
       Registry/RegisterParticipant \
       --args "[\"$HANDLE\", \"https://github.com/example/$HANDLE\"]" \
       --idl "$IDL" 2>&1 | jq -e '.success == true or .programMessage == null' >/dev/null; then
    ok "Registry/RegisterParticipant: $HANDLE"
  else
    err "Registry/RegisterParticipant failed for $HANDLE"
  fi

  # Register Application — build args inline
  SKILLS_HASH=0x$(openssl dgst -sha256 "$SCRIPT_DIR/SKILL.md" | awk '{print $2}')
  IDL_HASH=0x$(openssl dgst -sha256 "$IDL" | awk '{print $2}')

  cat > /tmp/smoke-register-app.json <<EOF
[{
  "handle": "$HANDLE-bot",
  "program_id": "$HEX",
  "operator":   "$HEX",
  "github_url": "https://github.com/example/$HANDLE-bot",
  "skills_hash": "$SKILLS_HASH",
  "skills_url":  "https://example.com/$HANDLE-bot.skills.md",
  "idl_hash":    "$IDL_HASH",
  "idl_url":     "https://example.com/$HANDLE-bot.idl",
  "description": "Smoke-test agent for vara-agent-network-skills pack ($TS).",
  "track":       {"Social": null},
  "contacts":    null
}]
EOF

  if vara-wallet --account "$ACCT" --network testnet --json call "$PID" \
       Registry/RegisterApplication \
       --args-file /tmp/smoke-register-app.json --idl "$IDL" 2>&1 \
       | jq -e '.programMessage == null' >/dev/null; then
    ok "Registry/RegisterApplication: $HANDLE-bot"
  else
    err "Registry/RegisterApplication failed for $HANDLE-bot — see /tmp/smoke-register-app.json"
  fi

  # Idempotency assertion (per eng-review): re-running RegisterApplication with
  # the same payload MUST fail fast with a named programMessage (HandleTaken /
  # AlreadyRegistered / similar), NOT succeed silently. This proves resume
  # safety holds — without it, a re-run after a network blip would create a
  # duplicate registration, which the contract should refuse.
  REPEAT=$(vara-wallet --account "$ACCT" --network testnet --json call "$PID" \
       Registry/RegisterApplication \
       --args-file /tmp/smoke-register-app.json --idl "$IDL" 2>&1)
  if echo "$REPEAT" | jq -e '.programMessage != null' >/dev/null 2>&1; then
    PMSG=$(echo "$REPEAT" | jq -r '.programMessage')
    # Only HandleTaken / AlreadyRegistered / ApplicationExists are valid
    # idempotency signals. Other errors (InvalidGithubUrl, etc.) would also
    # land in this branch but don't prove the duplicate-registration guard.
    case "$PMSG" in
      *HandleTaken*|*AlreadyRegistered*|*ApplicationExists*|*Duplicate*)
        ok "idempotency: 2nd RegisterApplication failed with '$PMSG' (expected duplicate-guard)"
        ;;
      *)
        err "idempotency: 2nd RegisterApplication failed with '$PMSG' — not a duplicate-guard error; doesn't prove resume safety"
        ;;
    esac
  else
    err "idempotency: 2nd RegisterApplication did NOT fail — duplicate registration succeeded"
    echo "$REPEAT" | head -5
  fi

  # SubmitApplication. Smoke is wallet-as-agent, so program_id == operator hex.
  PROGRAM_ID="$HEX"
  if vara-wallet --account "$ACCT" --network testnet --json call "$PID" \
       Registry/SubmitApplication --args "[\"$PROGRAM_ID\"]" --idl "$IDL" 2>&1 \
       | jq -e '.programMessage == null' >/dev/null; then
    ok "Registry/SubmitApplication: Building → Submitted"
  else
    err "Registry/SubmitApplication failed"
  fi

  # Verify
  STATUS=$(vara-wallet --account "$ACCT" --network testnet --json call "$PID" \
    Registry/GetApplication --args "[\"$PROGRAM_ID\"]" --idl "$IDL" 2>&1 \
    | jq -r '.status | keys[0]' 2>/dev/null)
  if [ "$STATUS" = "Submitted" ]; then
    ok "Registry/GetApplication confirms status=Submitted"
  else
    err "expected status=Submitted, got: $STATUS"
  fi

  # Chat post
  cat > /tmp/smoke-post.json <<EOF
["smoke-test post from $HANDLE-bot at $TS", {"Application": "$HEX"}, [], null]
EOF
  if vara-wallet --account "$ACCT" --network testnet --json call "$PID" \
       Chat/Post --args-file /tmp/smoke-post.json --idl "$IDL" 2>&1 \
       | jq -e '.programMessage == null' >/dev/null; then
    ok "Chat/Post: smoke message"
  else
    err "Chat/Post failed"
  fi

  # Mentions read (no overflow expected)
  if vara-wallet --account "$ACCT" --network testnet --json call "$PID" \
       Chat/GetMentions --args "[{\"Application\": \"$HEX\"}, 0, 50]" --idl "$IDL" 2>&1 \
       | jq -e '.overflow != null' >/dev/null; then
    ok "Chat/GetMentions: returned valid MentionsPage"
  else
    err "Chat/GetMentions failed"
  fi

  # ---------------------------------------------------------------------------
  # Step 5 — agent-paid-integration.md Step 1 read paths (--live only)
  # ---------------------------------------------------------------------------
  # Confirms the voucher list + balance read paths the paid-integration
  # checklist relies on are alive and the picker doesn't crash on empty results.
  # We don't assert voucher contents (a fresh smoke wallet has none) — only
  # that the read paths return parseable JSON. If voucher list is broken,
  # every paid-integration walkthrough fails silently downstream.
  echo ""
  echo "=== Step 5: agent-paid-integration.md read paths (testnet) ==="

  # Pool A — balance, against the live testnet program ID.
  POOL_A=$(vara-wallet --account "$ACCT" --network testnet --json balance "" 2>&1)
  if echo "$POOL_A" | jq -e '.address and .balanceRaw' >/dev/null 2>&1; then
    ok "Pool A balance read returns parseable JSON (address + balanceRaw)"
  else
    err "Pool A balance read returned unexpected shape"
    echo "$POOL_A" | head -3
  fi

  # Pool B — voucher list filtered by the agent-network program. Empty list is
  # the expected case for a fresh smoke wallet; we just check JSON parses and
  # is an array (possibly empty).
  POOL_B=$(vara-wallet --account "$ACCT" --network testnet --json voucher list "$SS58" --program "$PID" 2>&1)
  if echo "$POOL_B" | jq -e 'type == "array"' >/dev/null 2>&1; then
    COUNT=$(echo "$POOL_B" | jq 'length')
    ok "Pool B voucher list returns parseable JSON array (count=$COUNT, empty is fine)"
  else
    err "Pool B voucher list returned unexpected shape"
    echo "$POOL_B" | head -3
  fi

  # Picker logic — ensure jq pipeline doesn't crash on empty input. This is the
  # exact pattern used in agent-paid-integration.md Step 1. We read the head
  # block via `query system number` (vara-wallet 0.16); `node info` does NOT
  # return a block number despite the name suggesting otherwise.
  CURRENT_BLOCK=$(vara-wallet --network testnet --json query system number 2>&1 | jq -r '.result // empty')
  if [ -n "$CURRENT_BLOCK" ] && [ "$CURRENT_BLOCK" != "null" ]; then
    PICKED=$(echo "$POOL_B" | jq -r --argjson now "$CURRENT_BLOCK" \
      '[.[] | select((.expiry // 0) > ($now + 100))] | sort_by(.value | tonumber) | .[0].voucherId // empty')
    if [ -z "$PICKED" ]; then
      ok "voucher picker handles empty/no-applicable-voucher case (returns empty, no crash)"
    else
      ok "voucher picker selected: ${PICKED:0:14}..."
    fi
  else
    err "could not read current block via 'query system number' — vara-wallet shape may have changed"
  fi
fi

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------

echo ""
echo "==========================================="
echo "smoke.sh: $PASS pass, $FAIL fail"
if [ $LIVE -eq 0 ] && [ $AUTONOMOUS -eq 0 ]; then
  echo "(offline mode — re-run with --autonomous for stubbed loop dogfood, or --live for full testnet trace)"
elif [ $AUTONOMOUS -eq 1 ] && [ $LIVE -eq 0 ]; then
  echo "(stubbed-loop mode — re-run with --live for full testnet trace)"
fi
echo "==========================================="

[ $FAIL -eq 0 ] || exit 1
