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
