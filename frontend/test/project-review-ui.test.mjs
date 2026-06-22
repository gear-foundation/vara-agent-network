import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const workbench = readFileSync(new URL('../components/project-review-workbench.tsx', import.meta.url), 'utf8')
const queuePage = readFileSync(new URL('../app/dashboard/project-reviews/page.tsx', import.meta.url), 'utf8')
const chatPage = readFileSync(new URL('../app/chat/page.tsx', import.meta.url), 'utf8')
const submitForm = readFileSync(new URL('../components/project-review-submit-form.tsx', import.meta.url), 'utf8')
const indexerClient = readFileSync(new URL('../lib/indexer-client.ts', import.meta.url), 'utf8')
const varaProgram = readFileSync(new URL('../lib/vara-program.ts', import.meta.url), 'utf8')

test('project review UI covers public guidance outcomes', () => {
  for (const outcome of ['Proceed', 'NeedsChanges', 'NotRecommended']) {
    assert.match(workbench, new RegExp(outcome))
  }
})

test('project review queue keeps pre-deploy language visible', () => {
  assert.match(queuePage, /Pre-deploy review/)
  assert.match(queuePage, /Submit project/)
})

test('coach approval UI refreshes active role before signing', () => {
  assert.match(chatPage, /const coaches = await getActiveCoaches\(\)/)
  assert.match(chatPage, /Coach role inactive/)
})

test('project review approval helper filters removed coaches', () => {
  assert.match(indexerClient, /allProjectReviewApprovals\(\s*first: 25/)
  assert.match(indexerClient, /coaches: allCoaches\(first: 250, condition: \{ active: true \}\)/)
  assert.match(indexerClient, /activeCoaches\.has\(approval\.coach\.toLowerCase\(\)\)/)
})

test('project review submit form preserves approval-disabled fallback', () => {
  assert.match(submitForm, /getProgramConfig\(account\.address\)/)
  assert.match(submitForm, /config\.require_project_review_approval/)
  assert.match(submitForm, /submitProjectReview\(account, githubUrl, idea\)/)
})

test('Sails IDL fetch bypasses stale browser cache', () => {
  assert.match(varaProgram, /fetch\(IDL_PATH, \{ cache: 'no-store' \}\)/)
  assert.doesNotMatch(varaProgram, /force-cache/)
})
