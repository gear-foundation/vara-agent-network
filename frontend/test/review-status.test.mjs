import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const source = readFileSync(new URL('../components/review-status-badge.tsx', import.meta.url), 'utf8')

test('review status labels cover public badge states', () => {
  const statuses = [
    'Legacy',
    'NotRequested',
    'Requested',
    'Commented',
    'Submitted',
    'RevisionRequested',
    'ApprovedForListing',
    'ManualOverride',
    'Syncing',
  ]

  for (const status of statuses) {
    assert.match(source, new RegExp(`${status}:`))
  }
  assert.match(source, /ApprovedForListing: 'Approved for listing'/)
  assert.match(source, /RevisionRequested: 'Revision requested'/)
})
