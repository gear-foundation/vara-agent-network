#!/usr/bin/env node

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import {
  checkArtifactInputs,
  normaliseHash,
  parseFlags,
} from './preflight-checks.mjs'

const SCHEMA_VERSION = 'agent-starter-readiness/v2'
const STATUSES = new Set(['PASS', 'FAIL', 'SKIP', 'INCONCLUSIVE', 'MISCONFIGURED'])
const HEX_32 = /^0x[0-9a-fA-F]{64}$/
const REQUIRED_FIELDS = [
  'program_id',
  'github_url',
  'skills_url',
  'skills_hash',
  'idl_url',
  'idl_hash',
  'documented_method',
  'smoke_command',
]

const READINESS_FLAGS = new Set(['--manifest', '--out', '--retries'])

const ARTIFACT_CHECKS = [
  ['github_ok', new Set(['github_url format', 'github_url placeholder', 'github_url reachable'])],
  ['skills_ok', new Set(['skills_hash non-zero', 'skills_url reachable', 'skills_url hash', 'skills.md size', 'skills.md heading', 'skills.md content'])],
  ['idl_ok', new Set(['idl_url format', 'idl_hash non-zero', 'idl_url reachable', 'idl_url hash'])],
]

// skills.md content WARNs (stub / too-short / no-heading) block readiness even
// though preflight treats them as soft at registration time. Explicit set, not a
// label-prefix match, so a renamed/added preflight label can't silently change this.
const ESCALATED_WARN_LABELS = new Set(['skills.md size', 'skills.md heading', 'skills.md content'])

const USAGE = `readiness-check - honor-system readiness self-check

usage:
  readiness-check.mjs --manifest FILE [--out readiness.json] [--retries 2]

env:
  APP_HEX                deployed application program hex
  PID                    Vara Agent Network coordination program hex
  INDEXER_GRAPHQL_URL    public indexer GraphQL endpoint
  VARA_NETWORK           vara-wallet network name

exit: 0 PASS or INCONCLUSIVE, 1 FAIL, 2 MISCONFIGURED.`

function parseArgs(argv) {
  return parseFlags(argv, READINESS_FLAGS, { retries: '2', out: 'readiness.json' })
}

function check(name, status, detail, evidence = undefined) {
  if (!STATUSES.has(status)) throw new Error(`invalid status ${status}`)
  const row = { name, status, detail }
  if (evidence !== undefined) row.evidence = evidence
  return row
}

function statusFromPreflightResult(kind) {
  if (kind === 'PASS') return 'PASS'
  if (kind === 'FAIL') return 'FAIL'
  if (kind === 'SKIP') return 'SKIP'
  return 'INCONCLUSIVE'
}

function combineStatus(rows) {
  if (rows.some(r => r.status === 'MISCONFIGURED')) return 'MISCONFIGURED'
  if (rows.some(r => r.status === 'FAIL')) return 'FAIL'
  if (rows.some(r => r.status === 'INCONCLUSIVE')) return 'INCONCLUSIVE'
  if (rows.every(r => r.status === 'SKIP')) return 'SKIP'
  return 'PASS'
}

function exitCodeFor(overall) {
  if (overall === 'MISCONFIGURED') return 2
  if (overall === 'FAIL') return 1
  return 0
}

function commandWords(input) {
  const words = []
  let current = ''
  let quote = null
  let escaped = false
  for (const ch of String(input ?? '')) {
    if (escaped) {
      current += ch
      escaped = false
      continue
    }
    if (ch === '\\' && quote !== "'") {
      escaped = true
      continue
    }
    if (quote) {
      if (ch === quote) quote = null
      else current += ch
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      continue
    }
    if (/\s/.test(ch)) {
      if (current) {
        words.push(current)
        current = ''
      }
      continue
    }
    current += ch
  }
  if (quote) throw new Error('unterminated quote')
  if (escaped) current += '\\'
  if (current) words.push(current)
  return words
}

function expandKnownEnv(value, env) {
  return String(value ?? '').replace(/\$\{?([A-Z_][A-Z0-9_]*)\}?/g, (match, name) => {
    return Object.prototype.hasOwnProperty.call(env, name) ? env[name] : match
  })
}

