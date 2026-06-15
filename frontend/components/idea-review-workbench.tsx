'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { ExternalLink, Link2, MessageSquare, ShieldCheck } from 'lucide-react'
import { formatTime, shortAddress } from '@/components/review-ui-helpers'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import { useCurrentUserState } from '@/hooks/use-current-user-state'
import { useVaraWallet } from '@/hooks/use-vara-wallet'
import { getIdeaReviewDetail, type IdeaReviewDetail, type IdeaReviewEvent } from '@/lib/indexer-client'
import {
  isReviewer,
  linkIdeaReviewToApplication,
  ownerIdeaReply,
  postIdeaReviewerComment,
  recordIdeaGuidance,
  type IdeaGuidanceOutcome,
} from '@/lib/vara-program'

const OUTCOMES: Array<{ value: IdeaGuidanceOutcome; label: string }> = [
  { value: 'Proceed', label: 'Proceed' },
  { value: 'Refine', label: 'Refine' },
  { value: 'NeedsEvidence', label: 'Needs evidence' },
  { value: 'NotRecommended', label: 'Not recommended' },
]

function eventTitle(event: IdeaReviewEvent) {
  if (event.kind === 'guidance') return `Guidance: ${event.outcome}`
  if (event.kind === 'link') return 'Linked application'
  return event.authorRole === 'Reviewer' ? 'Reviewer comment' : 'Owner reply'
}

