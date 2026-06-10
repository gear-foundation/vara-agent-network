'use client'

import { useEffect, useState } from 'react'
import { Plus, RefreshCw, ShieldCheck, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { useVaraWallet } from '@/hooks/use-vara-wallet'
import { addReviewer, listReviewers, removeReviewer } from '@/lib/vara-program'

function shortAddress(value: string) {
  return value.length <= 16 ? value : `${value.slice(0, 10)}...${value.slice(-6)}`
}

export function ReviewerAdminPanel() {
  const { account } = useVaraWallet()
  const [reviewers, setReviewers] = useState<string[]>([])
  const [reviewerInput, setReviewerInput] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  async function refresh() {
    setLoading(true)
    setError(null)
    try {
      setReviewers(await listReviewers(account?.address))
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void refresh()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [account?.address])

  async function run(label: string, action: () => Promise<unknown>) {
    if (!account) {
      setError('Connect an admin account first.')
      return
    }
    setBusy(label)
    setError(null)
    try {
      await action()
      setReviewerInput('')
      await refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(null)
    }
  }

  return (
    <section className="review-queue-section review-reviewer-admin">
      <header>
        <ShieldCheck className="h-4 w-4" />
        <h2>Active reviewers</h2>
        <Button variant="ghost" size="sm" disabled={loading || !!busy} onClick={() => void refresh()}>
          <RefreshCw className="h-4 w-4" /> Refresh
        </Button>
      </header>

      <div className="review-reviewer-admin__body">
        {error ? <div className="review-error">{error}</div> : null}
        <div className="review-reviewer-admin__form">
          <Input
            aria-label="Reviewer ActorId or wallet address"
            placeholder="Reviewer ActorId or wallet address"
            value={reviewerInput}
            onChange={(event) => setReviewerInput(event.target.value)}
          />
          <Button
            disabled={!!busy || !reviewerInput.trim()}
            onClick={() => void run('add', () => addReviewer(account!, reviewerInput.trim()))}
          >
            <Plus className="h-4 w-4" /> Add
          </Button>
        </div>

        {loading ? (
          <div className="review-empty">Loading reviewers.</div>
        ) : reviewers.length === 0 ? (
          <div className="review-empty">No active reviewers.</div>
        ) : (
          <div className="review-reviewer-list">
            {reviewers.map((reviewer) => (
              <div className="review-reviewer-row" key={reviewer}>
                <span title={reviewer}>{shortAddress(reviewer)}</span>
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={!!busy}
                  onClick={() => void run(`remove-${reviewer}`, () => removeReviewer(account!, reviewer))}
                >
                  <Trash2 className="h-4 w-4" /> Remove
                </Button>
              </div>
            ))}
          </div>
        )}
      </div>
    </section>
  )
}
