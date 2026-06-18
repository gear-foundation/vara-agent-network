'use client'

import { useEffect, useState } from 'react'
import { Plus, RefreshCw, ShieldCheck, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { useVaraWallet } from '@/hooks/use-vara-wallet'
import { addCoach, addReviewer, listCoaches, listReviewers, removeCoach, removeReviewer } from '@/lib/vara-program'

function shortAddress(value: string) {
  return value.length <= 16 ? value : `${value.slice(0, 10)}...${value.slice(-6)}`
}

type RoleSectionProps = {
  label: string
  inputLabel: string
  input: string
  setInput: (value: string) => void
  items: string[]
  loading: boolean
  busy: boolean
  onAdd: () => void
  onRemove: (value: string) => void
}

function RoleSection({
  label,
  inputLabel,
  input,
  setInput,
  items,
  loading,
  busy,
  onAdd,
  onRemove,
}: RoleSectionProps) {
  return (
    <div className="review-reviewer-admin__body">
      <h3>Active {label}</h3>
      <div className="review-reviewer-admin__form">
        <Input
          aria-label={inputLabel}
          placeholder={inputLabel}
          value={input}
          onChange={(event) => setInput(event.target.value)}
        />
        <Button disabled={busy || !input.trim()} onClick={onAdd}>
          <Plus className="h-4 w-4" /> Add
        </Button>
      </div>

      {loading ? (
        <div className="review-empty">Loading {label}.</div>
      ) : items.length === 0 ? (
        <div className="review-empty">No active {label}.</div>
      ) : (
        <div className="review-reviewer-list">
          {items.map((item) => (
            <div className="review-reviewer-row" key={item}>
              <span title={item}>{shortAddress(item)}</span>
              <Button
                variant="ghost"
                size="sm"
                disabled={busy}
                onClick={() => onRemove(item)}
              >
                <Trash2 className="h-4 w-4" /> Remove
              </Button>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

export function ReviewerAdminPanel() {
  const { account } = useVaraWallet()
  const [reviewers, setReviewers] = useState<string[]>([])
  const [coaches, setCoaches] = useState<string[]>([])
  const [reviewerInput, setReviewerInput] = useState('')
  const [coachInput, setCoachInput] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  async function refresh() {
    setLoading(true)
    setError(null)
    try {
      const [nextReviewers, nextCoaches] = await Promise.all([
        listReviewers(account?.address),
        listCoaches(account?.address),
      ])
      setReviewers(nextReviewers)
      setCoaches(nextCoaches)
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
      setCoachInput('')
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
        <h2>Review roles</h2>
        <Button variant="ghost" size="sm" disabled={loading || !!busy} onClick={() => void refresh()}>
          <RefreshCw className="h-4 w-4" /> Refresh
        </Button>
      </header>

      <div className="review-reviewer-admin__body">
        {error ? <div className="review-error">{error}</div> : null}
      </div>

      <RoleSection
        label="reviewers"
        inputLabel="Reviewer ActorId or wallet address"
        input={reviewerInput}
        setInput={setReviewerInput}
        items={reviewers}
        loading={loading}
        busy={!!busy}
        onAdd={() => void run('add', () => addReviewer(account!, reviewerInput.trim()))}
        onRemove={(reviewer) => void run(`remove-${reviewer}`, () => removeReviewer(account!, reviewer))}
      />
      <RoleSection
        label="coaches"
        inputLabel="Coach ActorId or wallet address"
        input={coachInput}
        setInput={setCoachInput}
        items={coaches}
        loading={loading}
        busy={!!busy}
        onAdd={() => void run('add-coach', () => addCoach(account!, coachInput.trim()))}
        onRemove={(coach) => void run(`remove-coach-${coach}`, () => removeCoach(account!, coach))}
      />
    </section>
  )
}