function parseSmokeCommand(command, env) {
  const words = commandWords(command).map(word => expandKnownEnv(word, env))
  const valueAfter = flag => {
    const i = words.indexOf(flag)
    return i >= 0 ? words[i + 1] : undefined
  }
  const callIndex = words.indexOf('call')
  return {
    command: words[0],
    hasJson: words.includes('--json'),
    callIndex,
    programId: callIndex >= 0 ? words[callIndex + 1] : undefined,
    method: callIndex >= 0 ? words[callIndex + 2] : undefined,
    args: valueAfter('--args'),
    argsFile: valueAfter('--args-file'),
    idl: valueAfter('--idl'),
    network: valueAfter('--network'),
  }
}

// The smoke_command is recorded as copy-pasteable evidence; reject shell
// metacharacters so a manifest can't smuggle a second command into evidence.
const SHELL_METACHARS = /[;&|`]|\$\(|\|\||&&|>|</

function validateSmokeCommand(command, manifest, env) {
  const dequoted = String(command).replace(/"(?:\\.|[^"\\])*"|'[^']*'/g, '')
  if (SHELL_METACHARS.test(dequoted)) {
    return { ok: false, detail: 'smoke_command contains shell metacharacters outside quotes' }
  }
  let parsed
  try {
    parsed = parseSmokeCommand(command, env)
  } catch (e) {
    return { ok: false, detail: `smoke_command could not be parsed: ${e.message}` }
  }
  if (parsed.command !== 'vara-wallet') return { ok: false, detail: 'smoke_command must start with vara-wallet' }
  if (!parsed.hasJson) return { ok: false, detail: 'smoke_command must include --json' }
  if (parsed.callIndex < 0) return { ok: false, detail: 'smoke_command must use vara-wallet call' }
  if (parsed.programId?.toLowerCase() !== env.APP_HEX.toLowerCase()) {
    return { ok: false, detail: 'smoke_command program id must match APP_HEX' }
  }
  if (parsed.method !== manifest.documented_method.name) {
    return { ok: false, detail: `smoke_command method ${parsed.method ?? '<missing>'} does not match documented_method ${manifest.documented_method.name}` }
  }
  if (!parsed.idl) return { ok: false, detail: 'smoke_command must include --idl PATH' }
  if (parsed.network !== undefined && parsed.network !== env.VARA_NETWORK) {
    return { ok: false, detail: 'smoke_command --network must match VARA_NETWORK' }
  }
  // Args may be inline (--args JSON, verified against example_args) or external
  // (--args-file, the pack's recommended path for long args; not inline-comparable).
  if (parsed.args === undefined && parsed.argsFile === undefined) {
    return { ok: false, detail: 'smoke_command must include --args or --args-file' }
  }
  if (parsed.args !== undefined) {
    let smokeArgs
    try {
      smokeArgs = JSON.parse(parsed.args)
    } catch (e) {
      return { ok: false, detail: `smoke_command --args is not JSON: ${e.message}` }
    }
    if (safeJson(smokeArgs) !== safeJson(manifest.documented_method.example_args)) {
      return { ok: false, detail: 'smoke_command --args must match documented_method.example_args' }
    }
    return { ok: true, detail: 'smoke_command matches documented method, args, program, and network' }
  }
  return { ok: true, detail: 'smoke_command matches documented method via --args-file (args not inline-verified)' }
}

function safeJson(value) {
  return JSON.stringify(value, null, 2)
}

function loadManifest(path) {
  return JSON.parse(readFileSync(path, 'utf8'))
}

function methodNameParts(name) {
  if (typeof name !== 'string') return null
  const parts = name.split('/')
  if (parts.length !== 2 || !parts[0] || !parts[1]) return null
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(parts[0]) || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(parts[1])) return null
  return { service: parts[0], method: parts[1] }
}

function validateExpectedShape(shape) {
  if (!shape || typeof shape !== 'object' || Array.isArray(shape)) return 'expected_return_shape must be an object'
  if (!['null', 'boolean', 'number', 'string', 'array', 'object', 'any'].includes(shape.kind)) {
    return 'expected_return_shape.kind must be null|boolean|number|string|array|object|any'
  }
  if (shape.required !== undefined && (!Array.isArray(shape.required) || shape.required.some(v => typeof v !== 'string'))) {
    return 'expected_return_shape.required must be an array of strings'
  }
  return null
}

function documentedErrorsCheck(manifest) {
  const errors = manifest.documented_method?.error_behavior
  if (!Array.isArray(errors) || errors.length === 0) {
    return check('documented_errors', 'FAIL', 'documented_method.error_behavior must list at least one failure case')
  }
  const malformed = []
  for (const [idx, entry] of errors.entries()) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      malformed.push(`#${idx + 1} must be an object`)
      continue
    }
    if (typeof entry.case !== 'string' || !entry.case.trim()) malformed.push(`#${idx + 1}.case must be a non-empty string`)
    if (typeof entry.result !== 'string' || !entry.result.trim()) malformed.push(`#${idx + 1}.result must be a non-empty string`)
  }
  if (malformed.length) {
    return check('documented_errors', 'FAIL', malformed.join('; '))
  }
  return check('documented_errors', 'PASS', `${errors.length} documented failure case(s)`, { error_behavior: errors })
}

