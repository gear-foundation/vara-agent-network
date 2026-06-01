import { createHash } from 'node:crypto'

export const FIELD_CAPS = {
  github_url: 256,
  skills_url: 256,
  idl_url: 256,
  description: 280,
}

export const MAX_FETCH_BYTES = 10 * 1024 * 1024

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

export function normaliseHash(input) {
  if (typeof input !== 'string') return null
  const s = input.startsWith('0x') || input.startsWith('0X') ? input.slice(2) : input
  if (!/^[0-9a-fA-F]{64}$/.test(s)) return null
  return s.toLowerCase()
}

export function sha256Hex(buf) {
  return createHash('sha256').update(buf).digest('hex')
}

export async function fetchBytes(url, fetchImpl = fetch) {
  try {
    const res = await fetchImpl(url, { redirect: 'follow' })
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

export async function headOk(url, fetchImpl = fetch) {
  try {
    const res = await fetchImpl(url, { method: 'HEAD', redirect: 'follow' })
    return { ok: res.ok, status: res.status, error: null }
  } catch (e) {
    return { ok: false, status: 0, error: e.message ?? String(e) }
  }
}

function collector() {
  const results = []
  return {
    results,
    pass(label, detail) {
      results.push({ kind: 'PASS', label, detail })
    },
    warn(label, detail, hint) {
      results.push({ kind: 'WARN', label, detail, hint })
    },
    fail(label, detail, hint) {
      results.push({ kind: 'FAIL', label, detail, hint })
    },
    skip(label, reason) {
      results.push({ kind: 'SKIP', label, detail: reason })
    },
  }
}

export function checkFieldLength(field, value, emit = collector()) {
  if (value === undefined || value === null) return emit.results
  const cap = FIELD_CAPS[field]
  const len = Buffer.byteLength(String(value), 'utf8')
  if (len > cap) {
    emit.fail(`${field} length`, `${len} bytes exceeds on-chain cap ${cap}`, 'register guard rejects with FieldTooLarge')
  }
  return emit.results
}

export function checkHandle(handle, emit = collector()) {
  if (!handle) {
    emit.fail('handle', 'missing')
    return emit.results
  }
  if (!/^[a-z0-9_-]{3,32}$/.test(handle)) {
    emit.fail('handle', `"${handle}" doesn't match [a-z0-9_-]{3,32}`, 'matches on-chain validate_handle')
    return emit.results
  }
  emit.pass('handle', `"${handle}"`)
  return emit.results
}

export function checkGithubUrlFormat(url, emit = collector()) {
  if (!url) {
    emit.fail('github_url format', 'missing')
    return false
  }
  if (!url.startsWith('https://github.com/')) {
    emit.fail('github_url format', `"${url}" must start with https://github.com/`, 'on-chain validate_github_url rejects bare github.com/me')
    return false
  }
  const tail = url.slice('https://github.com/'.length)
  const seg = tail.split('/')[0].toLowerCase()
  if (!seg) {
    emit.fail('github_url format', 'no owner segment after https://github.com/', 'the contract allows this but it points nowhere')
    return false
  }
  if (GITHUB_PLACEHOLDERS.has(seg)) {
    emit.fail('github_url placeholder', `owner segment "${seg}" looks like an unfilled template`, `placeholders blocked: ${[...GITHUB_PLACEHOLDERS].join(', ')}`)
    return false
  }
  emit.pass('github_url format', url)
  return true
}

export async function checkGithubUrlReachable(url, emit = collector(), deps = {}) {
  const r = deps.headOk ? await deps.headOk(url) : await headOk(url, deps.fetch)
  if (!r.ok) {
    const reason = r.error ? `error: ${r.error}` : `HTTP ${r.status}`
    emit.fail('github_url reachable', reason, 'repo is private or doesn\'t exist')
    return emit.results
  }
  emit.pass('github_url reachable', `HTTP ${r.status}`)
  return emit.results
}

export function checkIdlUrlFormat(url, emit = collector()) {
  if (!url) {
    emit.fail('idl_url format', 'missing')
    return false
  }
  if (!(url.startsWith('https://') || url.startsWith('ipfs://'))) {
    emit.fail('idl_url format', `"${url}" must start with https:// or ipfs://`, 'mirrors on-chain validate_idl_url')
    return false
  }
  if (!url.endsWith('.idl')) {
    emit.fail('idl_url format', `"${url}" must end with lowercase .idl`, 'mirrors on-chain validate_idl_url — .IDL / .idl.txt rejected')
    return false
  }
  emit.pass('idl_url format', url)
  return true
}

export function checkHashNonZero(label, hashHex, emit = collector()) {
  if (hashHex === null) {
    emit.fail(label, 'missing or not a 64-char hex string (0x prefix optional)')
    return false
  }
  if (/^0+$/.test(hashHex)) {
    emit.fail(label, 'all-zero hash rejected by on-chain validate_hash')
    return false
  }
  emit.pass(label, `0x${hashHex.slice(0, 12)}…`)
  return true
}

export async function checkFetchAndHash(label, url, expectedHex, emit = collector(), deps = {}) {
  if (!url || expectedHex === null) {
    emit.skip(label, 'skipped (input missing)')
    return null
  }
  const r = deps.fetchBytes ? await deps.fetchBytes(url) : await fetchBytes(url, deps.fetch)
  if (!r.ok) {
    const reason = r.error ? `error: ${r.error}` : `HTTP ${r.status}`
    emit.fail(`${label} reachable`, reason, 'url 404 / wrong branch / private repo — readers will see junk')
    return null
  }
  emit.pass(`${label} reachable`, `HTTP ${r.status}, ${r.bytes.length} bytes`)
  const actual = sha256Hex(r.bytes)
  if (actual !== expectedHex) {
    emit.fail(
      `${label} hash`,
      `expected 0x${expectedHex}\n           actual   0x${actual}`,
      'did you edit the file after computing the hash, or point at a different branch/commit?'
    )
    return r.bytes
  }
  emit.pass(`${label} hash`, `SHA-256 matches 0x${expectedHex.slice(0, 12)}…`)
  return r.bytes
}

export function checkSkillsUrlShape(url, emit = collector()) {
  if (!url) return emit.results
  try {
    const u = new URL(url)
    if (u.hostname === 'gist.github.com' || u.hostname === 'gist.githubusercontent.com') {
      emit.warn('skills_url stability', `${u.hostname} URLs work but can be deleted and don't pin to a commit`, 'fine for first registration; move to a versioned repo URL before submit_application')
    }
    if (u.hostname === 'github.com' && u.pathname.includes('/blob/')) {
      emit.warn('skills_url is /blob/', 'github.com/.../blob/... serves rendered HTML, not raw bytes', 'use /raw/ or raw.githubusercontent.com — otherwise the hash will never match')
    }
  } catch {
  }
  return emit.results
}

export function checkSkillsContent(bytes, emit = collector()) {
  if (!bytes) return emit.results
  if (bytes.length < 200) {
    emit.warn('skills.md size', `only ${bytes.length} bytes`, 'looks like a stub; full skills.md should describe capabilities, API surface, contacts')
  }
  const text = bytes.toString('utf8')
  if (!/(^|\n)\s*#\s/.test(text)) {
    emit.warn('skills.md heading', 'no markdown # heading detected', 'is this actually markdown?')
  }
  const stubs = ['TODO', 'FIXME', 'Lorem ipsum', 'placeholder text']
  const lower = text.toLowerCase()
  for (const s of stubs) {
    if (lower.includes(s.toLowerCase())) {
      emit.warn('skills.md content', `contains "${s}"`, 'left-over template content?')
      break
    }
  }
  return emit.results
}

export function checkIdlContent(bytes, emit = collector()) {
  if (!bytes) return emit.results
  const text = bytes.toString('utf8')
  if (!/\bservice\b/.test(text)) {
    emit.warn('idl content', 'no "service" keyword found', 'is this a Sails IDL? Sails IDL declares one or more service blocks')
  }
  return emit.results
}

export function checkDescription(desc, emit = collector()) {
  if (desc === undefined || desc === null) return emit.results
  const trimmed = String(desc).trim()
  if (trimmed.length === 0) {
    emit.warn('description', 'empty / whitespace-only', 'on-chain register guard accepts it but readers see nothing')
    return emit.results
  }
  if (trimmed.length < 40) {
    emit.warn('description', `${trimmed.length} chars after trim`, 'short descriptions hurt discoverability; aim for 1-2 sentences')
  }
  return emit.results
}

async function runArtifactChecks(inputs, emit, deps, { includeDescription = false } = {}) {
  const skillsHashHex = normaliseHash(inputs.skillsHash)
  const idlHashHex = normaliseHash(inputs.idlHash)

  checkGithubUrlFormat(inputs.githubUrl, emit)
  checkIdlUrlFormat(inputs.idlUrl, emit)
  checkFieldLength('github_url', inputs.githubUrl, emit)
  checkFieldLength('skills_url', inputs.skillsUrl, emit)
  checkFieldLength('idl_url', inputs.idlUrl, emit)
  if (includeDescription) checkFieldLength('description', inputs.description, emit)
  checkHashNonZero('skills_hash non-zero', skillsHashHex, emit)
  checkHashNonZero('idl_hash non-zero', idlHashHex, emit)
  checkSkillsUrlShape(inputs.skillsUrl, emit)

  const githubReachable = inputs.githubUrl && inputs.githubUrl.startsWith('https://github.com/')
    ? checkGithubUrlReachable(inputs.githubUrl, emit, deps)
    : Promise.resolve()
  const [skillsBytes, idlBytes] = await Promise.all([
    checkFetchAndHash('skills_url', inputs.skillsUrl, skillsHashHex, emit, deps),
    checkFetchAndHash('idl_url', inputs.idlUrl, idlHashHex, emit, deps),
    githubReachable,
  ])

  checkSkillsContent(skillsBytes, emit)
  checkIdlContent(idlBytes, emit)
  if (includeDescription) checkDescription(inputs.description, emit)

  return {
    results: emit.results,
    artifacts: { skillsBytes, idlBytes },
    normalized: { skillsHashHex, idlHashHex },
  }
}

export async function checkArtifactInputs(inputs, deps = {}) {
  return runArtifactChecks(inputs, collector(), deps)
}

export async function checkRegistrationInputs(inputs, deps = {}) {
  const emit = collector()
  checkHandle(inputs.handle, emit)
  return runArtifactChecks(inputs, emit, deps, { includeDescription: true })
}
