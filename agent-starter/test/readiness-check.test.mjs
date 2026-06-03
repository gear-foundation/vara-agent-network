import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runReadinessCheck } from '../scripts/readiness-check.mjs'
import { sha256Hex } from '../scripts/preflight-checks.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const script = join(here, '..', 'scripts', 'readiness-check.mjs')
const fixture = join(here, 'fixtures', 'readiness-pass-fixture.json')
const fixtureManifest = join(here, 'fixtures', 'readiness-pass-manifest.json')
const APP_HEX = `0x${'a'.repeat(64)}`
const PID = `0x${'b'.repeat(64)}`
const skillsText = '# Skills\n\nA useful deployed service with enough detail for callers to inspect capability, API surface, identity, and contact details. It names the Health/Status query, the empty args array, the object return with ok and version fields, and the target caller: any agent that needs to verify service health before integrating.\n'
const queryIdl = `type Health = struct {
  ok: bool,
  version: str,
};

service Health {
  query Status : () -> Health;
};
`
const commandIdl = `service Health {
  Update : () -> null;
};
`
const sailsV1Idl = `service Directory@0x5ab451628f7f6d25 {
  functions {
    @query
    GetManifest(app: ActorId) -> Option<ServiceManifest>;

    UpsertManifest(app: ActorId, input: ManifestInput) -> Result<ServiceManifest, DirectoryError>;
  }

  types {
    struct ServiceManifest {
      app: ActorId,
      publisher: ActorId,
      service: str,
      method: str,
      args_shape: str,
      return_shape: str,
      idl_url: str,
      skills_url: str,
      evidence_hash: [u8;32],
      target_callers: vec str,
      updated_at: u64,
    }
  }
}
`

function env(overrides = {}) {
  return {
    APP_HEX,
    PID,
    INDEXER_GRAPHQL_URL: 'https://indexer.example/graphql',
    VARA_NETWORK: 'vara',
    ...overrides,
  }
}

function manifest(overrides = {}) {
  return {
    program_id: APP_HEX,
    github_url: 'https://github.com/alice/health',
    skills_url: 'https://example.test/skills.md',
    skills_hash: `0x${sha256Hex(Buffer.from(skillsText))}`,
    idl_url: 'https://example.test/health.idl',
    idl_hash: `0x${sha256Hex(Buffer.from(queryIdl))}`,
    documented_method: {
      name: 'Health/Status',
      example_args: [],
      expected_return_shape: { kind: 'object', required: ['ok'] },
    },
    smoke_command: 'vara-wallet --network "$VARA_NETWORK" --json call "$APP_HEX" Health/Status --args "[]" --idl ./health.idl',
    ...overrides,
  }
}

function deps({ idlText = queryIdl, skillsStatus = 200, graphql = { identityCardById: { id: APP_HEX } }, wallet = { ok: true, status: 0, stdout: '{"result":{"ok":true,"version":"1"}}', stderr: '' }, commandExists = true } = {}) {
  return {
    headOk: async () => ({ ok: true, status: 200, error: null }),
    fetchBytes: async url => {
      if (url.endsWith('skills.md')) return { ok: skillsStatus === 200, status: skillsStatus, bytes: skillsStatus === 200 ? Buffer.from(skillsText) : null, error: null }
      if (url.endsWith('.idl')) return { ok: true, status: 200, bytes: Buffer.from(idlText), error: null }
      return { ok: false, status: 404, bytes: null, error: null }
    },
    graphql: async () => graphql.error ? { ok: false, status: 0, error: graphql.error } : { ok: true, status: 200, data: graphql },
    commandExists: () => commandExists,
    runVaraWallet: async () => wallet,
  }
}

test('readiness PASS with reachable artifacts, identity card, documented query, and matching smoke result', async () => {
  const output = await runReadinessCheck({ manifest: manifest(), env: env(), deps: deps() })
  assert.equal(output.overall, 'PASS')
  assert.deepEqual(output.checks.map(c => c.name), ['github_ok', 'skills_ok', 'idl_ok', 'identity_card_ok', 'documented_method', 'smoke_ok'])
})

