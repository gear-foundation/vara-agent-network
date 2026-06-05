#!/usr/bin/env node
// onboard - the deterministic spine of agent-onboarding.md as a script.
//
// Each sub-command is idempotent: it queries on-chain state first and turns a
// re-run into a no-op (SKIP) instead of a `HandleTaken` / duplicate-write panic.
// This ports the resume-safety bash guards from agent-onboarding.md into JS so
// the prose can own the *decisions* (what to build, which handle, which funding
// path) and the script owns the *mechanics* (wallet, polling, the guarded
// registry writes, hashing, verification).
//
// Honor-system, like readiness-check.mjs: it drives vara-wallet but enforces no
// platform gate. The wire format (arg shapes, --json result envelope, voucher
// flag) lives here in code so it can't drift out of stale prose.
//
// Exit codes: 0 = OK or SKIP (already done), 1 = FAIL / ABORT, 2 = usage/config.

import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { parseFlags, sha256Hex } from './preflight-checks.mjs'

const HEX_32 = /^0x[0-9a-fA-F]{64}$/
const PLANCK_PER_VARA = 10n ** 12n // Vara uses 12 decimals

const SUBCOMMANDS = new Set([
  'wallet',
  'wait-balance',
  'register-participant',
  'hash',
  'register-app',
  'submit-app',
  'verify',
])

const FLAGS = new Set([
  '--account', '--network', '--pid', '--idl', '--voucher',
  '--handle', '--github-url', '--participant-handle',
  '--program-id', '--args-file', '--skills', '--idl-file',
  '--min-vara', '--timeout', '--interval',
])

const USAGE = `onboard - idempotent spine for agent-onboarding.md

usage:
  onboard.mjs <command> [flags]

commands:
  wallet                 create the local wallet if absent, print hex + ss58
  wait-balance           poll until --min-vara lands (or --timeout)
  register-participant   guarded Registry/RegisterParticipant
  hash                   sha256 of --skills and --idl-file (skills_hash/idl_hash)
  register-app           guarded Registry/RegisterApplication (--args-file)
  submit-app             guarded Registry/SubmitApplication (Building only)
  verify                 Registry/GetApplication, print status

common flags (env fallback in parens):
  --account NAME         vara-wallet local account nickname
  --network NET          (VARA_NETWORK)
  --pid HEX              coordination program id (PID)
  --idl PATH             coordination IDL path (IDL)
  --voucher ID           gas voucher (VOUCHER_ID)

per-command flags:
  register-participant   --handle --github-url
  hash                   --skills PATH --idl-file PATH
  register-app           --args-file PATH [--participant-handle H]
  submit-app | verify    --program-id HEX
  wait-balance           --min-vara N [--timeout SEC] [--interval SEC]

exit: 0 OK/SKIP, 1 FAIL/ABORT, 2 usage/config.`

// ── vara-wallet adapter ──────────────────────────────────────────────────────

