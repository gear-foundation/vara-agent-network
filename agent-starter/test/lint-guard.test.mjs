import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const lint = join(root, 'lint.sh')

test('lint example guard fails on @vara-agents and copied actor id literals', () => {
  const dir = mkdtempSync(join(tmpdir(), 'van-bad-examples-'))
  try {
    writeFileSync(join(dir, 'bad.json'), JSON.stringify({
      body: 'hello @vara-agents',
      actor: `0x${'1'.repeat(64)}`,
      skills_hash: `0x${'2'.repeat(64)}`,
    }))
    const r = spawnSync('bash', [lint], {
      cwd: root,
      env: { ...process.env, AGENT_STARTER_EXAMPLES_DIR: dir },
      encoding: 'utf8',
    })
    assert.equal(r.status, 1)
    assert.match(r.stderr, /@vara-agents/)
    assert.match(r.stderr, /actor\/program id literal/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('lint example guard accepts placeholders and hash literals', () => {
  const dir = mkdtempSync(join(tmpdir(), 'van-good-examples-'))
  try {
    writeFileSync(join(dir, 'good.json'), JSON.stringify({
      app: '$APP_HEX',
      skills_hash: `0x${'2'.repeat(64)}`,
      idl_hash: `0x${'3'.repeat(64)}`,
    }))
    const r = spawnSync('bash', [lint], {
      cwd: root,
      env: { ...process.env, AGENT_STARTER_EXAMPLES_DIR: dir },
      encoding: 'utf8',
    })
    assert.equal(r.status, 0)
    assert.match(r.stdout, /no actor\/program id literals/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('lint example guard reports invalid JSON', () => {
  const dir = mkdtempSync(join(tmpdir(), 'van-invalid-examples-'))
  try {
    writeFileSync(join(dir, 'bad.json'), '{not json')
    const r = spawnSync('bash', [lint], {
      cwd: root,
      env: { ...process.env, AGENT_STARTER_EXAMPLES_DIR: dir },
      encoding: 'utf8',
    })
    assert.equal(r.status, 1)
    assert.match(r.stderr, /invalid JSON/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('lint fails on missing skill-page references', () => {
  const dir = mkdtempSync(join(tmpdir(), 'van-bad-link-'))
  try {
    const doc = join(dir, 'doc.md')
    writeFileSync(doc, 'Read $VARA_AGENT_NETWORK_SKILLS_DIR/agent-missing.md before writing.\n')
    writeFileSync(join(dir, 'good.json'), '{}\n')
    const r = spawnSync('bash', [lint], {
      cwd: root,
      env: { ...process.env, AGENT_STARTER_EXAMPLES_DIR: dir, AGENT_STARTER_LINT_FILES: doc },
      encoding: 'utf8',
    })
    assert.equal(r.status, 1)
    assert.match(r.stderr, /missing skill reference/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('lint fails when canonical program ids omit required exports', () => {
  const dir = mkdtempSync(join(tmpdir(), 'van-bad-program-ids-'))
  try {
    const programIds = join(dir, 'program-ids.md')
    writeFileSync(programIds, [
      '```bash',
      'export _VAN="${VARA_AGENT_NETWORK_SKILLS_DIR:-./agent-starter}"',
      'export VARA_AGENTS_PROGRAM_ID="0x..."',
      'export PID="$VARA_AGENTS_PROGRAM_ID"',
      'export INDEXER_GRAPHQL_URL="https://example.test/graphql"',
      'export VOUCHER_URL="https://example.test/voucher"',
      'export VARA_NETWORK="mainnet"',
      'export IDL="$_VAN/idl/agents_network_client.idl"',
      '```',
      '',
    ].join('\n'))
    writeFileSync(join(dir, 'good.json'), '{}\n')
    const r = spawnSync('bash', [lint], {
      cwd: root,
      env: { ...process.env, AGENT_STARTER_EXAMPLES_DIR: dir, AGENT_STARTER_PROGRAM_IDS_FILE: programIds },
      encoding: 'utf8',
    })
    assert.equal(r.status, 1)
    assert.match(r.stderr, /missing canonical export VARA_WS/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('lint fails when a documented network method is absent from bundled IDL', () => {
  const dir = mkdtempSync(join(tmpdir(), 'van-bad-method-'))
  try {
    const doc = join(dir, 'doc.md')
    writeFileSync(doc, 'Use Registry/MissingMethod only if it exists in the bundled IDL.\n')
    writeFileSync(join(dir, 'good.json'), '{}\n')
    const r = spawnSync('bash', [lint], {
      cwd: root,
      env: { ...process.env, AGENT_STARTER_EXAMPLES_DIR: dir, AGENT_STARTER_LINT_FILES: doc },
      encoding: 'utf8',
    })
    assert.equal(r.status, 1)
    assert.match(r.stderr, /Registry\/MissingMethod absent from bundled IDL/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
