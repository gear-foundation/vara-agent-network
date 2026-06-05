import test from 'node:test'
import assert from 'node:assert/strict'
import {
  cmdWallet,
  cmdWaitBalance,
  cmdRegisterParticipant,
  cmdHash,
  cmdRegisterApp,
  cmdSubmitApp,
  cmdVerify,
  runOnboard,
  exitCodeFor,
} from '../scripts/onboard.mjs'

const OPERATOR = `0x${'a'.repeat(64)}`
const PROGRAM = `0x${'b'.repeat(64)}`
const OTHER = `0x${'c'.repeat(64)}`
const cfg = { account: 'acct', network: 'vara', pid: `0x${'d'.repeat(64)}`, idl: '/tmp/x.idl', voucher: 'v1' }

// Stateful fake vara-wallet: dispatches on argv shape, returns canned --json
// envelopes, records reads/writes, and MUTATES on-chain state on a write so the
// post-write state-proof query (SKILL.md §3) sees the result — exactly as the
// chain would. spec.failRead makes a given read method error (transport blip).
function makeWallet(spec = {}) {
  const calls = { reads: [], writes: [], created: false }
  let balanceCalls = 0
  let participant = spec.participant ?? null
  let application = spec.application ?? null
  const curBalance = n => (typeof spec.balance === 'function' ? spec.balance(n) : spec.balance)
  function wallet(argv) {
    if (argv[0] === 'wallet' && argv[1] === 'create') {
      calls.created = true
      return spec.createOk === false
        ? { ok: false, status: 1, stdout: '', stderr: 'create boom' }
        : { ok: true, status: 0, stdout: '', stderr: '' }
    }
    if (argv.includes('balance')) {
      balanceCalls++
      const b = curBalance(balanceCalls)
      if (!b) return { ok: false, status: 1, stdout: '', stderr: 'no account' }
      return { ok: true, status: 0, stdout: JSON.stringify({ result: b }), stderr: '' }
    }
    const ci = argv.indexOf('call')
    const method = argv[ci + 2]
    if (argv.includes('--json')) {
      calls.reads.push(method)
      if (spec.failRead === method) return { ok: false, status: 1, stdout: '', stderr: 'TRANSPORT_ERROR' }
      let result = null
      if (method === 'Registry/GetParticipant') result = participant
      else if (method === 'Registry/GetApplication') result = application
      else if (method === 'Registry/ResolveHandle') result = spec.resolve ?? null
      return { ok: true, status: 0, stdout: JSON.stringify({ result }), stderr: '' }
    }
    calls.writes.push(method)
    if (spec.writeOk === false) return { ok: false, status: 1, stdout: '', stderr: 'panic: HandleTaken' }
    // Reflect the write so the post-write verify query sees landed state.
    const addr = (curBalance(balanceCalls) || {}).address
    if (method === 'Registry/RegisterParticipant') {
      const args = JSON.parse(argv[argv.indexOf('--args') + 1])
      participant = { handle: args[0] }
    } else if (method === 'Registry/RegisterApplication') {
      application = { owner: addr, status: { kind: 'Building' } }
    } else if (method === 'Registry/SubmitApplication') {
      application = { ...(application || {}), status: { kind: 'Submitted' } }
    }
    return { ok: true, status: 0, stdout: 'success: true', stderr: '' }
  }
  return { wallet, calls }
}

function deps(spec, over = {}) {
  const { wallet, calls } = makeWallet(spec)
  return {
    d: {
      wallet,
      readFile: over.readFile ?? (() => Buffer.from('hello')),
      sleep: async () => {},
      log: () => {},
    },
    calls,
  }
}

// ── wallet ───────────────────────────────────────────────────────────────────

test('wallet: existing account is a no-op that returns hex', () => {
  const { d, calls } = deps({ balance: { address: OPERATOR, addressSS58: 'kGx' } })
  const res = cmdWallet(d, cfg)
  assert.equal(res.status, 'OK')
  assert.equal(res.data.hex, OPERATOR)
  assert.equal(calls.created, false)
})

test('wallet: missing account triggers create, then reads hex back', () => {
  const spec = makeWallet({ balance: () => (spec.calls.created ? { address: OPERATOR, addressSS58: 'kGx' } : null) })
  const res = cmdWallet({ wallet: spec.wallet, readFile: () => Buffer.from(''), sleep: async () => {}, log: () => {} }, cfg)
  assert.equal(res.status, 'OK')
  assert.equal(spec.calls.created, true)
  assert.equal(res.data.hex, OPERATOR)
})

// ── wait-balance ─────────────────────────────────────────────────────────────

