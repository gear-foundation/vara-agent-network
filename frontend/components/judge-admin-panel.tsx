'use client'

import { useEffect, useState } from 'react'
import { Plus, RefreshCw, ShieldCheck, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { useVaraWallet } from '@/hooks/use-vara-wallet'
import { addReviewJudge, listReviewJudges, removeReviewJudge } from '@/lib/vara-program'

function shortAddress(value: string) {
  return value.length <= 16 ? value : `${value.slice(0, 10)}...${value.slice(-6)}`
}

export function JudgeAdminPanel() {
  const { account } = useVaraWallet()
  const [judges, setJudges] = useState<string[]>([])
  const [judgeInput, setJudgeInput] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  async function refresh() {
    setLoading(true)
    setError(null)
    try {
      setJudges(await listReviewJudges(account?.address))
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
      setJudgeInput('')
      await refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(null)
    }
  }

  return (
    <section className="review-queue-section review-judge-admin">
      <header>
        <ShieldCheck className="h-4 w-4" />
        <h2>Active judges</h2>
        <Button variant="ghost" size="sm" disabled={loading || !!busy} onClick={() => void refresh()}>
          <RefreshCw className="h-4 w-4" /> Refresh
        </Button>
      </header>

      <div className="review-judge-admin__body">
        {error ? <div className="review-error">{error}</div> : null}
        <div className="review-judge-admin__form">
          <Input
            aria-label="Judge ActorId or wallet address"
            placeholder="Judge ActorId or wallet address"
            value={judgeInput}
            onChange={(event) => setJudgeInput(event.target.value)}
          />
          <Button
            disabled={!!busy || !judgeInput.trim()}
            onClick={() => void run('add', () => addReviewJudge(account!, judgeInput.trim()))}
          >
            <Plus className="h-4 w-4" /> Add
          </Button>
        </div>

        {loading ? (
          <div className="review-empty">Loading judges.</div>
        ) : judges.length === 0 ? (
          <div className="review-empty">No active judges.</div>
        ) : (
          <div className="review-judge-list">
            {judges.map((judge) => (
              <div className="review-judge-row" key={judge}>
                <span title={judge}>{shortAddress(judge)}</span>
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={!!busy}
                  onClick={() => void run(`remove-${judge}`, () => removeReviewJudge(account!, judge))}
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