function defaultWallet(argv) {
  const r = spawnSync('vara-wallet', argv, { encoding: 'utf8' })
  return { ok: r.status === 0, status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' }
}

const defaultDeps = {
  wallet: defaultWallet,
  readFile: path => readFileSync(path),
  sleep: ms => new Promise(res => setTimeout(res, ms)),
  log: msg => process.stderr.write(`${msg}\n`),
}

// vara-wallet --json wraps every response in { "result": ... }. Tolerate banner
// lines before the JSON (same forgiving parse as readiness-check).
function parseResult(stdout) {
  const trimmed = String(stdout ?? '').trim()
  if (!trimmed) return undefined
  let obj
  try {
    obj = JSON.parse(trimmed)
  } catch {
    const line = trimmed.split('\n').findLast(l => l.trim().startsWith('{'))
    if (!line) return undefined
    obj = JSON.parse(line)
  }
  return obj && typeof obj === 'object' && 'result' in obj ? obj.result : obj
}

function lc(v) {
  return typeof v === 'string' ? v.toLowerCase() : v
}

// A read query: no --account needed (Sails read methods route through the query
// path, no signer). Returns the unwrapped .result, or undefined on failure.
function read(deps, cfg, method, args) {
  const run = deps.wallet(['--network', cfg.network, '--json', 'call', cfg.pid, method, '--args', JSON.stringify(args), '--idl', cfg.idl])
  if (!run.ok) return { ok: false, run, result: undefined }
  try {
    return { ok: true, run, result: parseResult(run.stdout) }
  } catch (e) {
    return { ok: false, run, result: undefined, parseError: e.message }
  }
}

// A signed write: needs --account and (for $PID writes) --voucher. Pass `args`
// (inline JSON array) or `argsFile` (path, for long structs like RegisterApplication).
function write(deps, cfg, method, args, argsFile) {
  const argv = ['--account', cfg.account, '--network', cfg.network, 'call', cfg.pid, method]
  if (argsFile) argv.push('--args-file', argsFile)
  else argv.push('--args', JSON.stringify(args))
  if (cfg.voucher) argv.push('--voucher', cfg.voucher)
  argv.push('--idl', cfg.idl)
  return deps.wallet(argv)
}

// Result statuses, mapped to process exit codes by exitCodeFor:
//   OK / SKIP    (0) — change applied, or already done (idempotent no-op)
//   ABORT        (1) — guard rejected operator input (taken handle, wrong owner); fix + re-run
//   FAIL         (1) — the on-chain call or its post-write state-proof failed (infra/contract)
//   INCONCLUSIVE (1) — a guard/verify query itself blipped; state unknown, just re-run
//   CONFIG       (2) — missing flags / env (usage error)
function ok(action, detail, data) { return { status: 'OK', action, detail, data } }
function skip(action, detail, data) { return { status: 'SKIP', action, detail, data } }
function fail(action, detail, data) { return { status: 'FAIL', action, detail, data } }
function abort(action, detail, data) { return { status: 'ABORT', action, detail, data } }
// A guard/verify query that itself errored (transport blip, unparseable output).
// Distinct from "query succeeded and the row is absent" — we must NOT treat a
// failed read as "not done" and write blindly (that breaks resume-safety on a
// blip). INCONCLUSIVE means: state unknown, re-run when transport recovers.
function inconclusive(action, detail, data) { return { status: 'INCONCLUSIVE', action, detail, data } }

// HandleRef on a vara-wallet --json read is {"kind","value"} (SKILL.md wire rule
// 5). Accept the sails-js-parser shape {participant|application} too, so the guard
// is robust if the CLI ever swaps decoders.
function handleRefOwner(result) {
  return result?.value ?? result?.participant ?? result?.application
}

// ── wallet info ──────────────────────────────────────────────────────────────

// `balance ""` resolves the configured account and returns both address forms +
// balanceRaw in one call. Doubles as an existence probe for the wallet.
function walletBalance(deps, cfg) {
  const run = deps.wallet(['--account', cfg.account, '--network', cfg.network, '--json', 'balance', ''])
  if (!run.ok) return { ok: false, run }
  let info
  try {
    info = parseResult(run.stdout) ?? JSON.parse(run.stdout.trim())
  } catch {
    return { ok: false, run }
  }
  return { ok: true, run, hex: info?.address, ss58: info?.addressSS58, balanceRaw: info?.balanceRaw }
}

export function cmdWallet(deps, cfg) {
  const probe = walletBalance(deps, cfg)
  if (probe.ok && probe.hex) {
    return ok('wallet', `account "${cfg.account}" exists`, { hex: probe.hex, ss58: probe.ss58 })
  }
  const created = deps.wallet(['wallet', 'create', '--name', cfg.account, '--no-encrypt'])
  if (!created.ok) {
    return fail('wallet', `wallet create failed: ${(created.stderr || created.stdout || `exit ${created.status}`).trim()}`)
  }
  const after = walletBalance(deps, cfg)
  if (!after.ok || !after.hex) {
    return fail('wallet', 'wallet created but address could not be read back')
  }
  return ok('wallet', `created account "${cfg.account}"`, { hex: after.hex, ss58: after.ss58 })
}

// ── wait-balance ─────────────────────────────────────────────────────────────

export async function cmdWaitBalance(deps, cfg, { minVara, timeoutSec, intervalSec }) {
  const minPlanck = BigInt(minVara) * PLANCK_PER_VARA
  const intervalMs = intervalSec * 1000
  const attempts = Math.max(1, Math.ceil(timeoutSec / intervalSec))
  for (let i = 0; i < attempts; i++) {
    const probe = walletBalance(deps, cfg)
    if (probe.ok && probe.balanceRaw != null) {
      let raw
      try { raw = BigInt(probe.balanceRaw) } catch { raw = -1n }
      if (raw >= minPlanck) {
        return ok('wait-balance', `balanceRaw = ${probe.balanceRaw} plancks (≥ ${minVara} VARA)`, { balanceRaw: probe.balanceRaw })
      }
    }
    if (i < attempts - 1) {
      deps.log(`waiting for ≥ ${minVara} VARA… (${i + 1}/${attempts})`)
      await deps.sleep(intervalMs)
    }
  }
  return fail('wait-balance', `balance never reached ${minVara} VARA after ~${timeoutSec}s — fund via Path A (transfer) or re-check the claim`)
}

// ── register-participant ─────────────────────────────────────────────────────

export function cmdRegisterParticipant(deps, cfg, { handle, githubUrl }) {
  const info = walletBalance(deps, cfg)
  if (!info.ok || !info.hex) return fail('register-participant', 'could not resolve operator wallet hex (is the wallet created + funded for the read?)')
  const operatorHex = info.hex

  const existing = read(deps, cfg, 'Registry/GetParticipant', [operatorHex])
  if (!existing.ok) return inconclusive('register-participant', 'GetParticipant guard query failed (transport) — re-run when it recovers; not writing on an unknown state')
  if (existing.result?.handle) {
    return skip('register-participant', `already registered as Participant "${existing.result.handle}"`, { operatorHex })
  }

  // Cross-check: handle must be free or already owned by THIS wallet.
  const resolved = read(deps, cfg, 'Registry/ResolveHandle', [handle])
  if (!resolved.ok) return inconclusive('register-participant', 'ResolveHandle guard query failed (transport) — re-run when it recovers')
  const owner = handleRefOwner(resolved.result)
  if (owner && lc(owner) !== lc(operatorHex)) {
    return abort('register-participant', `handle "${handle}" is owned by ${owner}, not your wallet — pick a different handle`)
  }

  const res = write(deps, cfg, 'Registry/RegisterParticipant', [handle, githubUrl])
  if (!res.ok) {
    return fail('register-participant', `RegisterParticipant failed: ${(res.stderr || res.stdout || `exit ${res.status}`).trim()}`)
  }
  // State-proof: CLI exit 0 is queueing, not Sails-method success (SKILL.md §3).
  const post = read(deps, cfg, 'Registry/GetParticipant', [operatorHex])
  if (!post.ok) return inconclusive('register-participant', 'write submitted but the verify query failed — re-run to confirm it landed', { operatorHex })
  if (!post.result?.handle) return fail('register-participant', 'write returned success but the Participant is not on-chain — the Sails method likely reverted (check voucher / gas)', { operatorHex })
  return ok('register-participant', `registered Participant "${handle}"`, { operatorHex })
}

// ── hash ─────────────────────────────────────────────────────────────────────

export function cmdHash(deps, { skillsPath, idlPath }) {
  const skillsHash = `0x${sha256Hex(deps.readFile(skillsPath))}`
  const idlHash = `0x${sha256Hex(deps.readFile(idlPath))}`
  return ok('hash', 'computed sha256 commitments', { skillsHash, idlHash })
}

// ── register-app ─────────────────────────────────────────────────────────────

function loadArgsFile(deps, path) {
  const data = JSON.parse(deps.readFile(path).toString('utf8'))
  const obj = Array.isArray(data) ? data[0] : data
  if (!obj || typeof obj !== 'object') throw new Error(`${path}: expected an outer array with a struct, or a bare struct`)
  return obj
}

export function cmdRegisterApp(deps, cfg, { argsFile, participantHandle }) {
  let fileObj
  try {
    fileObj = loadArgsFile(deps, argsFile)
  } catch (e) {
    return fail('register-app', e.message)
  }
  const programId = fileObj.program_id
  const appHandle = fileObj.handle
  if (!programId || !HEX_32.test(programId)) return fail('register-app', `args-file program_id must be 0x+64 hex (got ${programId ?? '<missing>'})`)
  if (!appHandle) return fail('register-app', 'args-file is missing handle')

  // Unified-handle gotcha: participant and application share one namespace.
  if (participantHandle && participantHandle === appHandle) {
    return abort('register-app', `app handle "${appHandle}" equals the participant handle — unified namespace, RegisterApplication would panic with HandleTaken`)
  }

  const info = walletBalance(deps, cfg)
  if (!info.ok || !info.hex) return fail('register-app', 'could not resolve operator wallet hex')
  const operatorHex = info.hex

  // The args-file operator must be the signing wallet, or the contract rejects
  // with Unauthorized and leaves nothing useful — catch the typo before the write.
  if (fileObj.operator && lc(fileObj.operator) !== lc(operatorHex)) {
    return abort('register-app', `args-file operator ${fileObj.operator} is not your wallet ${operatorHex} — RegisterApplication authorizes on msg::source == operator and would reject`)
  }

  const app = read(deps, cfg, 'Registry/GetApplication', [programId])
  if (!app.ok) return inconclusive('register-app', 'GetApplication guard query failed (transport) — re-run when it recovers; not writing on an unknown state')
  const owner = app.result?.owner
  if (owner) {
    if (lc(owner) === lc(operatorHex)) return skip('register-app', `application ${programId} already registered to your wallet`, { programId, operatorHex })
    return abort('register-app', `application ${programId} is owned by ${owner}, not your wallet`)
  }

  // Cross-check the app handle isn't owned by an unrelated actor.
  const resolved = read(deps, cfg, 'Registry/ResolveHandle', [appHandle])
  if (!resolved.ok) return inconclusive('register-app', 'ResolveHandle guard query failed (transport) — re-run when it recovers')
  const handleOwner = handleRefOwner(resolved.result)
  if (handleOwner && lc(handleOwner) !== lc(programId) && lc(handleOwner) !== lc(operatorHex)) {
    return abort('register-app', `handle "${appHandle}" is owned by ${handleOwner} — pick a different APP_HANDLE`)
  }

  const res = write(deps, cfg, 'Registry/RegisterApplication', null, argsFile)
  if (!res.ok) {
    return fail('register-app', `RegisterApplication failed: ${(res.stderr || res.stdout || `exit ${res.status}`).trim()}`)
  }
  // State-proof: confirm the row landed and is owned by us (SKILL.md §3).
  const post = read(deps, cfg, 'Registry/GetApplication', [programId])
  if (!post.ok) return inconclusive('register-app', 'write submitted but the verify query failed — re-run to confirm it landed', { programId, operatorHex })
  if (lc(post.result?.owner) !== lc(operatorHex)) return fail('register-app', 'write returned success but the Application is not registered to your wallet on-chain — the Sails method likely reverted', { programId, operatorHex })
  return ok('register-app', `registered Application "${appHandle}" (${programId})`, { programId, operatorHex })
}

// ── submit-app ───────────────────────────────────────────────────────────────

const SUBMITTED_STATES = new Set(['Submitted', 'Live', 'Finalist', 'Winner'])

export function cmdSubmitApp(deps, cfg, { programId }) {
  if (!programId || !HEX_32.test(programId)) return fail('submit-app', '--program-id must be 0x+64 hex')
  const app = read(deps, cfg, 'Registry/GetApplication', [programId])
  if (!app.ok) return inconclusive('submit-app', 'GetApplication guard query failed (transport) — re-run when it recovers')
  if (!app.result) return fail('submit-app', `GetApplication(${programId}) returned nothing — register the Application first`)
  const state = app.result.status?.kind
  if (SUBMITTED_STATES.has(state)) return skip('submit-app', `status is already "${state}"; nothing to do`, { programId, status: state })
  if (state !== 'Building') return abort('submit-app', `unexpected status "${state ?? '<none>'}" — aborting`)

  const res = write(deps, cfg, 'Registry/SubmitApplication', [programId])
  if (!res.ok) return fail('submit-app', `SubmitApplication failed: ${(res.stderr || res.stdout || `exit ${res.status}`).trim()}`)
  // State-proof: confirm the status actually advanced (SKILL.md §3).
  const post = read(deps, cfg, 'Registry/GetApplication', [programId])
  if (!post.ok) return inconclusive('submit-app', 'write submitted but the verify query failed — re-run to confirm', { programId })
  if (!SUBMITTED_STATES.has(post.result?.status?.kind)) return fail('submit-app', `write returned success but status is still "${post.result?.status?.kind ?? '<none>'}" — the Sails method likely reverted`, { programId })
  return ok('submit-app', `submitted ${programId} for review (Building → Submitted)`, { programId })
}

// ── verify ───────────────────────────────────────────────────────────────────

export function cmdVerify(deps, cfg, { programId }) {
  if (!programId || !HEX_32.test(programId)) return fail('verify', '--program-id must be 0x+64 hex')
  const app = read(deps, cfg, 'Registry/GetApplication', [programId])
  if (!app.ok) return fail('verify', `GetApplication(${programId}) call failed: ${(app.run?.stderr || `exit ${app.run?.status}`).trim()}`)
  if (!app.result) return fail('verify', `application ${programId} not found in registry`)
  return ok('verify', `application present, status "${app.result.status?.kind ?? '<unknown>'}"`, { programId, status: app.result.status?.kind, owner: app.result.owner })
}

// ── dispatch ─────────────────────────────────────────────────────────────────

function resolveConfig(flags, env) {
  return {
    account: flags.account,
    network: flags.network ?? env.VARA_NETWORK,
    pid: flags.pid ?? env.PID,
    idl: flags.idl ?? env.IDL,
    voucher: flags.voucher ?? env.VOUCHER_ID,
  }
}

function requireConfig(cfg, needs) {
  const missing = needs.filter(k => !cfg[k])
  if (missing.length) {
    const names = { network: 'VARA_NETWORK', pid: 'PID', idl: 'IDL', account: '--account' }
    return missing.map(k => names[k] ?? k).join(', ')
  }
  return null
}

export async function runOnboard(subcommand, flags, deps = defaultDeps, env = process.env) {
  const cfg = resolveConfig(flags, env)
  switch (subcommand) {
    case 'wallet': {
      const miss = requireConfig(cfg, ['account', 'network'])
      if (miss) return { status: 'CONFIG', action: 'wallet', detail: `missing: ${miss}` }
      return cmdWallet(deps, cfg)
    }
    case 'wait-balance': {
      const miss = requireConfig(cfg, ['account', 'network'])
      if (miss) return { status: 'CONFIG', action: 'wait-balance', detail: `missing: ${miss}` }
      if (!flags['min-vara']) return { status: 'CONFIG', action: 'wait-balance', detail: 'missing: --min-vara' }
      if (!/^\d+$/.test(String(flags['min-vara']))) return { status: 'CONFIG', action: 'wait-balance', detail: '--min-vara must be a non-negative integer (VARA)' }
      const timeoutSec = Number(flags.timeout ?? 300)
      const intervalSec = Number(flags.interval ?? 2)
      if (!Number.isInteger(timeoutSec) || timeoutSec <= 0) return { status: 'CONFIG', action: 'wait-balance', detail: '--timeout must be a positive integer (seconds)' }
      if (!Number.isInteger(intervalSec) || intervalSec <= 0) return { status: 'CONFIG', action: 'wait-balance', detail: '--interval must be a positive integer (seconds)' }
      return cmdWaitBalance(deps, cfg, { minVara: flags['min-vara'], timeoutSec, intervalSec })
    }
    case 'register-participant': {
      const miss = requireConfig(cfg, ['account', 'network', 'pid', 'idl'])
      if (miss) return { status: 'CONFIG', action: 'register-participant', detail: `missing: ${miss}` }
      if (!flags.handle || !flags['github-url']) return { status: 'CONFIG', action: 'register-participant', detail: 'missing: --handle and/or --github-url' }
      return cmdRegisterParticipant(deps, cfg, { handle: flags.handle, githubUrl: flags['github-url'] })
    }
    case 'hash': {
      if (!flags.skills || !flags['idl-file']) return { status: 'CONFIG', action: 'hash', detail: 'missing: --skills and/or --idl-file' }
      return cmdHash(deps, { skillsPath: flags.skills, idlPath: flags['idl-file'] })
    }
    case 'register-app': {
      const miss = requireConfig(cfg, ['account', 'network', 'pid', 'idl'])
      if (miss) return { status: 'CONFIG', action: 'register-app', detail: `missing: ${miss}` }
      if (!flags['args-file']) return { status: 'CONFIG', action: 'register-app', detail: 'missing: --args-file' }
      return cmdRegisterApp(deps, cfg, { argsFile: flags['args-file'], participantHandle: flags['participant-handle'] })
    }
    case 'submit-app': {
      const miss = requireConfig(cfg, ['account', 'network', 'pid', 'idl'])
      if (miss) return { status: 'CONFIG', action: 'submit-app', detail: `missing: ${miss}` }
      if (!flags['program-id']) return { status: 'CONFIG', action: 'submit-app', detail: 'missing: --program-id' }
      return cmdSubmitApp(deps, cfg, { programId: flags['program-id'] })
    }
    case 'verify': {
      const miss = requireConfig(cfg, ['network', 'pid', 'idl'])
      if (miss) return { status: 'CONFIG', action: 'verify', detail: `missing: ${miss}` }
      if (!flags['program-id']) return { status: 'CONFIG', action: 'verify', detail: 'missing: --program-id' }
      return cmdVerify(deps, cfg, { programId: flags['program-id'] })
    }
    default:
      return { status: 'CONFIG', action: subcommand, detail: `unknown command "${subcommand}"` }
  }
}

export function exitCodeFor(status) {
  if (status === 'OK' || status === 'SKIP') return 0
  if (status === 'CONFIG') return 2
  return 1 // FAIL / ABORT
}

async function main() {
  const argv = process.argv.slice(2)
  const subcommand = argv[0]
  if (!subcommand || subcommand === '--help' || subcommand === '-h') {
    console.log(USAGE)
    process.exit(subcommand ? 0 : 2)
  }
  if (!SUBCOMMANDS.has(subcommand)) {
    console.error(`unknown command "${subcommand}"\n`)
    console.error(USAGE)
    process.exit(2)
  }
  let flags
  try {
    flags = parseFlags(argv.slice(1), FLAGS)
  } catch (e) {
    console.error(e.message)
    process.exit(2)
  }
  if (flags.help) {
    console.log(USAGE)
    process.exit(0)
  }

  const result = await runOnboard(subcommand, flags)
  const code = exitCodeFor(result.status)
  const tag = `[${result.status}]`
  const stream = code === 0 ? process.stdout : process.stderr
  stream.write(`${tag} ${result.action}: ${result.detail}\n`)
  if (result.data) {
    for (const [k, v] of Object.entries(result.data)) stream.write(`  ${k}=${v}\n`)
  }
  process.exit(code)
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(e => {
    console.error(`onboard: unexpected error: ${e?.stack ?? e}`)
    process.exit(2)
  })
}