test('wait-balance: returns OK once balance clears the threshold', async () => {
  const { d } = deps({ balance: { balanceRaw: '6000000000000' } }) // 6 VARA
  const res = await cmdWaitBalance(d, cfg, { minVara: '5', timeoutSec: 4, intervalSec: 2 })
  assert.equal(res.status, 'OK')
})

test('wait-balance: FAILs after timeout when balance stays low', async () => {
  const { d } = deps({ balance: { balanceRaw: '1000000000000' } }) // 1 VARA
  const res = await cmdWaitBalance(d, cfg, { minVara: '5', timeoutSec: 4, intervalSec: 2 })
  assert.equal(res.status, 'FAIL')
})

// ── register-participant ─────────────────────────────────────────────────────

test('register-participant: SKIPs (no write) when already registered', () => {
  const { d, calls } = deps({ balance: { address: OPERATOR }, participant: { handle: 'alice' } })
  const res = cmdRegisterParticipant(d, cfg, { handle: 'alice', githubUrl: 'https://github.com/alice' })
  assert.equal(res.status, 'SKIP')
  assert.deepEqual(calls.writes, [])
})

test('register-participant: writes then state-proves when handle is free', () => {
  const { d, calls } = deps({ balance: { address: OPERATOR }, participant: null, resolve: null })
  const res = cmdRegisterParticipant(d, cfg, { handle: 'alice', githubUrl: 'https://github.com/alice' })
  assert.equal(res.status, 'OK')
  assert.deepEqual(calls.writes, ['Registry/RegisterParticipant'])
})

test('register-participant: ABORTs (no write) when handle owned by another wallet', () => {
  const { d, calls } = deps({
    balance: { address: OPERATOR },
    participant: null,
    resolve: { kind: 'Participant', value: OTHER },
  })
  const res = cmdRegisterParticipant(d, cfg, { handle: 'alice', githubUrl: 'https://github.com/alice' })
  assert.equal(res.status, 'ABORT')
  assert.deepEqual(calls.writes, [])
})

test('register-participant: INCONCLUSIVE (no write) when the guard query itself fails', () => {
  const { d, calls } = deps({ balance: { address: OPERATOR }, failRead: 'Registry/GetParticipant' })
  const res = cmdRegisterParticipant(d, cfg, { handle: 'alice', githubUrl: 'https://github.com/alice' })
  assert.equal(res.status, 'INCONCLUSIVE')
  assert.deepEqual(calls.writes, [])
})

// ── hash ─────────────────────────────────────────────────────────────────────

test('hash: produces 0x-prefixed 64-hex commitments', () => {
  const { d } = deps({}, {})
  const res = cmdHash(d, { skillsPath: '/s.md', idlPath: '/p.idl' })
  assert.equal(res.status, 'OK')
  assert.match(res.data.skillsHash, /^0x[0-9a-f]{64}$/)
  assert.match(res.data.idlHash, /^0x[0-9a-f]{64}$/)
})

// ── register-app ─────────────────────────────────────────────────────────────

function appArgsFile(over = {}) {
  return () => Buffer.from(JSON.stringify([{ program_id: PROGRAM, handle: 'alice-app', operator: OPERATOR, ...over }]))
}

test('register-app: SKIPs when application already owned by this wallet', () => {
  const { d, calls } = deps(
    { balance: { address: OPERATOR }, application: { owner: OPERATOR, status: { kind: 'Building' } } },
    { readFile: appArgsFile() },
  )
  const res = cmdRegisterApp(d, cfg, { argsFile: '/a.json' })
  assert.equal(res.status, 'SKIP')
  assert.deepEqual(calls.writes, [])
})

test('register-app: ABORTs when application owned by another wallet', () => {
  const { d, calls } = deps(
    { balance: { address: OPERATOR }, application: { owner: OTHER, status: { kind: 'Building' } } },
    { readFile: appArgsFile() },
  )
  const res = cmdRegisterApp(d, cfg, { argsFile: '/a.json' })
  assert.equal(res.status, 'ABORT')
  assert.deepEqual(calls.writes, [])
})

test('register-app: ABORTs on the unified-handle collision before any chain call', () => {
  const { d, calls } = deps({ balance: { address: OPERATOR } }, { readFile: appArgsFile({ handle: 'alice' }) })
  const res = cmdRegisterApp(d, cfg, { argsFile: '/a.json', participantHandle: 'alice' })
  assert.equal(res.status, 'ABORT')
  assert.deepEqual(calls.writes, [])
})

test('register-app: ABORTs when the args-file operator is not the signing wallet', () => {
  const { d, calls } = deps({ balance: { address: OPERATOR } }, { readFile: appArgsFile({ operator: OTHER }) })
  const res = cmdRegisterApp(d, cfg, { argsFile: '/a.json' })
  assert.equal(res.status, 'ABORT')
  assert.deepEqual(calls.writes, [])
})

