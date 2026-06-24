import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
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

test('lint accepts service-list shorthand (Registry/Chat/Board) without flagging it as a method', () => {
  // Accepted tradeoff: a Service/Method whose method token is itself a service
  // name is treated as service-list prose, not a method reference. This keeps the
  // pervasive "Registry/Chat/Board services" shorthand from false-failing. The
  // narrow cost is that a bogus call literally named e.g. Chat/Registry slips by.
  const dir = mkdtempSync(join(tmpdir(), 'van-service-list-'))
  try {
    const doc = join(dir, 'doc.md')
    writeFileSync(doc, 'Registry/Chat/Board are service-list shorthand here.\n')
    writeFileSync(join(dir, 'good.json'), '{}\n')
    const r = spawnSync('bash', [lint], {
      cwd: root,
      env: { ...process.env, AGENT_STARTER_EXAMPLES_DIR: dir, AGENT_STARTER_LINT_FILES: doc },
      encoding: 'utf8',
    })
    assert.equal(r.status, 0)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('lint fails when active docs point to ended hackathon funding', () => {
  const dir = mkdtempSync(join(tmpdir(), 'van-ended-funding-'))
  try {
    const doc = join(dir, 'doc.md')
    writeFileSync(doc, [
      'Fund the wallet at https://agents.vara.network/hackathon.',
      'Then use the tweet claim to receive 100 VARA.',
      '',
    ].join('\n'))
    writeFileSync(join(dir, 'good.json'), '{}\n')
    const r = spawnSync('bash', [lint], {
      cwd: root,
      env: { ...process.env, AGENT_STARTER_EXAMPLES_DIR: dir, AGENT_STARTER_LINT_FILES: doc },
      encoding: 'utf8',
    })
    assert.equal(r.status, 1)
    assert.match(r.stderr, /ended hackathon funding page/)
    assert.match(r.stderr, /ended Season 1 token claim/)
    assert.match(r.stderr, /tweet-claim funding/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('lint fails when active docs contain voucher-era gas wording', () => {
  const dir = mkdtempSync(join(tmpdir(), 'van-required-voucher-'))
  try {
    const doc = join(dir, 'doc.md')
    writeFileSync(doc, [
      'Run references/vouchers.md to set VAN_WRITE_GAS_ARGS.',
      'Then call with --voucher "$VOUCHER_ID".',
      '',
    ].join('\n'))
    writeFileSync(join(dir, 'good.json'), '{}\n')
    const r = spawnSync('bash', [lint], {
      cwd: root,
      env: { ...process.env, AGENT_STARTER_EXAMPLES_DIR: dir, AGENT_STARTER_LINT_FILES: doc },
      encoding: 'utf8',
    })
    assert.equal(r.status, 1)
    assert.match(r.stderr, /voucher-era gas args/)
    assert.match(r.stderr, /wallet-paid gas/)
    assert.match(r.stderr, /deleted agent-starter docs/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('lint fails when fee docs expose hackathon caveats as method names', () => {
  const dir = mkdtempSync(join(tmpdir(), 'van-hackathon-fee-name-'))
  try {
    const doc = join(dir, 'doc.md')
    writeFileSync(doc, 'pub fn set_fee_hackathon_owner_only(&mut self, new_fee: u128) {}\n')
    writeFileSync(join(dir, 'good.json'), '{}\n')
    const r = spawnSync('bash', [lint], {
      cwd: root,
      env: { ...process.env, AGENT_STARTER_EXAMPLES_DIR: dir, AGENT_STARTER_LINT_FILES: doc },
      encoding: 'utf8',
    })
    assert.equal(r.status, 1)
    assert.match(r.stderr, /method names/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('lint fails when active docs use retired production domains', () => {
  const dir = mkdtempSync(join(tmpdir(), 'van-retired-domains-'))
  try {
    const doc = join(dir, 'doc.md')
    writeFileSync(doc, [
      'GraphQL: https://agents-api.vara.network/graphql',
      'Voucher: https://voucher-backend-agents.vara.network/voucher',
      '',
    ].join('\n'))
    writeFileSync(join(dir, 'good.json'), '{}\n')
    const r = spawnSync('bash', [lint], {
      cwd: root,
      env: { ...process.env, AGENT_STARTER_EXAMPLES_DIR: dir, AGENT_STARTER_LINT_FILES: doc },
      encoding: 'utf8',
    })
    assert.equal(r.status, 1)
    assert.match(r.stderr, /agents-explorer\.vara\.network/)
    assert.match(r.stderr, /retired voucher endpoints/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('lint fails when active docs use deleted doc refs or old wallet var', () => {
  const dir = mkdtempSync(join(tmpdir(), 'van-deleted-doc-ref-'))
  try {
    const doc = join(dir, 'doc.md')
    writeFileSync(doc, 'Read agent-paid-service.md, references/staleness.md, and set OPERATOR_HEX first.\n')
    writeFileSync(join(dir, 'good.json'), '{}\n')
    const r = spawnSync('bash', [lint], {
      cwd: root,
      env: { ...process.env, AGENT_STARTER_EXAMPLES_DIR: dir, AGENT_STARTER_LINT_FILES: doc },
      encoding: 'utf8',
    })
    assert.equal(r.status, 1)
    assert.match(r.stderr, /deleted agent-starter docs/)
    assert.match(r.stderr, /WALLET_ADDRESS/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('lint fails when active docs copy the retired Season 1 program id', () => {
  const dir = mkdtempSync(join(tmpdir(), 'van-retired-pid-'))
  try {
    const doc = join(dir, 'doc.md')
    writeFileSync(doc, 'PID=0x19f27f4c906a5ac230be82d907850d44c7a7fff1b4c6903f62e78e09e0b353f3\n')
    writeFileSync(join(dir, 'good.json'), '{}\n')
    const r = spawnSync('bash', [lint], {
      cwd: root,
      env: { ...process.env, AGENT_STARTER_EXAMPLES_DIR: dir, AGENT_STARTER_LINT_FILES: doc },
      encoding: 'utf8',
    })
    assert.equal(r.status, 1)
    assert.match(r.stderr, /retired Season 1 program id/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('starter prompt asks only for participant handle before the scan and has timeout fallback', () => {
  const prompt = readFileSync(join(root, 'STARTER_PROMPT.md'), 'utf8')
  const phase2Ask = prompt.slice(
    prompt.indexOf('Ask the operator for the **Participant handle**'),
    prompt.indexOf('Then run `agent-create.md` end-to-end.'),
  )
  assert.match(phase2Ask, /PARTICIPANT_HANDLE/)
  assert.doesNotMatch(phase2Ask, /DAPP_HANDLE/)
  assert.match(prompt, /5 minutes/)
  assert.match(prompt, /operator_timeout_default=true/)
})

test('board docs pin args-file outer array shape and trailing newline', () => {
  const board = readFileSync(join(root, 'agent-board.md'), 'utf8')
  const cookbook = readFileSync(join(root, 'references/arg-shape-cookbook.md'), 'utf8')
  assert.match(board, /Board\/SetIdentityCard` takes two args/)
  assert.match(board, /\["\$APP_HEX", \{IdentityCardReq\}\]/)
  assert.match(board, /trailing newline/)
  assert.match(board, /Board\/PostAnnouncement` also takes two args/)
  assert.match(cookbook, /Board args files are two-arg arrays/)
  assert.match(cookbook, /--estimate --args-file/)
})

test('cerberus coach docs use the current gated project-review flow', () => {
  const coach = readFileSync(join(root, 'agent-cerberus-coach.md'), 'utf8')
  const onboarding = readFileSync(join(root, 'agent-onboarding.md'), 'utf8')
  const create = readFileSync(join(root, 'agent-create.md'), 'utf8')

  assert.match(coach, /Review\/ApproveProjectReviewSubmission/)
  assert.match(coach, /Review\/SubmitApprovedProjectReview/)
  assert.match(coach, /Review\/GetProjectReviewSummary\(PROJECT_REVIEW_ID\)\.linked_program_id == PROGRAM_ID/)
  assert.match(coach, /Registry\/SubmitApplication/)
  assert.match(coach, /ReviewCriteria/)
  assert.doesNotMatch(coach, /references\/vouchers\.md/)
  assert.doesNotMatch(coach, /VAN_WRITE_GAS_ARGS/)
  assert.doesNotMatch(coach, /No voucher is whitelisted for the current PID/)

  assert.match(onboarding, /Review\/ApproveProjectReviewSubmission/)
  assert.match(onboarding, /Review\/SubmitApprovedProjectReview/)
  assert.match(onboarding, /require_project_review_approval=false/)
  assert.match(create, /on-chain project-review approval/)
})
