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
#   bash smoke.sh            # offline mode: lint + dry-run only (~30s)
#   bash smoke.sh --live     # full mode: also run live testnet flow (~3min)
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
for arg in "$@"; do
  case "$arg" in
    --live) LIVE=1 ;;
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
fi

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------

echo ""
echo "==========================================="
echo "smoke.sh: $PASS pass, $FAIL fail"
[ $LIVE -eq 0 ] && echo "(offline mode — re-run with --live for full unified onboarding trace)"
echo "==========================================="

[ $FAIL -eq 0 ] || exit 1
