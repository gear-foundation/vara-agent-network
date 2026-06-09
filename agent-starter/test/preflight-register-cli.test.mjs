import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'

const here = dirname(fileURLToPath(import.meta.url))
const script = join(here, '..', 'scripts', 'preflight-register.mjs')

test('preflight-register --help exits 0', () => {
  const r = spawnSync(process.execPath, [script, '--help'], { encoding: 'utf8' })
  assert.equal(r.status, 0)
  assert.match(r.stdout, /preflight-register/)
})

test('preflight-register usage errors exit 2', () => {
  const r = spawnSync(process.execPath, [script], { encoding: 'utf8' })
  assert.equal(r.status, 2)
  assert.match(r.stderr, /usage:/)
})

test('preflight-register hard-check failures exit 1', () => {
  const r = spawnSync(process.execPath, [
    script,
    '--handle', 'Bad.Handle',
    '--github-url', 'github.com/alice/repo',
    '--skills-url', 'https://example.test/skills.md',
    '--skills-hash', `0x${'1'.repeat(64)}`,
    '--idl-url', 'https://example.test/agent.idl',
    '--idl-hash', `0x${'2'.repeat(64)}`,
  ], { encoding: 'utf8' })
  assert.equal(r.status, 1)
  assert.match(r.stdout, /\[FAIL\]/)
})

test('preflight-register reads args file and lets CLI flags override it', () => {
  const dir = mkdtempSync(join(tmpdir(), 'van-preflight-args-'))
  try {
    const argsFile = join(dir, 'register.json')
    writeFileSync(argsFile, JSON.stringify([{
      handle: 'bad.handle',
      github_url: 'github.com/example/repo',
      skills_url: 'https://example.test/skills.md',
      skills_hash: `0x${'1'.repeat(64)}`,
      idl_url: 'https://example.test/agent.idl',
      idl_hash: `0x${'2'.repeat(64)}`,
    }]))
    const r = spawnSync(process.execPath, [
      script,
      '--args', argsFile,
      '--handle', 'good-handle',
    ], { encoding: 'utf8' })
    assert.equal(r.status, 1)
    assert.doesNotMatch(r.stdout, /bad\.handle/)
    assert.match(r.stdout, /\[PASS\] handle/)
    assert.match(r.stdout, /\[FAIL\] github_url format/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('preflight-register reports bad args JSON as usage error', () => {
  const dir = mkdtempSync(join(tmpdir(), 'van-preflight-bad-json-'))
  try {
    const argsFile = join(dir, 'register.json')
    writeFileSync(argsFile, '{not json')
    const r = spawnSync(process.execPath, [script, '--args', argsFile], { encoding: 'utf8' })
    assert.equal(r.status, 2)
    assert.match(r.stderr, /failed to load --args/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