test('register-app: writes then state-proves when app is unregistered and handle is free', () => {
  const { d, calls } = deps(
    { balance: { address: OPERATOR }, application: null, resolve: null },
    { readFile: appArgsFile() },
  )
  const res = cmdRegisterApp(d, cfg, { argsFile: '/a.json', participantHandle: 'alice' })
  assert.equal(res.status, 'OK')
  assert.deepEqual(calls.writes, ['Registry/RegisterApplication'])
})

test('register-app: INCONCLUSIVE (no write) when the guard query fails', () => {
  const { d, calls } = deps(
    { balance: { address: OPERATOR }, failRead: 'Registry/GetApplication' },
    { readFile: appArgsFile() },
  )
  const res = cmdRegisterApp(d, cfg, { argsFile: '/a.json' })
  assert.equal(res.status, 'INCONCLUSIVE')
  assert.deepEqual(calls.writes, [])
})

// ── submit-app ───────────────────────────────────────────────────────────────

test('submit-app: submits then state-proves when status is Building', () => {
  const { d, calls } = deps({ application: { owner: OPERATOR, status: { kind: 'Building' } } })
  const res = cmdSubmitApp(d, cfg, { programId: PROGRAM })
  assert.equal(res.status, 'OK')
  assert.deepEqual(calls.writes, ['Registry/SubmitApplication'])
})

test('submit-app: SKIPs (no write) when already Submitted', () => {
  const { d, calls } = deps({ application: { owner: OPERATOR, status: { kind: 'Submitted' } } })
  const res = cmdSubmitApp(d, cfg, { programId: PROGRAM })
  assert.equal(res.status, 'SKIP')
  assert.deepEqual(calls.writes, [])
})

test('submit-app: ABORTs on an unexpected status', () => {
  const { d } = deps({ application: { owner: OPERATOR, status: { kind: 'Archived' } } })
  const res = cmdSubmitApp(d, cfg, { programId: PROGRAM })
  assert.equal(res.status, 'ABORT')
})

test('submit-app: INCONCLUSIVE (no write) when the guard query fails', () => {
  const { d, calls } = deps({ failRead: 'Registry/GetApplication' })
  const res = cmdSubmitApp(d, cfg, { programId: PROGRAM })
  assert.equal(res.status, 'INCONCLUSIVE')
  assert.deepEqual(calls.writes, [])
})

// ── verify ───────────────────────────────────────────────────────────────────

test('verify: OK when the application is present', () => {
  const { d } = deps({ application: { owner: OPERATOR, status: { kind: 'Submitted' } } })
  const res = cmdVerify(d, cfg, { programId: PROGRAM })
  assert.equal(res.status, 'OK')
  assert.equal(res.data.status, 'Submitted')
})

test('verify: FAILs when the application is missing', () => {
  const { d } = deps({ application: null })
  const res = cmdVerify(d, cfg, { programId: PROGRAM })
  assert.equal(res.status, 'FAIL')
})

// ── dispatch / config ────────────────────────────────────────────────────────

test('runOnboard: missing required config returns CONFIG (exit 2)', async () => {
  const res = await runOnboard('register-participant', { account: 'a' }, deps({}).d, {})
  assert.equal(res.status, 'CONFIG')
  assert.equal(exitCodeFor(res.status), 2)
})

test('runOnboard: non-numeric --min-vara is a clean CONFIG error, not a crash', async () => {
  const env = { VARA_NETWORK: 'vara' }
  const res = await runOnboard('wait-balance', { account: 'a', 'min-vara': 'abc' }, deps({}).d, env)
  assert.equal(res.status, 'CONFIG')
  assert.match(res.detail, /min-vara/)
})

test('runOnboard: env fills PID/IDL/VARA_NETWORK when flags omit them', async () => {
  const { d, calls } = deps({ balance: { address: OPERATOR }, participant: { handle: 'alice' } })
  const env = { VARA_NETWORK: 'vara', PID: `0x${'d'.repeat(64)}`, IDL: '/i.idl', VOUCHER_ID: 'v' }
  const res = await runOnboard('register-participant', { account: 'a', handle: 'alice', 'github-url': 'https://github.com/alice' }, d, env)
  assert.equal(res.status, 'SKIP')
  assert.deepEqual(calls.writes, [])
})

test('exitCodeFor: OK/SKIP→0, CONFIG→2, FAIL/ABORT/INCONCLUSIVE→1', () => {
  assert.equal(exitCodeFor('OK'), 0)
  assert.equal(exitCodeFor('SKIP'), 0)
  assert.equal(exitCodeFor('CONFIG'), 2)
  assert.equal(exitCodeFor('FAIL'), 1)
  assert.equal(exitCodeFor('ABORT'), 1)
  assert.equal(exitCodeFor('INCONCLUSIVE'), 1)
})
