import assert from 'node:assert/strict'
import test from 'node:test'

const labels = {
  Legacy: 'Legacy',
  NotRequested: 'Not requested',
  Requested: 'Requested',
  Commented: 'Commented',
  Submitted: 'Submitted',
  Rejected: 'Rejected',
  Accepted: 'Accepted',
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
    'Rejected',
    'Accepted',
    'ManualOverride',
    'Syncing',
  ])
  assert.equal(labels.Legacy, 'Legacy')
  assert.equal(labels.Accepted, 'Accepted')
  assert.equal(labels.Rejected, 'Rejected')
})
