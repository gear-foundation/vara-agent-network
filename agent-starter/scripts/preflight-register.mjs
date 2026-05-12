#!/usr/bin/env node
// Preflight checklist for Registry/RegisterApplication.
//
// Catches the failure modes that produce permanent junk registry entries
// (404 URLs, hash mismatches, /blob/ URLs serving HTML) BEFORE the call
// reaches the chain. The deployed program does not fetch URLs, so a wrong
// hash or unreachable URL becomes uncorrectable once `submit_application`
// flips status out of `Building`.
//
// Usage:
//   preflight-register.mjs --args path/to/register_application.json
//   preflight-register.mjs --skills-url ... --skills-hash 0x... --idl-url ...
//                          --idl-hash 0x... --github-url ... --handle ...
//                          [--description "..."]
//
// Exit codes:
//   0 = all hard checks passed (warnings OK)
//   1 = at least one hard check failed
//   2 = usage error

import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'

const USAGE = `preflight-register — pre-submit checklist for Registry/RegisterApplication

usage:
  preflight-register.mjs --args FILE
  preflight-register.mjs --skills-url URL --skills-hash 0x... \\
                         --idl-url URL --idl-hash 0x... \\
                         --github-url URL --handle HANDLE \\
                         [--description STR]

flags:
  --args FILE       read all fields from a register_application.json args file
                    (the outer-array form; fields read from element 0)
  --skills-url URL
  --skills-hash 0x  64 hex chars (optionally 0x-prefixed)
  --idl-url URL
  --idl-hash 0x
  --github-url URL
  --handle HANDLE
  --description STR optional; if present, runs the soft length check
  --help            print this and exit 0

individual flags override matching fields from --args.

exit: 0 ok, 1 hard check failed, 2 usage error.`

// --- ANSI colors -----------------------------------------------------------

// Per no-color.org, any value (including empty string) disables color.
// `process.env.NO_COLOR === ''` is falsy in JS, so check key presence.
const NO_COLOR = !process.stdout.isTTY || 'NO_COLOR' in process.env
const c = NO_COLOR
  ? { red: s => s, green: s => s, yellow: s => s, dim: s => s, bold: s => s }
  : {
      red: s => `\x1b[31m${s}\x1b[0m`,
      green: s => `\x1b[32m${s}\x1b[0m`,
      yellow: s => `\x1b[33m${s}\x1b[0m`,
      dim: s => `\x1b[2m${s}\x1b[0m`,
      bold: s => `\x1b[1m${s}\x1b[0m`,
    }

// --- arg parsing -----------------------------------------------------------

function parseArgs(argv) {
  const out = {}
  const flags = new Set([
    '--args',
    '--skills-url',
    '--skills-hash',
    '--idl-url',
    '--idl-hash',
    '--github-url',
    '--handle',
    '--description',
  ])
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--help' || a === '-h') {
      out.help = true
      continue
    }
    if (!flags.has(a)) {
      throw new Error(`unknown arg: ${a}`)
    }
    const v = argv[++i]
    if (v === undefined) throw new Error(`missing value for ${a}`)
    out[a.slice(2)] = v
  }
  return out
}

function loadArgsFile(path) {
  const raw = readFileSync(path, 'utf8')
  const data = JSON.parse(raw)
  // Cookbook Rule 1: outer-array form. Single-struct call → 1-element array.
  const obj = Array.isArray(data) ? data[0] : data
  if (!obj || typeof obj !== 'object') {
    throw new Error(`${path}: expected an array with a struct, or a bare struct`)
  }
  return obj
}

function mergeInputs(cli) {
  const fromFile = cli.args ? loadArgsFile(cli.args) : {}
  return {
    skillsUrl: cli['skills-url'] ?? fromFile.skills_url,
    skillsHash: cli['skills-hash'] ?? fromFile.skills_hash,
    idlUrl: cli['idl-url'] ?? fromFile.idl_url,
    idlHash: cli['idl-hash'] ?? fromFile.idl_hash,
    githubUrl: cli['github-url'] ?? fromFile.github_url,
    handle: cli.handle ?? fromFile.handle,
    description: cli.description ?? fromFile.description,
  }
}

// --- check infra -----------------------------------------------------------

const results = []

function pass(label, detail) {
  results.push({ kind: 'PASS', label, detail })
}
function warn(label, detail, hint) {
  results.push({ kind: 'WARN', label, detail, hint })
}
function fail(label, detail, hint) {
  results.push({ kind: 'FAIL', label, detail, hint })
}
function skip(label, reason) {
  results.push({ kind: 'SKIP', label, detail: reason })
}