test('readiness PASS with generated Sails v1 IDL and separate-line query annotation', async () => {
  const methodName = 'Directory/GetManifest'
  const exampleArgs = [APP_HEX]
  const output = await runReadinessCheck({
    manifest: manifest({
      idl_hash: `0x${sha256Hex(Buffer.from(sailsV1Idl))}`,
      documented_method: {
        name: methodName,
        example_args: exampleArgs,
        expected_return_shape: { kind: 'object', required: ['app', 'publisher', 'service', 'method'] },
      },
      smoke_command: 'vara-wallet --network "$VARA_NETWORK" --json call "$APP_HEX" Directory/GetManifest --args "[\\"$APP_HEX\\"]" --idl ./readiness_directory.idl',
    }),
    env: env(),
    deps: deps({
      idlText: sailsV1Idl,
      wallet: { ok: true, status: 0, stdout: '{"result":{"app":"0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","publisher":"0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","service":"Directory","method":"GetManifest"}}', stderr: '' },
    }),
  })
  assert.equal(output.overall, 'PASS')
  assert.equal(output.checks.find(c => c.name === 'documented_method').status, 'PASS')
  assert.equal(output.checks.find(c => c.name === 'smoke_ok').status, 'PASS')
})

test('readiness FAILs on artifact fetch or hash failure', async () => {
  const output = await runReadinessCheck({ manifest: manifest(), env: env(), deps: deps({ skillsStatus: 404 }) })
  assert.equal(output.overall, 'FAIL')
  assert.equal(output.checks.find(c => c.name === 'skills_ok').status, 'FAIL')
})

test('readiness FAILs on stub skills artifacts even when the hash matches', async () => {
  const stubSkills = '# TODO\n'
  const output = await runReadinessCheck({
    manifest: manifest({ skills_hash: `0x${sha256Hex(Buffer.from(stubSkills))}` }),
    env: env(),
    deps: {
      ...deps(),
      fetchBytes: async url => {
        if (url.endsWith('skills.md')) return { ok: true, status: 200, bytes: Buffer.from(stubSkills), error: null }
        if (url.endsWith('.idl')) return { ok: true, status: 200, bytes: Buffer.from(queryIdl), error: null }
        return { ok: false, status: 404, bytes: null, error: null }
      },
    },
  })
  assert.equal(output.overall, 'FAIL')
  assert.equal(output.checks.find(c => c.name === 'skills_ok').status, 'FAIL')
  assert.match(output.checks.find(c => c.name === 'skills_ok').detail, /skills\.md size/)
})

test('readiness is INCONCLUSIVE when identity indexer is unreachable', async () => {
  const output = await runReadinessCheck({ manifest: manifest(), env: env(), deps: deps({ graphql: { error: 'ECONNRESET' } }) })
  assert.equal(output.overall, 'INCONCLUSIVE')
  assert.equal(output.checks.find(c => c.name === 'identity_card_ok').status, 'INCONCLUSIVE')
})

test('readiness is INCONCLUSIVE after repeated smoke transport errors', async () => {
  const output = await runReadinessCheck({
    manifest: manifest(),
    env: env(),
    retries: 1,
    deps: deps({ wallet: { ok: false, status: 1, stdout: '', stderr: 'TRANSPORT_ERROR timeout' } }),
  })
  assert.equal(output.overall, 'INCONCLUSIVE')
  assert.equal(output.checks.find(c => c.name === 'smoke_ok').status, 'INCONCLUSIVE')
})

test('readiness FAILs when recorded smoke command does not match the executed query evidence', async () => {
  let executed = false
  const output = await runReadinessCheck({
    manifest: manifest({
      smoke_command: 'vara-wallet --network "$VARA_NETWORK" --json call "$APP_HEX" Wrong/Command --args "[]" --idl ./wrong.idl',
    }),
    env: env(),
    deps: {
      ...deps(),
      runVaraWallet: async () => {
        executed = true
        return { ok: true, status: 0, stdout: '{"result":{"ok":true,"version":"1"}}', stderr: '' }
      },
    },
  })
  assert.equal(executed, false)
  assert.equal(output.overall, 'FAIL')
  assert.equal(output.checks.find(c => c.name === 'smoke_ok').status, 'FAIL')
  assert.match(output.checks.find(c => c.name === 'smoke_ok').detail, /does not match documented_method/)
})

