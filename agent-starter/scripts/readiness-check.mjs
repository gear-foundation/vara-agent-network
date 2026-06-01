#!/usr/bin/env node

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import {
  checkArtifactInputs,
  normaliseHash,
} from './preflight-checks.mjs'

const SCHEMA_VERSION = 'agent-starter-readiness/v1'
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
  const out = { retries: '2', out: 'readiness.json' }
  const flags = new Set(['--manifest', '--out', '--retries'])
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--help' || a === '-h') {
      out.help = true
      continue
    }
    if (!flags.has(a)) throw new Error(`unknown arg: ${a}`)
    const v = argv[++i]
    if (v === undefined) throw new Error(`missing value for ${a}`)
    out[a.slice(2)] = v
  }
  return out
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

export function parseIdlServices(idlText) {
  const typeDefs = new Map()
  for (const m of idlText.matchAll(/\btype\s+([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(struct|enum|alias)?\s*([\s\S]*?);/g)) {
    const name = m[1]
    const body = m[3] ?? ''
    const kind = m[2] || (body.trim().startsWith('struct') ? 'struct' : body.trim().startsWith('enum') ? 'enum' : 'alias')
    const fields = []
    const structBody = body.match(/struct\s*\{([\s\S]*)\}/)?.[1] ?? (kind === 'struct' ? body.match(/\{([\s\S]*)\}/)?.[1] : '')
    if (structBody) {
      for (const f of structBody.matchAll(/\b([A-Za-z_][A-Za-z0-9_]*)\s*:/g)) fields.push(f[1])
    }
    typeDefs.set(name, { kind, fields })
  }

  const services = new Map()
  const clean = stripLineComments(idlText)
  for (const svc of clean.matchAll(/\bservice\s+([A-Za-z_][A-Za-z0-9_]*)\s*\{([\s\S]*?)^\};/gm)) {
    const service = svc[1]
    const methods = new Map()
    for (const line of svc[2].split('\n')) {
      const m = line.trim().match(/^(query\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*:\s*\((.*)\)\s*->\s*([^;]+);$/)
      if (!m) continue
      methods.set(m[2], {
        name: m[2],
        query: Boolean(m[1]),
        args: m[3].trim(),
        returnType: m[4].trim(),
      })
    }
    services.set(service, methods)
  }
  return { services, typeDefs }
}

function scalarKind(type, typeDefs) {
  const t = type.trim()
  if (t === 'null' || t === '()' || t === 'void') return { kind: 'null' }
  if (t === 'bool') return { kind: 'boolean' }
  if (/^(u|i)(8|16|32|64|128|256)$/.test(t)) return { kind: 'number' }
  if (t === 'str' || t === 'String' || t === 'actor_id') return { kind: 'string' }
  if (t.startsWith('vec ')) return { kind: 'array' }
  if (t.startsWith('[')) return { kind: 'array' }
  if (t.startsWith('opt ')) return { kind: 'optional', inner: scalarKind(t.slice(4), typeDefs) }
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
  writeFileSync(idlPath, idlText)
  try {
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
  const r = await (deps.graphql ?? defaultGraphql)(env.INDEXER_GRAPHQL_URL, query, { id: env.APP_HEX })
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
  })
}

function artifactRows(preflightResults) {
  const selected = [
    ['github_ok', ['github_url format', 'github_url placeholder', 'github_url reachable']],
    ['skills_ok', ['skills_hash non-zero', 'skills_url reachable', 'skills_url hash']],
    ['idl_ok', ['idl_url format', 'idl_hash non-zero', 'idl_url reachable', 'idl_url hash']],
  ]
  return selected.map(([name, labels]) => {
    const rows = preflightResults.filter(r => labels.includes(r.label))
    const status = combineStatus(rows.map(r => ({ status: statusFromPreflightResult(r.kind) })))
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

  const idlText = artifact.artifacts.idlBytes?.toString('utf8') ?? ''
  const parsed = idlText ? parseIdlServices(idlText) : { services: new Map(), typeDefs: new Map() }
  const parts = methodNameParts(manifest.documented_method.name)
  const method = parsed.services.get(parts.service)?.get(parts.method)
  let documentedMethod
  if (!idlText) {
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