// --- hash helpers ----------------------------------------------------------

function normaliseHash(input) {
  if (typeof input !== 'string') return null
  const s = input.startsWith('0x') || input.startsWith('0X') ? input.slice(2) : input
  if (!/^[0-9a-fA-F]{64}$/.test(s)) return null
  return s.toLowerCase()
}

function sha256Hex(buf) {
  return createHash('sha256').update(buf).digest('hex')
}

// --- network ---------------------------------------------------------------

// Cap fetched bodies so a `skills_url` pointing at a multi-GB file (typo or
// hostile) can't OOM the process before we get to the hash check. 10 MB is
// generous for a skills.md / IDL (live ones are <50 KB).
const MAX_FETCH_BYTES = 10 * 1024 * 1024

async function fetchBytes(url) {
  try {
    const res = await fetch(url, { redirect: 'follow' })
    if (!res.ok) {
      return { ok: false, status: res.status, bytes: null, error: null }
    }
    const declared = Number(res.headers.get('content-length'))
    if (Number.isFinite(declared) && declared > MAX_FETCH_BYTES) {
      return {
        ok: false,
        status: res.status,
        bytes: null,
        error: `content-length ${declared} exceeds cap ${MAX_FETCH_BYTES}`,
      }
    }
    // Stream — Content-Length can be absent or lie.
    const chunks = []
    let total = 0
    for await (const chunk of res.body) {
      total += chunk.length
      if (total > MAX_FETCH_BYTES) {
        return {
          ok: false,
          status: res.status,
          bytes: null,
          error: `body exceeded cap ${MAX_FETCH_BYTES} mid-stream`,
        }
      }
      chunks.push(chunk)
    }
    return { ok: true, status: res.status, bytes: Buffer.concat(chunks, total), error: null }
  } catch (e) {
    return { ok: false, status: 0, bytes: null, error: e.message ?? String(e) }
  }
}

async function headOk(url) {
  try {
    const res = await fetch(url, { method: 'HEAD', redirect: 'follow' })
    return { ok: res.ok, status: res.status, error: null }
  } catch (e) {
    return { ok: false, status: 0, error: e.message ?? String(e) }
  }
}

// --- individual checks -----------------------------------------------------

// Mirrors programs/agents-network/app/src/types.rs MAX_* constants. The
// on-chain register guard returns FieldTooLarge above these caps; surface
// the same boundary pre-flight so callers don't waste a chain round-trip.
const FIELD_CAPS = {
  github_url: 256,
  skills_url: 256,
  idl_url: 256,
  description: 280,
}

const GITHUB_PLACEHOLDERS = new Set([
  'example',
  'test',
  'placeholder',
  'username',
  'your-name',
  'yourname',
  'repo',
  'org',
  'foo',
  'bar',
])

function checkFieldLength(field, value) {
  if (value === undefined || value === null) return
  const cap = FIELD_CAPS[field]
  const len = Buffer.byteLength(String(value), 'utf8')
  if (len > cap) {
    fail(`${field} length`, `${len} bytes exceeds on-chain cap ${cap}`, 'register guard rejects with FieldTooLarge')
  }
}

function checkHandle(handle) {
  if (!handle) {
    fail('handle', 'missing')
    return
  }
  if (!/^[a-z0-9_-]{3,32}$/.test(handle)) {
    fail('handle', `"${handle}" doesn't match [a-z0-9_-]{3,32}`, 'matches on-chain validate_handle')
    return
  }
  pass('handle', `"${handle}"`)
}

function checkGithubUrlFormat(url) {
  if (!url) {
    fail('github_url format', 'missing')
    return false
  }
  if (!url.startsWith('https://github.com/')) {
    fail('github_url format', `"${url}" must start with https://github.com/`, 'on-chain validate_github_url rejects bare github.com/me')
    return false
  }
  const tail = url.slice('https://github.com/'.length)
  // First path segment after the host.
  const seg = tail.split('/')[0].toLowerCase()
  if (!seg) {
    fail('github_url format', 'no owner segment after https://github.com/', 'the contract allows this but it points nowhere')
    return false
  }
  if (GITHUB_PLACEHOLDERS.has(seg)) {
    fail('github_url placeholder', `owner segment "${seg}" looks like an unfilled template`, `placeholders blocked: ${[...GITHUB_PLACEHOLDERS].join(', ')}`)
    return false
  }
  pass('github_url format', url)
  return true
}

