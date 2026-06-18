'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { MessageSquare, Send, ShieldCheck } from 'lucide-react'
import { useVaraWallet } from '@/hooks/use-vara-wallet'
import { getActiveProjectReviewApproval, type ProjectReviewApproval } from '@/lib/indexer-client'
import { addressToActorId, submitApprovedProjectReview } from '@/lib/vara-program'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'

export function ProjectReviewSubmitForm() {
  const router = useRouter()
  const { account } = useVaraWallet()
  const [githubUrl, setGithubUrl] = useState('')
  const [idea, setIdea] = useState('')
  const [busy, setBusy] = useState(false)
  const [approval, setApproval] = useState<ProjectReviewApproval | null>(null)
  const [approvalLoading, setApprovalLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function refreshApproval() {
    if (!account?.address) {
      setApproval(null)
      return
    }
    setApprovalLoading(true)
    setError(null)
    try {
      const actorId = await addressToActorId(account.address)
      setApproval(await getActiveProjectReviewApproval(actorId))
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setApprovalLoading(false)
    }
  }

  useEffect(() => {
    void refreshApproval()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [account?.address])

  async function submit() {
    if (!account) {
      setError('Connect a Vara account first.')
      return
    }
    if (!approval) {
      setError('A Coach approval is required before project review submission.')
      return
    }
    setBusy(true)
    setError(null)
    try {
      await submitApprovedProjectReview(account, githubUrl, idea, approval.approvalId)
      router.push('/dashboard/project-reviews')
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
      <h1>Submit a project</h1>
      <p>Submit only the GitHub URL and product idea. Review text is public and permanent.</p>
      <div className="review-approval-state">
        {approval ? (
          <span><ShieldCheck className="h-4 w-4" /> Coach approval #{approval.approvalId}</span>
        ) : approvalLoading ? (
          <span>Checking Coach approval...</span>
        ) : (
          <span>No active Coach approval found.</span>
        )}
        <Button variant="ghost" size="sm" onClick={() => void refreshApproval()} disabled={approvalLoading || busy}>
          Refresh
        </Button>
      </div>
      {!approval && !approvalLoading ? (
        <Button asChild variant="outline">
          <Link href="/chat"><MessageSquare className="h-4 w-4" /> Open chat</Link>
        </Button>
      ) : null}
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
      <Button disabled={busy || approvalLoading || !approval || !githubUrl.trim() || !idea.trim()} onClick={() => void submit()}>
        <Send className="h-4 w-4" /> Submit project
      </Button>
    </div>
  )
}