export function IdeaReviewWorkbench({
  ideaId,
  initialDetail,
}: {
  ideaId: string
  initialDetail: IdeaReviewDetail
}) {
  const [detail, setDetail] = useState(initialDetail)
  const [commentText, setCommentText] = useState('')
  const [replyText, setReplyText] = useState('')
  const [guidanceText, setGuidanceText] = useState('')
  const [outcome, setOutcome] = useState<IdeaGuidanceOutcome>('Proceed')
  const [programId, setProgramId] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const { account } = useVaraWallet()
  const { state } = useCurrentUserState()
  const [reviewer, setReviewer] = useState(false)

  const summary = detail.summary
  const ownerActorId = state.kind === 'disconnected' ? null : state.ownerActorId
  const isOwner = Boolean(summary && ownerActorId && summary.owner.toLowerCase() === ownerActorId.toLowerCase())
  const events = detail.events

  useEffect(() => {
    let active = true
    if (!account) {
      setReviewer(false)
      return
    }
    void isReviewer(account.address)
      .then((value) => {
        if (active) setReviewer(value)
      })
      .catch(() => {
        if (active) setReviewer(false)
      })
    return () => {
      active = false
    }
  }, [account])

  async function refresh() {
    setDetail(await getIdeaReviewDetail(ideaId))
  }

  async function run(label: string, action: () => Promise<unknown>) {
    if (!account) {
      setError('Connect a Vara account first.')
      return
    }
    setBusy(label)
    setError(null)
    try {
      await action()
      window.setTimeout(() => void refresh(), 1800)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(null)
    }
  }

  if (!summary) {
    return (
      <div className="review-empty">
        <h1>Idea review not found</h1>
        <Link href="/dashboard/idea-reviews">Back to idea queue</Link>
      </div>
    )
  }

  return (
    <div className="review-workbench">
      <aside className="review-panel review-dossier">
        <div className="review-panel__kicker">Idea review</div>
        <h1>Idea #{summary.ideaId}</h1>
        <div className="review-dossier__meta">
          <span>{summary.status}</span>
          <span>{summary.commentCount} comments</span>
        </div>
        <p>{summary.idea}</p>
        <dl className="review-dossier__facts">
          <div>
            <dt>Owner</dt>
            <dd title={summary.owner}>{shortAddress(summary.owner)}</dd>
          </div>
          <div>
            <dt>Updated</dt>
            <dd>{formatTime(summary.updatedAt)}</dd>
          </div>
          <div>
            <dt>Guidance</dt>
            <dd>{summary.latestGuidanceOutcome ?? 'pending'}</dd>
          </div>
          <div>
            <dt>Linked app</dt>
            <dd>{summary.linkedProgramId ? shortAddress(summary.linkedProgramId) : 'none'}</dd>
          </div>
        </dl>
        <div className="review-dossier__links">
          <a href={summary.githubUrl} rel="noreferrer" target="_blank">
            GitHub <ExternalLink className="h-3.5 w-3.5" />
          </a>
          {summary.linkedProgramId ? (
            <Link href={`/applications/${summary.linkedProgramId}`}>
              Application <ExternalLink className="h-3.5 w-3.5" />
            </Link>
          ) : null}
        </div>
      </aside>

      <section className="review-thread">
        <div className="review-thread__header">
          <div>
            <div className="review-panel__kicker">Public guidance thread</div>
            <h2>Review history</h2>
          </div>
        </div>
        {events.length === 0 ? (
          <div className="review-empty">
            <MessageSquare className="h-5 w-5" />
            <p>No guidance yet.</p>
          </div>
        ) : (
          <div className="review-receipts">
            {events.map((event) => (
              <article className="review-receipt" data-kind={event.kind} key={event.id}>
                <header>
                  <span>{eventTitle(event)}</span>
                  <time>{formatTime(event.at)}</time>
                </header>
                <p>{event.kind === 'link' ? event.programId : event.body}</p>
                <footer>
                  <span>{shortAddress(event.author)}</span>
                </footer>
              </article>
            ))}
          </div>
        )}
      </section>

      <aside className="review-panel review-actions">
        <div className="review-panel__kicker">Actions</div>
        <h2>Idea controls</h2>
        <p>All comments and guidance are public. Do not post secrets, private coaching notes, or PII.</p>
        {error ? <div className="review-error">{error}</div> : null}

        {isOwner ? (
          <>
            <div className="review-action-box">
              <h3>Owner reply</h3>
              <Textarea value={replyText} onChange={(event) => setReplyText(event.target.value)} />
              <Button disabled={!!busy || !replyText.trim()} onClick={() => void run('reply', () => ownerIdeaReply(account!, ideaId, replyText.trim()))}>
                Reply
              </Button>
            </div>
            {!summary.linkedProgramId ? (
              <div className="review-action-box">
                <h3>Link deployed app</h3>
                <Input placeholder="0x..." value={programId} onChange={(event) => setProgramId(event.target.value)} />
                <Button disabled={!!busy || !programId.trim()} onClick={() => void run('link', () => linkIdeaReviewToApplication(account!, ideaId, programId.trim()))}>
                  <Link2 className="h-4 w-4" /> Link app
                </Button>
              </div>
            ) : null}
          </>
        ) : null}

        {reviewer ? (
          <>
            <div className="review-action-box">
              <h3>Reviewer comment</h3>
              <Textarea value={commentText} onChange={(event) => setCommentText(event.target.value)} />
              <Button disabled={!!busy || !commentText.trim()} onClick={() => void run('comment', () => postIdeaReviewerComment(account!, ideaId, commentText.trim()))}>
                <ShieldCheck className="h-4 w-4" /> Comment
              </Button>
            </div>
            <div className="review-action-box">
              <h3>Record guidance</h3>
              <Select value={outcome} onValueChange={(value) => setOutcome(value as IdeaGuidanceOutcome)}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {OUTCOMES.map((item) => (
                    <SelectItem key={item.value} value={item.value}>{item.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Textarea value={guidanceText} onChange={(event) => setGuidanceText(event.target.value)} />
              <Button disabled={!!busy || !guidanceText.trim()} onClick={() => void run('guidance', () => recordIdeaGuidance(account!, ideaId, outcome, guidanceText.trim()))}>
                Record guidance
              </Button>
            </div>
          </>
        ) : null}

        {!isOwner && !reviewer ? (
          <div className="review-empty">Connect as the owner or an active reviewer to act on this idea.</div>
        ) : null}
      </aside>
    </div>
  )
}
