import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const workbench = readFileSync(new URL('../components/idea-review-workbench.tsx', import.meta.url), 'utf8')
const queuePage = readFileSync(new URL('../app/dashboard/idea-reviews/page.tsx', import.meta.url), 'utf8')

test('idea review UI covers public guidance outcomes', () => {
  for (const outcome of ['Proceed', 'Refine', 'NeedsEvidence', 'NotRecommended']) {
    assert.match(workbench, new RegExp(outcome))
  }
})

test('idea review queue keeps pre-deploy language visible', () => {
  assert.match(queuePage, /Pre-deploy review/)
  assert.match(queuePage, /Submit idea/)
})
