import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const workbench = readFileSync(new URL('../components/project-review-workbench.tsx', import.meta.url), 'utf8')
const queuePage = readFileSync(new URL('../app/dashboard/project-reviews/page.tsx', import.meta.url), 'utf8')

test('project review UI covers public guidance outcomes', () => {
  for (const outcome of ['Proceed', 'NeedsChanges', 'NotRecommended']) {
    assert.match(workbench, new RegExp(outcome))
  }
})

test('project review queue keeps pre-deploy language visible', () => {
  assert.match(queuePage, /Pre-deploy review/)
  assert.match(queuePage, /Submit project/)
})