async function checkGithubUrlReachable(url) {
  const r = await headOk(url)
  if (!r.ok) {
    const reason = r.error ? `error: ${r.error}` : `HTTP ${r.status}`
    fail('github_url reachable', reason, 'repo is private or doesn\'t exist')
    return
  }
  pass('github_url reachable', `HTTP ${r.status}`)
}

function checkIdlUrlFormat(url) {
  if (!url) {
    fail('idl_url format', 'missing')
    return false
  }
  if (!(url.startsWith('https://') || url.startsWith('ipfs://'))) {
    fail('idl_url format', `"${url}" must start with https:// or ipfs://`, 'mirrors on-chain validate_idl_url')
    return false
  }
  if (!url.endsWith('.idl')) {
    fail('idl_url format', `"${url}" must end with lowercase .idl`, 'mirrors on-chain validate_idl_url — .IDL / .idl.txt rejected')
    return false
  }
  pass('idl_url format', url)
  return true
}

function checkHashNonZero(label, hashHex) {
  if (hashHex === null) {
    fail(label, 'missing or not a 64-char hex string (0x prefix optional)')
    return false
  }
  if (/^0+$/.test(hashHex)) {
    fail(label, 'all-zero hash rejected by on-chain validate_hash')
    return false
  }
  pass(label, `0x${hashHex.slice(0, 12)}…`)
  return true
}

async function checkFetchAndHash(label, url, expectedHex) {
  if (!url || expectedHex === null) {
    skip(label, 'skipped (input missing)')
    return null
  }
  const r = await fetchBytes(url)
  if (!r.ok) {
    const reason = r.error ? `error: ${r.error}` : `HTTP ${r.status}`
    fail(`${label} reachable`, reason, 'url 404 / wrong branch / private repo — readers will see junk')
    return null
  }
  pass(`${label} reachable`, `HTTP ${r.status}, ${r.bytes.length} bytes`)
  const actual = sha256Hex(r.bytes)
  if (actual !== expectedHex) {
    fail(
      `${label} hash`,
      `expected 0x${expectedHex}\n           actual   0x${actual}`,
      'did you edit the file after computing the hash, or point at a different branch/commit?'
    )
    // Return bytes even on FAIL so content-sanity warnings (TODO/Lorem ipsum,
    // missing heading) still surface — the user wants every signal at once.
    return r.bytes
  }
  pass(`${label} hash`, `SHA-256 matches 0x${expectedHex.slice(0, 12)}…`)
  return r.bytes
}

function checkSkillsUrlShape(url) {
  // Soft hints unique to skills_url. The hash check is what enforces
  // correctness; these warnings explain *why* a hash would mismatch.
  if (!url) return
  try {
    const u = new URL(url)
    if (u.hostname === 'gist.github.com' || u.hostname === 'gist.githubusercontent.com') {
      warn('skills_url stability', `${u.hostname} URLs work but can be deleted and don't pin to a commit`, 'fine for first registration; move to a versioned repo URL before submit_application')
    }
    if (u.hostname === 'github.com' && u.pathname.includes('/blob/')) {
      warn('skills_url is /blob/', 'github.com/.../blob/... serves rendered HTML, not raw bytes', 'use /raw/ or raw.githubusercontent.com — otherwise the hash will never match')
    }
  } catch {
    // URL parse failed — the hash/reachable checks already surfaced it.
  }
}

function checkSkillsContent(bytes) {
  if (!bytes) return
  if (bytes.length < 200) {
    warn('skills.md size', `only ${bytes.length} bytes`, 'looks like a stub; full skills.md should describe capabilities, API surface, contacts')
  }
  const text = bytes.toString('utf8')
  if (!/(^|\n)\s*#\s/.test(text)) {
    warn('skills.md heading', 'no markdown # heading detected', 'is this actually markdown?')
  }
  const stubs = ['TODO', 'FIXME', 'Lorem ipsum', 'placeholder text']
  const lower = text.toLowerCase()
  for (const s of stubs) {
    if (lower.includes(s.toLowerCase())) {
      warn('skills.md content', `contains "${s}"`, 'left-over template content?')
      break
    }
  }
}

function checkIdlContent(bytes) {
  if (!bytes) return
  const text = bytes.toString('utf8')
  if (!/\bservice\b/.test(text)) {
    warn('idl content', 'no "service" keyword found', 'is this a Sails IDL? Sails IDL declares one or more service blocks')
  }
}

