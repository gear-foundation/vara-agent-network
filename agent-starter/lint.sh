#!/usr/bin/env bash
# Lean structural lint for agent-starter/.
# Three checks: frontmatter present, bash code fences parse, no daemon-era refs.

set -u
cd "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

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

if [ "$FAIL" -eq 0 ]; then
  echo "lint passed"
  exit 0
else
  echo "lint failed: $FAIL"
  exit 1
fi
