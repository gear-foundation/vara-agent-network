#!/usr/bin/env bash
# Lean structural lint for agent-starter/.
# Checks: frontmatter present, bash code fences parse, no daemon-era refs,
# and no copied live identities in example JSON.

set -u
cd "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
EXAMPLES_DIR="${AGENT_STARTER_EXAMPLES_DIR:-examples}"

FAIL=0
err() { echo "FAIL: $*" >&2; FAIL=$((FAIL+1)); }
ok()  { echo "ok:   $*"; }

# 1. SKILL.md frontmatter
if [ ! -f SKILL.md ]; then
  err "SKILL.md missing"
elif ! head -1 SKILL.md | grep -q '^---$'; then
  err "SKILL.md missing YAML frontmatter delimiter"
else
  for field in name description; do
    if awk '/^---$/{c++} c==1' SKILL.md | grep -q "^$field:"; then
      ok "SKILL.md has $field"
    else
      err "SKILL.md frontmatter missing $field"
    fi
  done
fi

# 2. bash -n every fenced bash block, per-fence so syntax errors point at the right block
check_fences() {
  local f=$1 idx=0 in_fence=0 tmp
  tmp=$(mktemp)
  while IFS= read -r line; do
    if [ "$in_fence" -eq 0 ] && [ "$line" = '```bash' ]; then
      in_fence=1
      idx=$((idx+1))
      : > "$tmp"
    elif [ "$in_fence" -eq 1 ] && [ "$line" = '```' ]; then
      in_fence=0
      if ! bash -n "$tmp" 2>/dev/null; then
        err "$f bash fence #$idx fails bash -n"
      fi
    elif [ "$in_fence" -eq 1 ]; then
      printf '%s\n' "$line" >> "$tmp"
    fi
  done < "$f"
  rm -f "$tmp"
  [ "$idx" -eq 0 ] || ok "$f: $idx bash fence(s) parse"
}

for f in SKILL.md agent-*.md; do
  [ -f "$f" ] && check_fences "$f"
done

# 3. No daemon-era references in skill content
DAEMON_TOKENS='autonomous-loop\|paid-integration\|payment-reconciliation\|rational-discovery\|budget-control\|intent-recovery'
HITS=$(grep -El "$DAEMON_TOKENS" SKILL.md STARTER_PROMPT.md README.md agent-*.md references/*.md 2>/dev/null || true)
if [ -n "$HITS" ]; then
  err "daemon-era references in kept files:"
  echo "$HITS" >&2
else
  ok "no daemon-era references in kept files"
fi

# 4. Example JSON must stay copy-safe. Hash fields may contain 32-byte hex
# values; actor/program/operator identities should be environment placeholders.
if [ -d "$EXAMPLES_DIR" ]; then
  VARA_AGENTS_HITS=$(grep -R -n '@vara-agents' "$EXAMPLES_DIR"/*.json 2>/dev/null || true)
  if [ -n "$VARA_AGENTS_HITS" ]; then
    err "@vara-agents mention in example JSON"
    echo "$VARA_AGENTS_HITS" >&2
  else
    ok "no @vara-agents mention in example JSON"
  fi

  ACTOR_TMP=$(mktemp)
  if EXAMPLES_DIR="$EXAMPLES_DIR" node --input-type=module >"$ACTOR_TMP" 2>&1 <<'NODE'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const dir = process.env.EXAMPLES_DIR
const allowedHexKeys = new Set(['skills_hash', 'idl_hash'])
const actor = /^0x[0-9a-fA-F]{64}$/
const failures = []

function walk(value, path) {
  if (typeof value === 'string') {
    const key = path[path.length - 1]
    if (actor.test(value) && !allowedHexKeys.has(key)) {
      failures.push(`${path.join('.')}: copied actor/program id literal`)
    }
    return
  }
  if (Array.isArray(value)) {
    value.forEach((item, idx) => walk(item, [...path, String(idx)]))
    return
  }
  if (value && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) walk(child, [...path, key])
  }
}

for (const file of readdirSync(dir).filter(name => name.endsWith('.json')).sort()) {
  try {
    walk(JSON.parse(readFileSync(join(dir, file), 'utf8')), [file])
  } catch (e) {
    failures.push(`${file}: invalid JSON: ${e.message}`)
  }
}

if (failures.length) {
  console.error(failures.join('\n'))
  process.exit(1)
}
NODE
  then
    ACTOR_LINT=""
  else
    ACTOR_LINT=$(cat "$ACTOR_TMP")
  fi
  rm -f "$ACTOR_TMP"
  if [ -n "$ACTOR_LINT" ]; then
    err "actor/program id literal in example JSON:"
    echo "$ACTOR_LINT" >&2
  else
    ok "no actor/program id literals in example JSON"
  fi
else
  err "examples dir missing: $EXAMPLES_DIR"
fi

if [ "$FAIL" -eq 0 ]; then
  echo "lint passed"
  exit 0
else
  echo "lint failed: $FAIL"
  exit 1
fi
