import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const source = readFileSync(new URL('../lib/indexer-client.ts', import.meta.url), 'utf8')

test('replacement route resolution uses targeted alias queries', () => {
  assert.doesNotMatch(source, /allApplicationProgramReplacements\(first:\s*1000/)
  assert.match(source, /condition:\s*\{\s*oldProgramId:\s*\$programId\s*\}/)
  assert.match(source, /condition:\s*\{\s*newProgramId:\s*\$programId\s*\}/)
  assert.match(source, /MAX_APPLICATION_REPLACEMENT_DEPTH\s*=\s*8/)
})
