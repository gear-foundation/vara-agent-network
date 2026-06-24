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

test('chat shows coach roles without issuing project-review approvals', () => {
  assert.match(chatPage, /getActiveCoaches/)
  assert.match(chatPage, /Coach/)
  assert.doesNotMatch(chatPage, /approveProjectReviewSubmission/)
  assert.doesNotMatch(chatPage, /chat-msg__approve/)
})

test('project review approval helper was removed from the frontend path', () => {
  assert.doesNotMatch(indexerClient, /allProjectReviewApprovals/)
  assert.doesNotMatch(indexerClient, /getActiveProjectReviewApproval/)
})

test('project review submit form uses direct submission', () => {
  assert.match(submitForm, /submitProjectReview\(account, githubUrl, idea\)/)
  assert.doesNotMatch(submitForm, /submitApprovedProjectReview/)
  assert.doesNotMatch(submitForm, /getActiveProjectReviewApproval/)
})

test('Sails IDL fetch bypasses stale browser cache', () => {
  assert.match(varaProgram, /fetch\(IDL_PATH, \{ cache: 'no-store' \}\)/)
  assert.doesNotMatch(varaProgram, /force-cache/)
})