function checkDescription(desc) {
  if (desc === undefined || desc === null) return
  const trimmed = String(desc).trim()
  if (trimmed.length === 0) {
    warn('description', 'empty / whitespace-only', 'on-chain register guard accepts it but readers see nothing')
    return
  }
  if (trimmed.length < 40) {
    warn('description', `${trimmed.length} chars after trim`, 'short descriptions hurt discoverability; aim for 1-2 sentences')
  }
}

// --- main ------------------------------------------------------------------

async function main() {
  let cli
  try {
    cli = parseArgs(process.argv.slice(2))
  } catch (e) {
    console.error(e.message)
    console.error('')
    console.error(USAGE)
    process.exit(2)
  }

  if (cli.help) {
    console.log(USAGE)
    process.exit(0)
  }

  if (process.argv.length <= 2) {
    console.error(USAGE)
    process.exit(2)
  }

  let inputs
  try {
    inputs = mergeInputs(cli)
  } catch (e) {
    console.error(`failed to load --args: ${e.message}`)
    process.exit(2)
  }

  const skillsHashHex = normaliseHash(inputs.skillsHash)
  const idlHashHex = normaliseHash(inputs.idlHash)

  console.log(c.bold('preflight-register — pre-submit checklist'))
  console.log(c.dim('─'.repeat(55)))

  // Hard checks (order: cheap-first, network-last)
  checkHandle(inputs.handle)
  checkGithubUrlFormat(inputs.githubUrl)
  checkIdlUrlFormat(inputs.idlUrl)
  checkFieldLength('github_url', inputs.githubUrl)
  checkFieldLength('skills_url', inputs.skillsUrl)
  checkFieldLength('idl_url', inputs.idlUrl)
  checkFieldLength('description', inputs.description)
  checkHashNonZero('skills_hash non-zero', skillsHashHex)
  checkHashNonZero('idl_hash non-zero', idlHashHex)

  // Soft URL hints (run before network so the hint is visible alongside the
  // subsequent hash-mismatch failure when /blob/ is the cause).
  checkSkillsUrlShape(inputs.skillsUrl)

  // Network checks — all three independent, run in parallel. Result ordering
  // among these three is non-deterministic by design (they push as they
  // resolve); checklist users care about pass/fail, not relative order.
  const githubReachable = inputs.githubUrl && inputs.githubUrl.startsWith('https://github.com/')
    ? checkGithubUrlReachable(inputs.githubUrl)
    : Promise.resolve()
  const [skillsBytes, idlBytes] = await Promise.all([
    checkFetchAndHash('skills_url', inputs.skillsUrl, skillsHashHex),
    checkFetchAndHash('idl_url', inputs.idlUrl, idlHashHex),
    githubReachable,
  ])

  // Content sanity (soft)
  checkSkillsContent(skillsBytes)
  checkIdlContent(idlBytes)
  checkDescription(inputs.description)

  // Render
  let fails = 0
  let warns = 0
  for (const r of results) {
    let tag
    if (r.kind === 'PASS') {
      tag = c.green('[PASS]')
    } else if (r.kind === 'WARN') {
      tag = c.yellow('[WARN]')
      warns++
    } else if (r.kind === 'FAIL') {
      tag = c.red('[FAIL]')
      fails++
    } else {
      tag = c.dim('[SKIP]')
    }
    console.log(`${tag} ${r.label}${r.detail ? ` — ${r.detail}` : ''}`)
    if (r.hint) console.log(c.dim(`       hint: ${r.hint}`))
  }

  console.log(c.dim('─'.repeat(55)))
  if (fails > 0) {
    console.log(c.red(`${fails} FAIL${fails === 1 ? '' : 's'}`) + (warns ? `, ${c.yellow(`${warns} WARN${warns === 1 ? '' : 's'}`)}` : '') + ' — do NOT register. Fix and re-run.')
    process.exit(1)
  }
  if (warns > 0) {
    console.log(c.yellow(`0 FAILs, ${warns} WARN${warns === 1 ? '' : 's'}`) + ' — ready to register (review warnings).')
  } else {
    console.log(c.green('all checks passed — ready to register.'))
  }
  process.exit(0)
}

main().catch(e => {
  console.error(`preflight-register: unexpected error: ${e?.stack ?? e}`)
  process.exit(2)
})
