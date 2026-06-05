import test from 'node:test'
import assert from 'node:assert/strict'
import {
  checkRegistrationInputs,
  normaliseHash,
  sha256Hex,
} from '../scripts/preflight-checks.mjs'

const skills = Buffer.from('# Skills\n\nThis agent has enough markdown content to avoid the short-stub warning. It documents capabilities, API surface, contact channels, and expected consumers for a real deployed service.\n')
const idl = Buffer.from('service Echo {\n  query Ping : () -> bool;\n};\n')

function validInputs(overrides = {}) {
  return {
    handle: 'alice-bounties',
    githubUrl: 'https://github.com/alice/alice-bounties',
    skillsUrl: 'https://example.test/skills.md',
    skillsHash: `0x${sha256Hex(skills)}`,
    idlUrl: 'https://example.test/agent.idl',
    idlHash: `0x${sha256Hex(idl)}`,
    description: 'Bounty escrow service with a callable oracle attestation route.',
    ...overrides,
  }
}

function deps(fetchMap = {}) {
  return {
    headOk: async () => ({ ok: true, status: 200, error: null }),
    fetchBytes: async url => fetchMap[url] ?? { ok: false, status: 404, bytes: null, error: null },
  }
}

test('normaliseHash accepts 0x and bare hex and rejects malformed values', () => {
  const hex = 'A'.repeat(64)
  assert.equal(normaliseHash(`0x${hex}`), 'a'.repeat(64))
  assert.equal(normaliseHash(hex), 'a'.repeat(64))
  assert.equal(normaliseHash('0x1234'), null)
  assert.equal(normaliseHash(null), null)
})

test('registration checks pass for reachable artifacts with matching hashes', async () => {
  const result = await checkRegistrationInputs(validInputs(), deps({
    'https://example.test/skills.md': { ok: true, status: 200, bytes: skills, error: null },
    'https://example.test/agent.idl': { ok: true, status: 200, bytes: idl, error: null },
  }))
  assert.equal(result.results.some(r => r.kind === 'FAIL'), false)
  assert.equal(result.artifacts.skillsBytes.toString(), skills.toString())
  assert.equal(result.artifacts.idlBytes.toString(), idl.toString())
})

test('registration checks catch field caps and hash mismatches', async () => {
  const result = await checkRegistrationInputs(validInputs({
    githubUrl: `https://github.com/${'a'.repeat(260)}`,
    skillsHash: `0x${'1'.repeat(64)}`,
  }), deps({
    'https://example.test/skills.md': { ok: true, status: 200, bytes: skills, error: null },
    'https://example.test/agent.idl': { ok: true, status: 200, bytes: idl, error: null },
  }))
  const labels = result.results.filter(r => r.kind === 'FAIL').map(r => r.label)
  assert(labels.includes('github_url length'))
  assert(labels.includes('skills_url hash'))
})

test('registration checks surface URL and content sanity without module-global collector state', async () => {
  const first = await checkRegistrationInputs(validInputs({
    skillsUrl: 'https://github.com/alice/repo/blob/main/skills.md',
  }), deps({
    'https://github.com/alice/repo/blob/main/skills.md': { ok: true, status: 200, bytes: Buffer.from('TODO'), error: null },
    'https://example.test/agent.idl': { ok: true, status: 200, bytes: idl, error: null },
  }))
  assert(first.results.some(r => r.kind === 'WARN' && r.label === 'skills_url is /blob/'))

  const second = await checkRegistrationInputs(validInputs(), deps({
    'https://example.test/skills.md': { ok: true, status: 200, bytes: skills, error: null },
    'https://example.test/agent.idl': { ok: true, status: 200, bytes: idl, error: null },
  }))
  assert.equal(second.results.some(r => r.label === 'skills_url is /blob/'), false)
})