test('readiness MISCONFIGURED on manifest/env/tool misconfiguration', async () => {
  const badManifest = manifest({ program_id: `0x${'c'.repeat(64)}` })
  const mismatch = await runReadinessCheck({ manifest: badManifest, env: env(), deps: deps() })
  assert.equal(mismatch.overall, 'MISCONFIGURED')

  const missingTool = await runReadinessCheck({ manifest: manifest(), env: env(), deps: deps({ commandExists: false }) })
  assert.equal(missingTool.overall, 'MISCONFIGURED')
  assert.equal(missingTool.checks.find(c => c.name === 'smoke_ok').status, 'MISCONFIGURED')
})

test('state-changing documented method is evidence-only and not executed', async () => {
  let executed = false
  const output = await runReadinessCheck({
    manifest: manifest({
      idl_hash: `0x${sha256Hex(Buffer.from(commandIdl))}`,
      documented_method: {
        name: 'Health/Update',
        example_args: [],
        expected_return_shape: { kind: 'null', required: [] },
      },
    }),
    env: env(),
    deps: {
      ...deps({ idlText: commandIdl }),
      runVaraWallet: async () => {
        executed = true
        return { ok: true, status: 0, stdout: '{"result":null}', stderr: '' }
      },
    },
  })
  assert.equal(executed, false)
  assert.equal(output.overall, 'INCONCLUSIVE')
  assert.equal(output.checks.find(c => c.name === 'smoke_ok').status, 'INCONCLUSIVE')
})

test('result null only passes for null return shapes', async () => {
  const output = await runReadinessCheck({
    manifest: manifest(),
    env: env(),
    deps: deps({ wallet: { ok: true, status: 0, stdout: '{"result":null}', stderr: '' } }),
  })
  assert.equal(output.overall, 'FAIL')
  assert.equal(output.checks.find(c => c.name === 'smoke_ok').status, 'FAIL')
})

