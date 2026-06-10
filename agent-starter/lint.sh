#!/usr/bin/env bash
# Lean structural lint for agent-starter/.
# Checks: frontmatter present, bash code fences parse, stale references,
# bundled IDL method drift, and no copied live identities in example JSON.

set -u
cd "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
EXAMPLES_DIR="${AGENT_STARTER_EXAMPLES_DIR:-examples}"
PROGRAM_IDS_FILE="${AGENT_STARTER_PROGRAM_IDS_FILE:-references/program-ids.md}"
IDL_FILE="${AGENT_STARTER_IDL_FILE:-idl/agents_network_client.idl}"

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

# 4. Cross-reference and bundled IDL drift checks.
STATIC_TMP=$(mktemp)
if PROGRAM_IDS_FILE="$PROGRAM_IDS_FILE" IDL_FILE="$IDL_FILE" AGENT_STARTER_LINT_FILES="${AGENT_STARTER_LINT_FILES:-}" node --input-type=module >"$STATIC_TMP" 2>&1 <<'NODE'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join, normalize } from 'node:path'

const root = process.cwd()
const pathSep = process.platform === 'win32' ? ';' : ':'
const failures = []

function defaultFiles() {
  const files = []
  for (const name of ['SKILL.md', 'STARTER_PROMPT.md', 'README.md']) {
    if (existsSync(name)) files.push(name)
  }
  for (const name of readdirSync(root)) {
    if (/^agent-.*\.md$/.test(name)) files.push(name)
  }
  if (existsSync('references')) {
    for (const name of readdirSync('references')) {
      if (name.endsWith('.md')) files.push(join('references', name))
    }
  }
  return [...new Set(files)].sort()
}

const files = process.env.AGENT_STARTER_LINT_FILES
  ? process.env.AGENT_STARTER_LINT_FILES.split(pathSep).filter(Boolean)
  : defaultFiles()

function read(file) {
  try {
    return readFileSync(file, 'utf8')
  } catch (e) {
    failures.push(`${file}: could not read: ${e.message}`)
    return ''
  }
}

for (const file of files) {
  const text = read(file)
  for (const match of text.matchAll(/\$VARA_AGENT_NETWORK_SKILLS_DIR\/([A-Za-z0-9_./-]+\.md)\b/g)) {
    const target = normalize(match[1])
    if (target.startsWith('..') || target.includes('/../')) {
      failures.push(`${file}: unsafe skill reference ${match[0]}`)
      continue
    }
    if (!existsSync(join(root, target))) failures.push(`${file}: missing skill reference ${match[0]}`)
  }
}

const staleActiveDocPatterns = [
  {
    pattern: /agents\.vara\.network\/hackathon/i,
    message: 'active docs must not point builders to the ended hackathon funding page',
  },
  {
    pattern: /\b100 VARA\b/i,
    message: 'active docs must not promise the ended Season 1 token claim',
  },
  {
    pattern: /\btweet-claim\b|\btweet claim\b/i,
    message: 'active docs must not use tweet-claim funding',
  },
  {
    pattern: /set_fee_hackathon_owner_only/i,
    message: 'production-facing fee docs must not expose hackathon caveats as method names',
  },
  {
    pattern: /vara-wallet[^\n]*\bcall\b[^\n]*--voucher\s+["']?\$VOUCHER_ID["']?/,
    message: 'write examples must use VAN_WRITE_GAS_ARGS instead of requiring VOUCHER_ID',
  },
]

const staleAllowedFiles = new Set([
  'references/vouchers.md',
  'references/season-economy.md',
  'agent-foundation-reviewer.md',
])
for (const file of files) {
  const normalized = normalize(file).replaceAll('\\', '/')
  if (staleAllowedFiles.has(normalized)) continue
  const text = read(file)
  for (const { pattern, message } of staleActiveDocPatterns) {
    if (pattern.test(text)) failures.push(`${file}: ${message}`)
  }
}

const requiredExports = ['_VAN', 'VARA_AGENTS_PROGRAM_ID', 'PID', 'INDEXER_GRAPHQL_URL', 'VOUCHER_URL', 'VARA_NETWORK', 'VARA_WS', 'IDL']
const programIdsFile = process.env.PROGRAM_IDS_FILE
const programIds = read(programIdsFile)
const exported = new Set([...programIds.matchAll(/^\s*export\s+([A-Za-z_][A-Za-z0-9_]*)=/gm)].map(m => m[1]))
for (const name of requiredExports) {
  if (!exported.has(name)) failures.push(`${programIdsFile}: missing canonical export ${name}`)
}

function findServiceBlocks(idlText) {
  const blocks = []
  const regex = /\bservice\s+([A-Za-z_][A-Za-z0-9_]*)\s*\{/g
  let match
  while ((match = regex.exec(idlText)) !== null) {
    const open = idlText.indexOf('{', match.index)
    let depth = 0
    let close = -1
    for (let i = open; i < idlText.length; i++) {
      if (idlText[i] === '{') depth++
      else if (idlText[i] === '}') {
        depth--
        if (depth === 0) {
          close = i
          break
        }
      }
    }
    if (close < 0) break
    blocks.push({ name: match[1], body: idlText.slice(open + 1, close) })
    regex.lastIndex = close + 1
  }
  return blocks
}

const idlFile = process.env.IDL_FILE
const idlText = read(idlFile)
const idlMethods = new Map()
for (const block of findServiceBlocks(idlText)) {
  const methods = new Set()
  for (const match of block.body.matchAll(/^\s*(?:query\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*:/gm)) {
    methods.add(match[1])
  }
  idlMethods.set(block.name, methods)
}
const serviceNames = [...idlMethods.keys()]
const methodPattern = serviceNames.length
  ? new RegExp(`\\b(${serviceNames.join('|')})/([A-Za-z_][A-Za-z0-9_]*)\\b`, 'g')
  : null
if (!methodPattern) failures.push(`${idlFile}: no service methods parsed`)

if (methodPattern) {
  for (const file of files) {
    const text = read(file)
    for (const match of text.matchAll(methodPattern)) {
      const [, service, method] = match
      // Skip when `method` is itself a service name: that's service-list prose
      // shorthand like "Registry/Chat/Board services", not a Service/Method call.
      // Accepted tradeoff: a bogus call whose method is literally a service name
      // (e.g. Chat/Registry) slips through, but that collision is vanishingly rare
      // and the alternative false-positives on pervasive legitimate prose.
      if (idlMethods.has(method)) continue
      const context = text.slice(Math.max(0, match.index - 60), match.index + match[0].length + 100)
      if (/not found|IDL exposes|absent from bundled IDL/i.test(context)) continue
      if (!idlMethods.get(service)?.has(method)) failures.push(`${file}: ${service}/${method} absent from bundled IDL`)
    }
  }
}

if (failures.length) {
  console.error(failures.join('\n'))
  process.exit(1)
}
NODE
then
  STATIC_LINT=""
else
  STATIC_LINT=$(cat "$STATIC_TMP")
fi
rm -f "$STATIC_TMP"
if [ -n "$STATIC_LINT" ]; then
  err "static cross-reference/IDL lint failed:"
  echo "$STATIC_LINT" >&2
else
  ok "static cross-reference/IDL lint passed"
fi

# 5. Example JSON must stay copy-safe. Hash fields may contain 32-byte hex
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
