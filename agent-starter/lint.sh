#!/usr/bin/env bash
# Structural lint for agent-starter/.
# - Root SKILL.md has parseable YAML frontmatter with required fields
# - Every referenced file under references/ and examples/ exists
# - Every fenced bash block in SKILL.md and sub-pages is `bash -n` clean
# - IDL is in sync with source

set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

FAIL=0
PASS=0

err() { echo "FAIL: $*" >&2; FAIL=$((FAIL+1)); }
ok()  { echo "ok:   $*"; PASS=$((PASS+1)); }

# 1. Root SKILL.md exists + has frontmatter
if [ ! -f SKILL.md ]; then
  err "SKILL.md missing at agent-starter/SKILL.md"
else
  if ! head -1 SKILL.md | grep -q '^---$'; then
    err "SKILL.md does not start with '---' (no YAML frontmatter)"
  else
    ok "SKILL.md frontmatter delimiter present"
  fi
  for field in name description license; do
    if ! awk '/^---$/{c++} c==1' SKILL.md | grep -q "^$field:"; then
      err "SKILL.md frontmatter missing required field: $field"
    else
      ok "SKILL.md frontmatter has $field"
    fi
  done
fi

# 2. Required reference + example files exist
REQUIRED_FILES=(
  README.md
  STARTER_PROMPT.md
  smoke.sh
  Makefile
  idl/agents_network_client.idl
  references/overview.md
  references/program-ids.md
  references/arg-shape-cookbook.md
  references/actor-id-formats.md
  references/error-variants.md
  references/event-shapes.md
  references/ownership-model.md
  references/staleness.md
  references/pricing.md
  examples/register_application.json
  examples/set_identity_card.json
  examples/post_announcement.json
  examples/chat_post.json
  agent-onboarding.md
  agent-chat.md
  agent-board.md
  agent-discovery.md
  agent-mentions-listener.md
  templates/sails-program-layout/README.md
  templates/sails-program-layout/lib.rs
  .claude-plugin/plugin.json
  .claude-plugin/marketplace.json
)
for f in "${REQUIRED_FILES[@]}"; do
  if [ ! -f "$f" ]; then
    err "required file missing: $f"
  else
    ok "required file present: $f"
  fi
done

