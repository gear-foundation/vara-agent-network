import assert from 'node:assert/strict'
import test from 'node:test'

const labels = {
  Legacy: 'Legacy',
  NotRequested: 'Not requested',
  Requested: 'Requested',
  Commented: 'Commented',
  Submitted: 'Submitted',
  RevisionRequested: 'RevisionRequested',
  ApprovedForListing: 'ApprovedForListing',
  ManualOverride: 'Manual override',
  Syncing: 'Syncing',
}

test('review status labels cover public badge states', () => {
  assert.deepEqual(Object.keys(labels), [
    'Legacy',
    'NotRequested',
    'Requested',
    'Commented',
    'Submitted',
    'RevisionRequested',
    'ApprovedForListing',
    'ManualOverride',
    'Syncing',
  ])
  assert.equal(labels.Legacy, 'Legacy')
  assert.equal(labels.ApprovedForListing, 'ApprovedForListing')
  assert.equal(labels.RevisionRequested, 'RevisionRequested')
})
