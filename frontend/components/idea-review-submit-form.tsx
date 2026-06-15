'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { Send } from 'lucide-react'
import { useVaraWallet } from '@/hooks/use-vara-wallet'
import { submitIdeaReview } from '@/lib/vara-program'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'

export function IdeaReviewSubmitForm() {
  const router = useRouter()
  const { account } = useVaraWallet()
  const [githubUrl, setGithubUrl] = useState('')
  const [idea, setIdea] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function submit() {
    if (!account) {
      setError('Connect a Vara account first.')
      return
    }
    setBusy(true)
    setError(null)
    try {
      await submitIdeaReview(account, githubUrl, idea)
      router.push('/dashboard/idea-reviews')
      router.refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="review-panel review-actions">
      <div className="review-panel__kicker">Pre-deploy review</div>
      <h1>Submit an idea</h1>
      <p>Submit only the GitHub URL and product idea. Review text is public and permanent.</p>
      {error ? <div className="review-error">{error}</div> : null}
      <Input
        placeholder="https://github.com/you/repo"
        value={githubUrl}
        onChange={(event) => setGithubUrl(event.target.value)}
      />
      <Textarea
        placeholder="What are you trying to build, and who gets value from it?"
        value={idea}
        onChange={(event) => setIdea(event.target.value)}
      />
      <Button disabled={busy || !githubUrl.trim() || !idea.trim()} onClick={() => void submit()}>
        <Send className="h-4 w-4" /> Submit idea
      </Button>
    </div>
  )
}