# 3. examples/*.json parse as JSON
for j in examples/*.json; do
  [ -f "$j" ] || continue
  if ! python3 -c "import json,sys; json.load(open(sys.argv[1]))" "$j" 2>/dev/null; then
    err "$j is not valid JSON"
  else
    ok "$j parses as JSON"
  fi
done

# 4. .claude-plugin/*.json parse
for j in .claude-plugin/*.json; do
  [ -f "$j" ] || continue
  if ! python3 -c "import json,sys; json.load(open(sys.argv[1]))" "$j" 2>/dev/null; then
    err "$j is not valid JSON"
  else
    ok "$j parses as JSON"
  fi
done

# 5. bash -n on every fenced bash block in SKILL.md + sub-pages
check_bash_blocks() {
  local file="$1"
  [ -f "$file" ] || return 0
  local block_num=0
  local in_block=0
  local block_buf=""
  local lineno=0
  while IFS= read -r line || [ -n "$line" ]; do
    lineno=$((lineno+1))
    if [ $in_block -eq 0 ]; then
      if echo "$line" | grep -qE '^[[:space:]]*```bash[[:space:]]*$'; then
        in_block=1
        block_num=$((block_num+1))
        block_buf=""
      fi
    else
      if echo "$line" | grep -qE '^[[:space:]]*```[[:space:]]*$'; then
        in_block=0
        if ! echo "$block_buf" | bash -n 2>/dev/null; then
          err "$file: bash block #$block_num (ending near line $lineno) fails 'bash -n'"
        else
          ok "$file: bash block #$block_num syntax clean"
        fi
        block_buf=""
      else
        block_buf="$block_buf"$'\n'"$line"
      fi
    fi
  done < "$file"
}

for f in SKILL.md agent-onboarding.md agent-chat.md agent-board.md agent-discovery.md agent-mentions-listener.md; do
  check_bash_blocks "$f"
done

# 6. IDL in sync with source (re-uses Makefile's check)
if make -s check-idl 2>&1 | grep -q ERROR; then
  err "IDL out of sync with programs/agents-network/client/"
else
  ok "IDL in sync with programs/agents-network/client/"
fi

# 7. vara-wallet subcommand allowlist
# `bash -n` only catches syntax. It can't detect a `vara-wallet wallet info`
# call where the subcommand doesn't exist. This grep-based check catches the
# class of bug where docs reference a subcommand that vara-wallet doesn't have.
# Allowlist below matches `vara-wallet [global flags] <subcommand>` patterns
# that actually exist in vara-wallet 0.16.0. Update on CLI version bumps.
# Allowlist: top-level vara-wallet subcommands + the inner subcommand for the
# two-level commands (wallet/subscribe). Match against `first1` OR `first1+first2`.
# Update on vara-wallet CLI version bumps.
TOP_LEVEL='^(call|faucet|balance|transfer|node|init|message|mailbox|program|code|state|wait|watch|discover|idl|metadata|vft|voucher|encode|decode|sign|verify|tx|query)([[:space:]]|$)'
WALLET_SUB='^wallet[[:space:]]+(create|import|list|export|keys|default)([[:space:]]|$)'
SUBSCRIBE_SUB='^subscribe[[:space:]]+(blocks|messages|mailbox|balance|transfers|program)([[:space:]]|$)'

# Stage 1: extract candidate lines (one per vara-wallet invocation, with
# continuation lines joined), strip the leading `vara-wallet ` and any global
# flags, leaving just the subcommand portion. Write to a temp file so the
# while-loop runs in the parent shell (avoids the pipe-subshell variable trap).
CANDIDATES=$(mktemp /tmp/lint-vara-XXXX.txt)
for f in SKILL.md agent-onboarding.md agent-chat.md agent-board.md agent-discovery.md agent-mentions-listener.md README.md STARTER_PROMPT.md smoke.sh; do
  [ -f "$f" ] || continue
  # Match lines invoking vara-wallet, including the common compound forms:
  # bare, `if ! vara-wallet`, `out=$(vara-wallet`, `timeout 60 vara-wallet`,
  # `path/to/vara-wallet`. Skip prose: lines where vara-wallet appears inside
  # backticks AND not at the start of a shell line (e.g. "Run `vara-wallet
  # subscribe` in parallel.").
  awk -v file="$f" '
    function strip_globals(line) {
      while (match(line, /^(--account|--network|--seed|--mnemonic|--ws)[[:space:]]+[^[:space:]]+/)) {
        line = substr(line, RLENGTH+1); sub(/^[[:space:]]+/, "", line)
      }
      while (match(line, /^(--json|--human|--quiet|--verbose|--light|--timing)([[:space:]]|$)/)) {
        line = substr(line, RLENGTH+1); sub(/^[[:space:]]+/, "", line)
      }
      return line
    }
    {
      orig = $0
      if (orig ~ /`[^`]*vara-wallet[^`]*`/ && orig !~ /^[[:space:]]*vara-wallet[[:space:]]/) next
      tmp = orig
      # Strip leading whitespace + any of the supported call-site prefixes in
      # one pass: `if [!] `, `var=$(`, `$(`, `timeout N `, or `path/`.
      sub(/^[[:space:]]*(if[[:space:]]+!?[[:space:]]*|[A-Za-z_][A-Za-z0-9_]*=\$\([[:space:]]*|\$\([[:space:]]*|timeout[[:space:]]+[0-9]+[[:space:]]+|[^[:space:]]*\/)?/, "", tmp)
      if (tmp !~ /^vara-wallet[[:space:]]/) next
      line = tmp
      while (sub(/\\$/, "", line) > 0) {
        getline next_line
        line = line " " next_line
      }
      sub(/^vara-wallet[[:space:]]+/, "", line)
      line = strip_globals(line)
      print file "\t" line
    }
  ' "$f"
done > "$CANDIDATES"

# Stage 2: each candidate's subcommand portion must match an allowlist entry.
INVALID=$(mktemp /tmp/lint-vara-bad-XXXX.txt)
while IFS=$'\t' read -r file cmd; do
  [ -z "$cmd" ] && continue
  case "$cmd" in
    \"*|\'*|\`*) continue ;;
  esac
  if echo "$cmd" | grep -qE "$TOP_LEVEL" \
     || echo "$cmd" | grep -qE "$WALLET_SUB" \
     || echo "$cmd" | grep -qE "$SUBSCRIBE_SUB"; then
    continue
  fi
  echo "$file: $cmd" >> "$INVALID"
done < "$CANDIDATES"
rm -f "$CANDIDATES"

if [ -s "$INVALID" ]; then
  while IFS= read -r entry; do
    err "vara-wallet subcommand not in allowlist — $entry"
  done < "$INVALID"
else
  ok "vara-wallet subcommands match allowlist"
fi
rm -f "$INVALID"

# 8. vara-wallet version detection (E4) — soft warn on mismatch with the
# version the allowlist above was tuned against. Anchored regex (per
# eng-review C1) so multi-version output ("vara-wallet 0.16.2 (sails 0.5.1)")
# doesn't produce a false-positive warning that maintainers learn to ignore.
PINNED_WALLET_VERSION="0.16"
if command -v vara-wallet >/dev/null 2>&1; then
  actual=$(vara-wallet --version 2>&1 | head -1 | grep -oE 'vara-wallet [0-9]+\.[0-9]+' | grep -oE '[0-9]+\.[0-9]+')
  if [ -n "$actual" ] && [ "$actual" != "$PINNED_WALLET_VERSION" ]; then
    echo "WARN: vara-wallet $actual installed, allowlist pinned to $PINNED_WALLET_VERSION."
    echo "      If lint findings look wrong, update TOP_LEVEL/WALLET_SUB/SUBSCRIBE_SUB in lint.sh."
  elif [ -n "$actual" ]; then
    ok "vara-wallet version $actual matches pinned allowlist version $PINNED_WALLET_VERSION"
  fi
fi

# 9. Track-prose elimination gate. The unification PR removed Track A/B
# vocabulary from prose; this grep enforces it doesn't creep back. Allowed
# survivors: enum mentions in JSON ({"Social": null}), legitimate uses of
# "wallet-as-agent" / "deployed-program" as descriptors. Disallowed: "Track A",
# "Track B", "Track A/B", and "<phrase> archetype" framing.
if command -v rg >/dev/null 2>&1; then
  TRACK_HITS=$(rg -in -e 'track [ab]\b' -e 'track a/b' -e 'track-a ' -e 'track-b ' \
                  -e 'deployed-program archetype' -e 'wallet-as-agent archetype' \
                  --glob '*.md' --glob '*.sh' \
                  --glob '!templates/sails-program-layout/lib.rs' \
                  --glob '!lint.sh' 2>/dev/null || true)
  if [ -n "$TRACK_HITS" ]; then
    err "Track-prose grep gate FAILED — Track A/B vocabulary leaked back in:"
    echo "$TRACK_HITS"
  else
    ok "Track-prose grep gate clean (no Track A/B/archetype prose)"
  fi
else
  echo "INFO: ripgrep not installed — skipping Track-prose grep gate"
fi

# 10. No-buildable-template invariant (per eng-review A1). Glob over
# templates/, not path-anchored, so it catches a reverted
# sails-program-layout/Cargo.toml AND a future templates/agent-v2/Cargo.toml.
# NOTE: parens + explicit -print are required. POSIX find binds the implicit
# -print to the LAST -o term, so `find ... -name A -o -name B` would silently
# only print B-matches and miss A-matches — defeating the whole gate.
if find templates \( -name 'Cargo.toml' -o -name 'build.rs' \) -print 2>/dev/null | grep -q .; then
  err "no buildable templates allowed under templates/ — use vara-skills:sails-new-app to scaffold real projects"
  find templates \( -name 'Cargo.toml' -o -name 'build.rs' \) -print
else
  ok "no buildable Cargo.toml/build.rs under templates/"
fi

# 11. LAYOUT REFERENCE ONLY string gate — guards against future PRs silently
# re-introducing buildable status without updating the framing.
if [ -f templates/sails-program-layout/lib.rs ]; then
  if grep -q 'LAYOUT REFERENCE ONLY' templates/sails-program-layout/lib.rs; then
    ok "templates/sails-program-layout/lib.rs has LAYOUT REFERENCE ONLY marker"
  else
    err "templates/sails-program-layout/lib.rs missing 'LAYOUT REFERENCE ONLY' marker — invariant compromised"
  fi
fi

echo ""
echo "----------------------------------------"
echo "lint.sh: $PASS pass, $FAIL fail"
echo "----------------------------------------"

[ $FAIL -eq 0 ] || exit 1
