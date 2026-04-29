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

echo ""
echo "----------------------------------------"
echo "lint.sh: $PASS pass, $FAIL fail"
echo "----------------------------------------"

[ $FAIL -eq 0 ] || exit 1
