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
  examples/register_application.json
  examples/set_identity_card.json
  examples/post_announcement.json
  examples/chat_post.json
  agent-onboarding.md
  agent-chat.md
  agent-board.md
  agent-discovery.md
  agent-mentions-listener.md
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
INVALID_LINES=$(mktemp /tmp/lint-vara-XXXX.txt)
for f in SKILL.md agent-onboarding.md agent-chat.md agent-board.md agent-discovery.md agent-mentions-listener.md README.md STARTER_PROMPT.md smoke.sh; do
  [ -f "$f" ] || continue
  # Match lines invoking vara-wallet, including the common compound forms:
  #   vara-wallet ...                          (bare)
  #   if ! vara-wallet ...                     (conditional)
  #   out=$(vara-wallet ...)                   (capture)
  #   timeout 60 vara-wallet ...               (wrapper)
  #   $(...)/vara-wallet ...                   (path-prefixed)
  # Skip prose: lines where vara-wallet appears inside backticks before any
  # actual call site (`vara-wallet subscribe`).
  awk -v file="$f" '
    function strip_globals(line,    matched) {
      while (match(line, /^(--account|--network|--seed|--mnemonic|--ws)[[:space:]]+[^[:space:]]+/)) {
        line = substr(line, RLENGTH+1); sub(/^[[:space:]]+/, "", line); matched = 1
      }
      while (match(line, /^(--json|--human|--quiet|--verbose|--light|--timing)([[:space:]]|$)/)) {
        line = substr(line, RLENGTH+1); sub(/^[[:space:]]+/, "", line); matched = 1
      }
      return line
    }
    {
      orig = $0
      # Skip lines that look like prose (backtick-wrapped vara-wallet mention,
      # no follow-on shell context). Allow backtick code spans containing real
      # commands by also matching cases where vara-wallet appears at the start
      # of a code block line.
      if (orig ~ /`[^`]*vara-wallet[^`]*`/ && orig !~ /^[[:space:]]*vara-wallet[[:space:]]/) next
      # Strip leading conditional prefixes / wrappers / capture syntax.
      tmp = orig
      sub(/^[[:space:]]*/, "", tmp)
      # if [!] vara-wallet
      sub(/^if[[:space:]]+!?[[:space:]]*/, "", tmp)
      # var=$(vara-wallet  OR  $(vara-wallet
      sub(/^[A-Za-z_][A-Za-z0-9_]*=\$\([[:space:]]*/, "", tmp)
      sub(/^\$\([[:space:]]*/, "", tmp)
      # timeout N
      sub(/^timeout[[:space:]]+[0-9]+[[:space:]]+/, "", tmp)
      # path/to/vara-wallet → strip to bare binary
      sub(/^[^[:space:]]*\//, "", tmp)
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
done > "$INVALID_LINES.candidates"

# Stage 2: each candidate's subcommand portion must match an allowlist entry.
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
  echo "$file: $cmd" >> "$INVALID_LINES"
done < "$INVALID_LINES.candidates"
rm -f "$INVALID_LINES.candidates"

if [ -s "$INVALID_LINES" ]; then
  while IFS= read -r entry; do
    err "vara-wallet subcommand not in allowlist — $entry"
  done < "$INVALID_LINES"
else
  ok "vara-wallet subcommands match allowlist"
fi
rm -f "$INVALID_LINES"

echo ""
echo "----------------------------------------"
echo "lint.sh: $PASS pass, $FAIL fail"
echo "----------------------------------------"

[ $FAIL -eq 0 ] || exit 1