// Build/test proof: gtest + local-smoke results recorded by the builder. Like
// documented_errors, this is honor-system evidence — the check does not re-run
// cargo/local-smoke (no toolchain or local node guaranteed here); it requires the
// results be present, well-formed, and passing, and records them for inspection.
function buildProofCheck(manifest) {
  const bp = manifest.build_proof
  if (!bp || typeof bp !== 'object' || Array.isArray(bp)) {
    return check('build_proof', 'FAIL', 'manifest.build_proof is required (record gtest + local_smoke results)')
  }
  const problems = []
  const g = bp.gtest
  if (!g || typeof g !== 'object' || Array.isArray(g)) {
    problems.push('build_proof.gtest must be an object with passed/failed')
  } else {
    if (!Number.isInteger(g.passed) || g.passed < 0) problems.push('build_proof.gtest.passed must be a non-negative integer')
    if (!Number.isInteger(g.failed) || g.failed < 0) problems.push('build_proof.gtest.failed must be a non-negative integer')
  }
  const s = bp.local_smoke
  if (!s || typeof s !== 'object' || Array.isArray(s)) {
    problems.push('build_proof.local_smoke must be an object with ok/summary')
  } else {
    if (typeof s.ok !== 'boolean') problems.push('build_proof.local_smoke.ok must be a boolean')
    if (typeof s.summary !== 'string' || !s.summary.trim()) problems.push('build_proof.local_smoke.summary must be a non-empty string')
  }
  if (problems.length) return check('build_proof', 'FAIL', problems.join('; '))
  if (g.failed > 0) return check('build_proof', 'FAIL', `gtest reports ${g.failed} failing test(s)`, { gtest: g, local_smoke: s })
  if (s.ok !== true) return check('build_proof', 'FAIL', 'local_smoke.ok is false', { gtest: g, local_smoke: s })
  return check('build_proof', 'PASS', `gtest ${g.passed} passed / ${g.failed} failed; local smoke ok`, { gtest: g, local_smoke: s })
}

function validateManifestAndEnv(manifest, env) {
  const errors = []
  for (const field of REQUIRED_FIELDS) {
    if (manifest[field] === undefined || manifest[field] === null || manifest[field] === '') errors.push(`manifest.${field} is required`)
  }
  if (manifest.program_id && !HEX_32.test(manifest.program_id)) errors.push('manifest.program_id must be 0x plus 64 hex chars')
  if (env.APP_HEX && !HEX_32.test(env.APP_HEX)) errors.push('APP_HEX must be 0x plus 64 hex chars')
  if (env.APP_HEX && manifest.program_id && env.APP_HEX.toLowerCase() !== manifest.program_id.toLowerCase()) {
    errors.push('manifest.program_id must match APP_HEX when both are set')
  }
  for (const field of ['APP_HEX', 'PID', 'INDEXER_GRAPHQL_URL', 'VARA_NETWORK']) {
    if (!env[field]) errors.push(`${field} is required`)
  }
  if (env.PID && !HEX_32.test(env.PID)) errors.push('PID must be 0x plus 64 hex chars')
  if (manifest.documented_method) {
    const parts = methodNameParts(manifest.documented_method.name)
    if (!parts) errors.push('documented_method.name must be Service/Method')
    if (!Array.isArray(manifest.documented_method.example_args)) errors.push('documented_method.example_args must be an array')
    const shapeError = validateExpectedShape(manifest.documented_method.expected_return_shape)
    if (shapeError) errors.push(`documented_method.${shapeError}`)
  }
  if (normaliseHash(manifest.skills_hash) === null) errors.push('manifest.skills_hash must be 64 hex chars, optionally 0x-prefixed')
  if (normaliseHash(manifest.idl_hash) === null) errors.push('manifest.idl_hash must be 64 hex chars, optionally 0x-prefixed')
  return errors
}

