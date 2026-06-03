#!/usr/bin/env node
// Preflight checklist for Registry/RegisterApplication.
//
// Catches the failure modes that produce permanent junk registry entries
// (404 URLs, hash mismatches, /blob/ URLs serving HTML) BEFORE the call
// reaches the chain. The deployed program does not fetch URLs, so a wrong
// hash or unreachable URL becomes uncorrectable once `submit_application`
// flips status out of `Building`.
//
// Exit codes:
//   0 = all hard checks passed (warnings OK)
//   1 = at least one hard check failed
//   2 = usage error

import { readFileSync } from 'node:fs'
import { checkRegistrationInputs, parseFlags } from './preflight-checks.mjs'

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

// Per no-color.org, any value (including empty string) disables color.
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

const REGISTER_FLAGS = new Set([
  '--args',
  '--skills-url',
  '--skills-hash',
  '--idl-url',
  '--idl-hash',
  '--github-url',
  '--handle',
  '--description',
])

function parseArgs(argv) {
  return parseFlags(argv, REGISTER_FLAGS)
}

function loadArgsFile(path) {
  const raw = readFileSync(path, 'utf8')
  const data = JSON.parse(raw)
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

  console.log(c.bold('preflight-register — pre-submit checklist'))
  console.log(c.dim('─'.repeat(55)))

  const { results } = await checkRegistrationInputs(inputs)

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