test('readiness CLI writes stable fixture output and exits 0 on PASS', () => {
  const dir = mkdtempSync(join(tmpdir(), 'van-readiness-cli-'))
  try {
    const out = join(dir, 'readiness.json')
    const r = spawnSync(process.execPath, [
      script,
      '--manifest', fixtureManifest,
      '--out', out,
    ], {
      encoding: 'utf8',
      env: {
        ...process.env,
        APP_HEX,
        PID,
        INDEXER_GRAPHQL_URL: 'https://indexer.example/graphql',
        VARA_NETWORK: 'vara',
        VAN_READINESS_FIXTURE: fixture,
      },
    })
    assert.equal(r.status, 0)
    const stdoutJson = JSON.parse(r.stdout)
    const fileJson = JSON.parse(readFileSync(out, 'utf8'))
    assert.equal(stdoutJson.overall, 'PASS')
    assert.deepEqual(fileJson, stdoutJson)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('readiness CLI rejects invalid retries', () => {
  const r = spawnSync(process.execPath, [
    script,
    '--manifest', fixtureManifest,
    '--retries', '-1',
  ], {
    encoding: 'utf8',
    env: {
      ...process.env,
      APP_HEX,
      PID,
      INDEXER_GRAPHQL_URL: 'https://indexer.example/graphql',
      VARA_NETWORK: 'vara',
      VAN_READINESS_FIXTURE: fixture,
    },
  })
  assert.equal(r.status, 2)
  assert.match(r.stderr, /--retries must be a non-negative integer/)
})

// --- adversarial-review regression coverage (ship pre-landing) ---

const resultIdl = `type CalcError = enum { Bad };
service Calc {
  query Compute : () -> result (u32, CalcError);
};
`

test('documented_method rejects a wrong expected shape against lowercase Sails result (T, E)', async () => {
  const m = manifest({
    idl_hash: `0x${sha256Hex(Buffer.from(resultIdl))}`,
    documented_method: { name: 'Calc/Compute', example_args: [], expected_return_shape: { kind: 'string' } },
    smoke_command: 'vara-wallet --network "$VARA_NETWORK" --json call "$APP_HEX" Calc/Compute --args "[]" --idl ./calc.idl',
  })
  const output = await runReadinessCheck({ manifest: m, env: env(), deps: deps({ idlText: resultIdl }) })
  const dm = output.checks.find(c => c.name === 'documented_method')
  assert.equal(dm.status, 'FAIL') // result(u32,_) unwraps to number, not string — must not fall through to `any`
})

test('documented_method accepts a correct shape against lowercase Sails result (T, E)', async () => {
  const m = manifest({
    idl_hash: `0x${sha256Hex(Buffer.from(resultIdl))}`,
    documented_method: { name: 'Calc/Compute', example_args: [], expected_return_shape: { kind: 'number' } },
    smoke_command: 'vara-wallet --network "$VARA_NETWORK" --json call "$APP_HEX" Calc/Compute --args "[]" --idl ./calc.idl',
  })
  const output = await runReadinessCheck({ manifest: m, env: env(), deps: deps({ idlText: resultIdl, wallet: { ok: true, status: 0, stdout: '{"result":7}', stderr: '' } }) })
  assert.equal(output.checks.find(c => c.name === 'documented_method').status, 'PASS')
})

test('smoke_command accepts --args-file (the pack-recommended long-args path)', async () => {
  const m = manifest({
    smoke_command: 'vara-wallet --network "$VARA_NETWORK" --json call "$APP_HEX" Health/Status --args-file ./args.json --idl ./health.idl',
  })
  const output = await runReadinessCheck({ manifest: m, env: env(), deps: deps() })
  assert.equal(output.checks.find(c => c.name === 'smoke_ok').status, 'PASS')
  assert.equal(output.overall, 'PASS')
})

test('smoke_command with shell metacharacters fails (evidence is copy-pasteable)', async () => {
  const m = manifest({
    smoke_command: 'vara-wallet --network "$VARA_NETWORK" --json call "$APP_HEX" Health/Status --args "[]" --idl ./health.idl; curl http://evil',
  })
  const output = await runReadinessCheck({ manifest: m, env: env(), deps: deps() })
  const smoke = output.checks.find(c => c.name === 'smoke_ok')
  assert.equal(smoke.status, 'FAIL')
  assert.match(smoke.detail, /shell metacharacters/)
})

test('identity_card_ok matches a lowercase-indexed card when APP_HEX is uppercase', async () => {
  const UPPER = `0x${'A'.repeat(64)}`
  const lower = UPPER.toLowerCase()
  const m = manifest({ program_id: UPPER })
  const d = {
    headOk: async () => ({ ok: true, status: 200, error: null }),
    fetchBytes: async url => {
      if (url.endsWith('skills.md')) return { ok: true, status: 200, bytes: Buffer.from(skillsText), error: null }
      if (url.endsWith('.idl')) return { ok: true, status: 200, bytes: Buffer.from(queryIdl), error: null }
      return { ok: false, status: 404, bytes: null, error: null }
    },
    // Indexer only knows the lowercase id; the check must query lowercase.
    graphql: async (_url, _q, vars) => ({ ok: true, status: 200, data: { identityCardById: vars.id === lower ? { id: lower } : null } }),
    commandExists: () => true,
    runVaraWallet: async () => ({ ok: true, status: 0, stdout: '{"result":{"ok":true,"version":"1"}}', stderr: '' }),
  }
  const output = await runReadinessCheck({ manifest: m, env: env({ APP_HEX: UPPER }), deps: d })
  assert.equal(output.checks.find(c => c.name === 'identity_card_ok').status, 'PASS')
})

test('ipfs:// IDL is INCONCLUSIVE, not a false FAIL', async () => {
  const m = manifest({ idl_url: 'ipfs://QmExampleHealthIdlCidValue000000000000000000000000/health.idl' })
  const d = deps()
  const baseFetch = d.fetchBytes
  d.fetchBytes = async url => url.startsWith('ipfs://') ? { ok: false, status: 0, bytes: null, error: 'unsupported protocol' } : baseFetch(url)
  const output = await runReadinessCheck({ manifest: m, env: env(), deps: d })
  assert.equal(output.checks.find(c => c.name === 'idl_ok').status, 'INCONCLUSIVE')
  assert.equal(output.checks.find(c => c.name === 'documented_method').status, 'INCONCLUSIVE')
  assert.equal(output.overall, 'INCONCLUSIVE')
})