function stripLineComments(text) {
  return text.split('\n').map(line => line.replace(/\s*\/\/.*$/, '')).join('\n')
}

function fieldNamesFromStructBody(body) {
  return [...String(body ?? '').matchAll(/\b([A-Za-z_][A-Za-z0-9_]*)\s*:/g)].map(f => f[1])
}

function setParsedMethod(methods, name, query, args, returnType) {
  methods.set(name, {
    name,
    query,
    args: args.trim(),
    returnType: returnType.trim(),
  })
}

function findNamedBlocks(text, regex) {
  const blocks = []
  regex.lastIndex = 0
  let match
  while ((match = regex.exec(text)) !== null) {
    const open = text.indexOf('{', match.index)
    if (open < 0) continue
    let depth = 0
    let close = -1
    for (let i = open; i < text.length; i++) {
      if (text[i] === '{') depth++
      else if (text[i] === '}') {
        depth--
        if (depth === 0) {
          close = i
          break
        }
      }
    }
    if (close < 0) break
    blocks.push({ name: match[1], body: text.slice(open + 1, close) })
    regex.lastIndex = close + 1
  }
  return blocks
}

export function parseIdlServices(idlText) {
  const typeDefs = new Map()
  const clean = stripLineComments(idlText)
  for (const m of idlText.matchAll(/\btype\s+([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(struct|enum|alias)?\s*([\s\S]*?);/g)) {
    const name = m[1]
    const body = m[3] ?? ''
    const kind = m[2] || (body.trim().startsWith('struct') ? 'struct' : body.trim().startsWith('enum') ? 'enum' : 'alias')
    const structBody = body.match(/struct\s*\{([\s\S]*)\}/)?.[1] ?? (kind === 'struct' ? body.match(/\{([\s\S]*)\}/)?.[1] : '')
    typeDefs.set(name, { kind, fields: fieldNamesFromStructBody(structBody) })
  }

  for (const block of findNamedBlocks(clean, /\bstruct\s+([A-Za-z_][A-Za-z0-9_]*)\s*\{/g)) {
    typeDefs.set(block.name, { kind: 'struct', fields: fieldNamesFromStructBody(block.body) })
  }
  for (const block of findNamedBlocks(clean, /\benum\s+([A-Za-z_][A-Za-z0-9_]*)\s*\{/g)) {
    if (!typeDefs.has(block.name)) typeDefs.set(block.name, { kind: 'enum', fields: [] })
  }

  const services = new Map()
  for (const svc of clean.matchAll(/\bservice\s+([A-Za-z_][A-Za-z0-9_]*)\s*\{([\s\S]*?)^\};/gm)) {
    const service = svc[1]
    const methods = new Map()
    for (const line of svc[2].split('\n')) {
      const m = line.trim().match(/^(query\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*:\s*\((.*)\)\s*->\s*([^;]+);$/)
      if (!m) continue
      setParsedMethod(methods, m[2], Boolean(m[1]), m[3], m[4])
    }
    services.set(service, methods)
  }
  for (const svc of findNamedBlocks(clean, /\bservice\s+([A-Za-z_][A-Za-z0-9_]*)(?:@[^\s{]+)?\s*\{/g)) {
    const methods = services.get(svc.name) ?? new Map()
    let pendingQuery = false
    for (const line of svc.body.split('\n')) {
      const trimmed = line.trim()
      if (trimmed === '@query') {
        pendingQuery = true
        continue
      }
      const m = trimmed.match(/^(@query\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*\((.*)\)\s*->\s*([^;]+);$/)
      if (!m) {
        if (trimmed && !['functions', 'types', '{', '}'].includes(trimmed)) pendingQuery = false
        continue
      }
      setParsedMethod(methods, m[2], Boolean(m[1]) || pendingQuery, m[3], m[4])
      pendingQuery = false
    }
    services.set(svc.name, methods)
  }
  return { services, typeDefs }
}

function scalarKind(type, typeDefs) {
  const t = type.trim()
  const option = t.match(/^Option<(.+)>$/)
  if (option) return { kind: 'optional', inner: scalarKind(option[1], typeDefs) }
  const opt = t.match(/^opt\s+(.+)$/)
  if (opt) return { kind: 'optional', inner: scalarKind(opt[1], typeDefs) }
  const vec = t.match(/^Vec<(.+)>$/)
  if (vec) return { kind: 'array' }
  const result = t.match(/^Result<([^,>]+),\s*([^>]+)>$/)
  if (result) return scalarKind(result[1], typeDefs)
  // Sails IDL renders Result as lowercase `result (Ok, Err)`.
  const resultLower = t.match(/^result\s*\(\s*([^,]+?)\s*,\s*(.+)\)$/)
  if (resultLower) return scalarKind(resultLower[1], typeDefs)
  if (t === 'null' || t === '()' || t === 'void') return { kind: 'null' }
  if (t === 'bool') return { kind: 'boolean' }
  if (/^(u|i)(8|16|32|64|128|256)$/.test(t)) return { kind: 'number' }
  if (t === 'str' || t === 'String' || t === 'actor_id' || t === 'ActorId') return { kind: 'string' }
  if (t.startsWith('vec ')) return { kind: 'array' }
  if (t.startsWith('[')) return { kind: 'array' }
  const def = typeDefs.get(t)
  if (def?.kind === 'struct') return { kind: 'object', required: def.fields }
  if (def?.kind === 'enum') return { kind: 'object', required: ['kind'] }
  if (/^[A-Z]/.test(t)) return { kind: 'object', required: [] }
  return { kind: 'any' }
}

export function isReturnShapeCompatible(returnType, expectedShape, typeDefs = new Map()) {
  const expected = expectedShape?.kind
  if (expected === 'any') return { ok: true, detail: 'any accepts IDL return type' }
  const actual = scalarKind(returnType, typeDefs)
  if (actual.kind === 'optional') {
    if (expected === 'null') return { ok: true, detail: 'expected null is compatible with optional return' }
    return actual.inner.kind === expected || actual.inner.kind === 'any'
      ? { ok: true, detail: `expected ${expected} matches optional ${returnType}` }
      : { ok: false, detail: `expected ${expected}, IDL returns ${returnType}` }
  }
  if (actual.kind !== expected && actual.kind !== 'any') {
    return { ok: false, detail: `expected ${expected}, IDL returns ${returnType}` }
  }
  if (expected === 'object' && expectedShape.required?.length && actual.required?.length) {
    const missing = expectedShape.required.filter(field => !actual.required.includes(field))
    if (missing.length) return { ok: false, detail: `expected required fields not in IDL return type: ${missing.join(', ')}` }
  }
  return { ok: true, detail: `expected ${expected} matches IDL return ${returnType}` }
}

function valueMatchesShape(value, shape) {
  const kind = shape.kind
  if (kind === 'any') return { ok: true, detail: 'any accepts returned result' }
  if (kind === 'null') return value === null ? { ok: true, detail: 'result is null' } : { ok: false, detail: `result is ${Array.isArray(value) ? 'array' : typeof value}, expected null` }
  if (kind === 'array') return Array.isArray(value) ? { ok: true, detail: 'result is array' } : { ok: false, detail: `result is ${typeof value}, expected array` }
  if (kind === 'object') {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return { ok: false, detail: `result is ${Array.isArray(value) ? 'array' : typeof value}, expected object` }
    const missing = (shape.required ?? []).filter(field => !(field in value))
    return missing.length ? { ok: false, detail: `result missing required fields: ${missing.join(', ')}` } : { ok: true, detail: 'result is object' }
  }
  return typeof value === kind ? { ok: true, detail: `result is ${kind}` } : { ok: false, detail: `result is ${typeof value}, expected ${kind}` }
}

async function defaultGraphql(url, query, variables) {
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query, variables }),
    })
    if (!res.ok) return { ok: false, status: res.status, error: `HTTP ${res.status}` }
    const json = await res.json()
    if (json.errors?.length) return { ok: false, status: res.status, error: JSON.stringify(json.errors) }
    return { ok: true, status: res.status, data: json.data }
  } catch (e) {
    return { ok: false, status: 0, error: e.message ?? String(e) }
  }
}

function defaultCommandExists(cmd) {
  const r = spawnSync(cmd, ['--version'], { encoding: 'utf8' })
  return r.status === 0
}

function defaultRunVaraWallet({ programId, method, args, idlText, network }) {
  const dir = mkdtempSync(join(tmpdir(), 'van-readiness-'))
  const idlPath = join(dir, 'target.idl')
  try {
    writeFileSync(idlPath, idlText)
    const result = spawnSync('vara-wallet', [
      '--network', network,
      '--json',
      'call',
      programId,
      method,
      '--args',
      JSON.stringify(args),
      '--idl',
      idlPath,
    ], { encoding: 'utf8' })
    return {
      ok: result.status === 0,
      status: result.status,
      stdout: result.stdout ?? '',
      stderr: result.stderr ?? '',
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

function defaultDeps() {
  if (process.env.VAN_READINESS_FIXTURE) {
    const fixture = JSON.parse(readFileSync(process.env.VAN_READINESS_FIXTURE, 'utf8'))
    return fixtureDeps(fixture)
  }
  return {
    graphql: defaultGraphql,
    commandExists: defaultCommandExists,
    runVaraWallet: defaultRunVaraWallet,
  }
}

export function fixtureDeps(fixture) {
  return {
    fetchBytes: async url => {
      const entry = fixture.fetch?.[url]
      if (!entry) return { ok: false, status: 404, bytes: null, error: null }
      if (entry.error) return { ok: false, status: entry.status ?? 0, bytes: null, error: entry.error }
      const body = Buffer.from(entry.body ?? '', 'utf8')
      return { ok: entry.status === undefined || (entry.status >= 200 && entry.status < 300), status: entry.status ?? 200, bytes: body, error: null }
    },
    headOk: async url => {
      const entry = fixture.head?.[url]
      if (!entry) return { ok: false, status: 404, error: null }
      return { ok: entry.ok ?? ((entry.status ?? 200) >= 200 && (entry.status ?? 200) < 300), status: entry.status ?? 200, error: entry.error ?? null }
    },
    graphql: async () => {
      if (fixture.graphql?.error) return { ok: false, status: fixture.graphql.status ?? 0, error: fixture.graphql.error }
      return { ok: true, status: 200, data: fixture.graphql?.data ?? { identityCardById: fixture.identityCard ?? null } }
    },
    commandExists: () => fixture.commandExists ?? true,
    runVaraWallet: async () => fixture.varaWallet ?? { ok: true, status: 0, stdout: '{"result":null}', stderr: '' },
  }
}

async function identityCardCheck(env, deps) {
  const query = 'query IdentityCard($id: String!) { identityCardById(id: $id) { id } }'
  // Indexer stores actor ids lowercased (migration 0008); match that or a
  // valid-but-uppercase APP_HEX false-fails the lookup.
  const r = await (deps.graphql ?? defaultGraphql)(env.INDEXER_GRAPHQL_URL, query, { id: env.APP_HEX.toLowerCase() })
  if (!r.ok) return check('identity_card_ok', 'INCONCLUSIVE', `indexer query failed: ${r.error ?? `HTTP ${r.status}`}`)
  if (r.data?.identityCardById) return check('identity_card_ok', 'PASS', 'identity card found')
  return check('identity_card_ok', 'FAIL', 'identity card missing')
}

function parseWalletJson(stdout) {
  const trimmed = String(stdout ?? '').trim()
  if (!trimmed) return null
  try {
    return JSON.parse(trimmed)
  } catch {
    const line = trimmed.split('\n').findLast(l => l.trim().startsWith('{'))
    return line ? JSON.parse(line) : null
  }
}

function isTransportError(run) {
  const text = `${run.stdout ?? ''}\n${run.stderr ?? ''}`
  return /TRANSPORT_ERROR|timeout|connection_refused|unreachable|ws_close_abnormal/i.test(text)
}

async function smokeCheck({ manifest, env, idlText, method, retries, deps }) {
  if (!method.query) {
    return check('smoke_ok', 'INCONCLUSIVE', 'documented method is state-changing; smoke_command recorded as evidence only', {
      smoke_command: manifest.smoke_command,
      method: manifest.documented_method.name,
    })
  }
  const commandCheck = validateSmokeCommand(manifest.smoke_command, manifest, env)
  if (!commandCheck.ok) {
    return check('smoke_ok', 'FAIL', commandCheck.detail, {
      smoke_command: manifest.smoke_command,
    })
  }
  if (!(deps.commandExists ?? defaultCommandExists)('vara-wallet')) {
    return check('smoke_ok', 'MISCONFIGURED', 'vara-wallet CLI is not on PATH')
  }

  let lastRun
  for (let i = 0; i <= retries; i++) {
    lastRun = await (deps.runVaraWallet ?? defaultRunVaraWallet)({
      programId: env.APP_HEX,
      method: manifest.documented_method.name,
      args: manifest.documented_method.example_args,
      idlText,
      network: env.VARA_NETWORK,
    })
    if (lastRun.ok) break
    if (!isTransportError(lastRun)) {
      return check('smoke_ok', 'FAIL', `vara-wallet call failed: ${(lastRun.stderr || lastRun.stdout || `exit ${lastRun.status}`).trim()}`, {
        smoke_command: manifest.smoke_command,
      })
    }
  }
  if (!lastRun.ok && isTransportError(lastRun)) {
    return check('smoke_ok', 'INCONCLUSIVE', `transport error after ${retries + 1} attempt(s)`, {
      smoke_command: manifest.smoke_command,
    })
  }

  let payload
  try {
    payload = parseWalletJson(lastRun.stdout)
  } catch (e) {
    return check('smoke_ok', 'FAIL', `vara-wallet JSON output could not be parsed: ${e.message}`)
  }
  if (!payload || !('result' in payload)) return check('smoke_ok', 'FAIL', 'vara-wallet output did not contain result')
  const match = valueMatchesShape(payload.result, manifest.documented_method.expected_return_shape)
  return check('smoke_ok', match.ok ? 'PASS' : 'FAIL', match.detail, {
    smoke_command: manifest.smoke_command,
    executed_method: manifest.documented_method.name,
    executed_args: manifest.documented_method.example_args,
  })
}

function artifactRows(preflightResults) {
  const byGroup = new Map(ARTIFACT_CHECKS.map(([name]) => [name, []]))
  for (const result of preflightResults) {
    for (const [name, labels] of ARTIFACT_CHECKS) {
      if (labels.has(result.label)) byGroup.get(name).push(result)
    }
  }
  return ARTIFACT_CHECKS.map(([name]) => {
    const rows = byGroup.get(name)
    const status = combineStatus(rows.map(r => ({
      status: r.kind === 'WARN' && ESCALATED_WARN_LABELS.has(r.label)
        ? 'FAIL'
        : statusFromPreflightResult(r.kind),
    })))
    const detail = rows.map(r => `${r.label}: ${r.detail ?? r.kind}`).join('; ')
    return check(name, status, detail || 'not checked')
  })
}

export async function runReadinessCheck({ manifest, env = process.env, retries = 2, deps = {} }) {
  const checks = []
  const errors = validateManifestAndEnv(manifest, env)
  if (errors.length) {
    checks.push(check('configuration', 'MISCONFIGURED', errors.join('; ')))
    return buildOutput(manifest, env, checks)
  }

  const artifactPromise = checkArtifactInputs({
    githubUrl: manifest.github_url,
    skillsUrl: manifest.skills_url,
    skillsHash: manifest.skills_hash,
    idlUrl: manifest.idl_url,
    idlHash: manifest.idl_hash,
  }, deps)
  const identityPromise = identityCardCheck(env, deps)

  const artifact = await artifactPromise
  checks.push(...artifactRows(artifact.results))
  checks.push(await identityPromise)
  checks.push(documentedErrorsCheck(manifest))
  checks.push(buildProofCheck(manifest))

  const idlText = artifact.artifacts.idlBytes?.toString('utf8') ?? ''
  // Native fetch can't resolve ipfs:// (a valid idl_url scheme). Don't false-FAIL
  // it: mark idl_ok and downstream checks INCONCLUSIVE so the operator verifies.
  const idlUnfetchable = !idlText && /^ipfs:\/\//i.test(manifest.idl_url ?? '')
  if (idlUnfetchable) {
    const idlRow = checks.find(c => c.name === 'idl_ok')
    if (idlRow) {
      idlRow.status = 'INCONCLUSIVE'
      idlRow.detail = 'ipfs:// IDL cannot be fetched by readiness-check; verify manually'
    }
  }
  const parsed = idlText ? parseIdlServices(idlText) : { services: new Map(), typeDefs: new Map() }
  const parts = methodNameParts(manifest.documented_method.name)
  const method = parsed.services.get(parts.service)?.get(parts.method)
  let documentedMethod
  if (idlUnfetchable) {
    documentedMethod = check('documented_method', 'INCONCLUSIVE', 'ipfs:// IDL cannot be fetched by readiness-check; verify the documented method manually')
  } else if (!idlText) {
    documentedMethod = check('documented_method', 'FAIL', 'IDL artifact was not available for method validation')
  } else {
    if (!method) {
      documentedMethod = check('documented_method', 'FAIL', `${manifest.documented_method.name} not found in IDL`)
    } else {
      const compatible = isReturnShapeCompatible(method.returnType, manifest.documented_method.expected_return_shape, parsed.typeDefs)
      documentedMethod = check('documented_method', compatible.ok ? 'PASS' : 'FAIL', compatible.detail, {
        query: method.query,
        return_type: method.returnType,
      })
    }
  }
  checks.push(documentedMethod)

  if (documentedMethod.status === 'PASS' && method) {
    checks.push(await smokeCheck({ manifest, env, idlText, method, retries, deps }))
  } else {
    checks.push(check('smoke_ok', 'SKIP', 'skipped because documented_method did not pass'))
  }

  return buildOutput(manifest, env, checks)
}

function buildOutput(manifest, env, checks) {
  const overall = combineStatus(checks)
  const skillsHash = normaliseHash(manifest.skills_hash)
  const idlHash = normaliseHash(manifest.idl_hash)
  const actorId = value => typeof value === 'string' && HEX_32.test(value) ? value.toLowerCase() : value ?? null
  return {
    schema_version: SCHEMA_VERSION,
    inputs: {
      program_id: actorId(manifest.program_id),
      github_url: manifest.github_url ?? null,
      skills_url: manifest.skills_url ?? null,
      skills_hash: skillsHash ? `0x${skillsHash}` : manifest.skills_hash ?? null,
      idl_url: manifest.idl_url ?? null,
      idl_hash: idlHash ? `0x${idlHash}` : manifest.idl_hash ?? null,
      documented_method: manifest.documented_method ?? null,
      smoke_command: manifest.smoke_command ?? null,
    },
    env: {
      app_hex: actorId(env.APP_HEX),
      pid: actorId(env.PID),
      indexer_graphql_url: env.INDEXER_GRAPHQL_URL ?? null,
      vara_network: env.VARA_NETWORK ?? null,
    },
    checks,
    overall,
  }
}

async function main() {
  let args
  try {
    args = parseArgs(process.argv.slice(2))
  } catch (e) {
    console.error(e.message)
    console.error('')
    console.error(USAGE)
    process.exit(2)
  }
  if (args.help) {
    console.log(USAGE)
    process.exit(0)
  }
  if (!args.manifest) {
    console.error(USAGE)
    process.exit(2)
  }
  const retries = Number(args.retries)
  if (!Number.isInteger(retries) || retries < 0) {
    console.error('--retries must be a non-negative integer')
    process.exit(2)
  }
  let manifest
  try {
    manifest = loadManifest(args.manifest)
  } catch (e) {
    console.error(`failed to load --manifest: ${e.message}`)
    process.exit(2)
  }

  const output = await runReadinessCheck({ manifest, retries, deps: defaultDeps() })
  const json = safeJson(output) + '\n'
  if (args.out) writeFileSync(args.out, json)
  process.stdout.write(json)
  process.exit(exitCodeFor(output.overall))
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(e => {
    console.error(`readiness-check: unexpected error: ${e?.stack ?? e}`)
    process.exit(2)
  })
}
