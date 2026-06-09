'use client'

import { useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import Link from 'next/link'
import { CheckCircle2, Clock3, ExternalLink, GitBranch, MessageSquare, RefreshCw, Send, ShieldCheck, XCircle } from 'lucide-react'
import {
  getApplicationReviewDetail,
  type ApplicationReviewDetail,
  type ApplicationReviewEvent,
} from '@/lib/indexer-client'
import {
  decideReview,
  isReviewer,
  ownerReply,
  postReviewerComment,
  requestReview,
  replaceApplicationProgram,
  submitApplication,
  type ReviewCoverage,
  type ReviewCriteriaInput,
} from '@/lib/vara-program'
import { useCurrentUserState } from '@/hooks/use-current-user-state'
import { useVaraWallet } from '@/hooks/use-vara-wallet'
import { ReviewStatusBadge } from '@/components/review-status-badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'

type CriteriaKey = keyof ReviewCriteriaInput
type CriteriaDraft = Record<CriteriaKey, { coverage: ReviewCoverage | ''; note: string }>

const CRITERIA_FIELDS: Array<{ key: CriteriaKey; label: string }> = [
  { key: 'technical_readiness', label: 'Technical readiness' },
  { key: 'network_value', label: 'Network value' },
  { key: 'evidence_quality', label: 'Evidence quality' },
  { key: 'safety_maintenance', label: 'Safety maintenance' },
]

const COVERAGE_OPTIONS: Array<{ value: ReviewCoverage; label: string }> = [
  { value: 'Missing', label: 'Missing' },
  { value: 'Partial', label: 'Partial' },
  { value: 'Met', label: 'Met' },
  { value: 'NotApplicable', label: 'N/A' },
]

const INITIAL_CRITERIA: CriteriaDraft = {
  technical_readiness: { coverage: '', note: '' },
  network_value: { coverage: '', note: '' },
  evidence_quality: { coverage: '', note: '' },
  safety_maintenance: { coverage: '', note: '' },
}

function shortAddress(value: string) {
  return value.length <= 14 ? value : `${value.slice(0, 8)}...${value.slice(-4)}`
}

function formatTime(value: string) {
  const ms = Number(value)
  if (!Number.isFinite(ms) || ms <= 0) return 'pending time'
  return new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(ms))
}

function eventLabel(event: ApplicationReviewEvent) {
  if (event.kind === 'request') return 'Review requested'
  if (event.kind === 'decision') return event.verdict === 'ApprovedForListing' ? 'Approved for listing' : 'Revision requested'
  return event.authorRole === 'Reviewer' ? 'Reviewer comment' : 'Owner reply'
}

function groupByRevision(events: ApplicationReviewEvent[]) {
  return events.reduce((map, event) => {
    const list = map.get(event.revision) ?? []
    list.push(event)
    map.set(event.revision, list)
    return map
  }, new Map<number, ApplicationReviewEvent[]>())
}

export function ReviewWorkbench({
  initialDetail,
  programId,
}: {
  initialDetail: ApplicationReviewDetail
  programId: string
}) {
  const [detail, setDetail] = useState(initialDetail)
  const [requestText, setRequestText] = useState('')
  const [commentText, setCommentText] = useState('')
  const [replyText, setReplyText] = useState('')
  const [decisionText, setDecisionText] = useState('')
  const [replacementProgramId, setReplacementProgramId] = useState('')
  const [replacementReason, setReplacementReason] = useState('')
  const [criteriaDraft, setCriteriaDraft] = useState<CriteriaDraft>(INITIAL_CRITERIA)
  const [busy, setBusy] = useState<string | null>(null)
  const [pendingIndexer, setPendingIndexer] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const { account } = useVaraWallet()
  const { state } = useCurrentUserState()
  const [reviewer, setReviewer] = useState(false)

  const app = detail.application
  const summary = detail.summary ?? app?.reviewSummary ?? null
  const displayRevision = summary?.displayRevision ?? 1
  const ownerActorId = state.kind === 'disconnected' ? null : state.ownerActorId
  const isOwner = Boolean(app && ownerActorId && app.owner.toLowerCase() === ownerActorId.toLowerCase())
  const revisionGroups = useMemo(
    () => [...groupByRevision(detail.events).entries()].sort(([a], [b]) => b - a),
    [detail.events],
  )
  const decisionCriteria = useMemo(() => buildCriteria(criteriaDraft), [criteriaDraft])

  function updateCriterion(key: CriteriaKey, patch: Partial<CriteriaDraft[CriteriaKey]>) {
    setCriteriaDraft((current) => ({
      ...current,
      [key]: {
        ...current[key],
        ...patch,
      },
    }))
  }

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
    const next = await getApplicationReviewDetail(programId)
    if (next.currentProgramId !== programId.toLowerCase()) {
      window.location.href = `/applications/${next.currentProgramId}`
      return next
    }
    setDetail(next)
    return next
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
      setPendingIndexer(true)
      window.setTimeout(() => {
        void refresh().finally(() => setPendingIndexer(false))
      }, 1800)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(null)
    }
  }

  if (!app) {
    return (
      <div className="review-empty">
        <h1>Application not found</h1>
        <p>The indexer has no application row for this program id.</p>
        <Link href="/board">Back to board</Link>
      </div>
    )
  }

  return (
    <div className="review-workbench">
      <aside className="review-panel review-dossier">
        <div className="review-panel__kicker">Application dossier</div>
        <h1>{app.displayName}</h1>
        <div className="review-dossier__meta">
          <ReviewStatusBadge summary={summary} />
          <span>{app.status}</span>
          <span>{app.track}</span>
        </div>
        <p>{app.description || 'Registered on-chain application.'}</p>
        <dl className="review-dossier__facts">
          <div>
            <dt>Program</dt>
            <dd title={app.id}>{shortAddress(app.id)}</dd>
          </div>
          <div>
            <dt>Owner</dt>
            <dd title={app.owner}>{shortAddress(app.owner)}</dd>
          </div>
          <div>
            <dt>Display revision</dt>
            <dd>r{displayRevision}</dd>
          </div>
          <div>
            <dt>Comments</dt>
            <dd>{summary?.totalVisibleCommentCount ?? 0}</dd>
          </div>
        </dl>
        <div className="review-dossier__links">
          {app.githubUrl ? (
            <a href={app.githubUrl} rel="noreferrer" target="_blank">
              GitHub <ExternalLink className="h-3.5 w-3.5" />
            </a>
          ) : null}
          {app.idlUrl ? (
            <a href={app.idlUrl} rel="noreferrer" target="_blank">
              IDL <ExternalLink className="h-3.5 w-3.5" />
            </a>
          ) : null}
        </div>
        {detail.replacements.length > 0 ? (
          <div className="review-deployments">
            <div className="review-panel__kicker">Deployment history</div>
            {detail.replacements.map((replacement) => (
              <div className="review-deployment" key={replacement.eventId}>
                <span title={replacement.oldProgramId}>{shortAddress(replacement.oldProgramId)}</span>
                <span>to</span>
                <span title={replacement.newProgramId}>{shortAddress(replacement.newProgramId)}</span>
                <time>{formatTime(replacement.replacedAt)}</time>
              </div>
            ))}
          </div>
        ) : null}
      </aside>

      <section className="review-thread">
        <div className="review-thread__header">
          <div>
            <div className="review-panel__kicker">Public review thread</div>
            <h2>Revision receipts</h2>
          </div>
          {pendingIndexer ? (
            <span className="review-sync"><Clock3 className="h-4 w-4" /> indexer catching up</span>
          ) : null}
        </div>

        {revisionGroups.length === 0 ? (
          <div className="review-empty">
            <MessageSquare className="h-5 w-5" />
            <p>No review yet.</p>
          </div>
        ) : (
          revisionGroups.map(([revision, events]) => (
            <div className="review-revision" key={revision}>
              <div className="review-revision__rail">
                <GitBranch className="h-4 w-4" />
                r{revision}
              </div>
              <div className="review-receipts">
                {events.map((event) => (
                  <article className="review-receipt" data-kind={event.kind} key={event.id}>
                    <header>
                      <span>{eventLabel(event)}</span>
                      <time>{formatTime(event.at)}</time>
                    </header>
                    <p>{event.body}</p>
                    <footer>
                      <span>{shortAddress(event.author)}</span>
                      {event.kind === 'request' && event.acknowledged ? <span>addressed</span> : null}
                      {event.kind === 'decision' ? <span>{event.oldStatus} to {event.newStatus}</span> : null}
                    </footer>
                  </article>
                ))}
              </div>
            </div>
          ))
        )}
      </section>

      <aside className="review-panel review-actions">
        <div className="review-panel__kicker">Actions</div>
        <h2>Review controls</h2>
        <p className="review-warning">Review text is public and permanent. Do not include private coaching notes.</p>
        {error ? <div className="review-error">{error}</div> : null}

        {isOwner && app.status === 'Building' ? (
          <ActionBox title="Request feedback">
            <Textarea value={requestText} onChange={(event) => setRequestText(event.target.value)} />
            <Button disabled={!!busy || !requestText.trim()} onClick={() => void run('request', () => requestReview(account!, app.id, requestText.trim()))}>
              <Send className="h-4 w-4" /> Request review
            </Button>
            <Button variant="secondary" disabled={!!busy} onClick={() => void run('submit', () => submitApplication(account!, app.id))}>
              Submit application
            </Button>
          </ActionBox>
        ) : null}

        {isOwner && app.status === 'Building' ? (
          <ActionBox title="Replace program id">
            <Input
              placeholder="0x..."
              value={replacementProgramId}
              onChange={(event) => setReplacementProgramId(event.target.value)}
            />
            <Textarea
              placeholder="Reason"
              value={replacementReason}
              onChange={(event) => setReplacementReason(event.target.value)}
            />
            <Button
              disabled={!!busy || !replacementProgramId.trim() || !replacementReason.trim()}
              onClick={() => void run('replace-program', () => replaceApplicationProgram(
                account!,
                app.id,
                replacementProgramId.trim(),
                replacementReason.trim(),
              ))}
            >
              <RefreshCw className="h-4 w-4" /> Replace program
            </Button>
          </ActionBox>
        ) : null}

        {isOwner && (app.status === 'Building' || app.status === 'Submitted') ? (
          <ActionBox title="Reply publicly">
            <Textarea value={replyText} onChange={(event) => setReplyText(event.target.value)} />
            <Button disabled={!!busy || !replyText.trim()} onClick={() => void run('reply', () => ownerReply(account!, app.id, displayRevision, replyText.trim()))}>
              Reply
            </Button>
          </ActionBox>
        ) : null}

        {reviewer && (app.status === 'Building' || app.status === 'Submitted') ? (
          <ActionBox title="Reviewer comment">
            <Textarea value={commentText} onChange={(event) => setCommentText(event.target.value)} />
            <Button disabled={!!busy || !commentText.trim()} onClick={() => void run('comment', () => postReviewerComment(account!, app.id, displayRevision, commentText.trim()))}>
              <ShieldCheck className="h-4 w-4" /> Comment
            </Button>
          </ActionBox>
        ) : null}

        {reviewer && app.status === 'Submitted' ? (
          <ActionBox title="Decision">
            <Textarea value={decisionText} onChange={(event) => setDecisionText(event.target.value)} />
            <div className="review-criteria-grid">
              {CRITERIA_FIELDS.map((field) => (
                <div className="review-criterion" key={field.key}>
                  <div className="review-criterion__row">
                    <span>{field.label}</span>
                    <Select
                      value={criteriaDraft[field.key].coverage}
                      onValueChange={(value) => {
                        updateCriterion(field.key, { coverage: value as ReviewCoverage })
                      }}
                    >
                      <SelectTrigger aria-label={`${field.label} coverage`} className="review-criterion__select" size="sm">
                        <SelectValue placeholder="Select" />
                      </SelectTrigger>
                      <SelectContent>
                        {COVERAGE_OPTIONS.map((option) => (
                          <SelectItem key={option.value} value={option.value}>
                            {option.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <Textarea
                    aria-label={`${field.label} note`}
                    placeholder="Optional public note"
                    value={criteriaDraft[field.key].note}
                    onChange={(event) => {
                      updateCriterion(field.key, { note: event.target.value })
                    }}
                  />
                </div>
              ))}
            </div>
            <div className="review-actions__split">
              <Button
                disabled={!!busy || !decisionText.trim() || !decisionCriteria}
                onClick={() => {
                  if (!decisionCriteria) return
                  void run('approve', () => decideReview(account!, app.id, displayRevision, 'ApprovedForListing', decisionText.trim(), decisionCriteria))
                }}
              >
                <CheckCircle2 className="h-4 w-4" /> Approve
              </Button>
              <Button
                variant="destructive"
                disabled={!!busy || !decisionText.trim() || !decisionCriteria}
                onClick={() => {
                  if (!decisionCriteria) return
                  void run('request-revision', () => decideReview(account!, app.id, displayRevision, 'RevisionRequested', decisionText.trim(), decisionCriteria))
                }}
              >
                <XCircle className="h-4 w-4" /> Request revision
              </Button>
            </div>
          </ActionBox>
        ) : null}

        {!isOwner && !reviewer ? (
          <div className="review-empty">Connect as the owner or an active reviewer to act on this application.</div>
        ) : null}
      </aside>
    </div>
  )
}

function buildCriteria(draft: CriteriaDraft): ReviewCriteriaInput | null {
  const technicalReadiness = criterionInput(draft.technical_readiness)
  const networkValue = criterionInput(draft.network_value)
  const evidenceQuality = criterionInput(draft.evidence_quality)
  const safetyMaintenance = criterionInput(draft.safety_maintenance)

  if (!technicalReadiness || !networkValue || !evidenceQuality || !safetyMaintenance) return null

  return {
    technical_readiness: technicalReadiness,
    network_value: networkValue,
    evidence_quality: evidenceQuality,
    safety_maintenance: safetyMaintenance,
  }
}

function criterionInput(field: CriteriaDraft[CriteriaKey]): ReviewCriteriaInput[CriteriaKey] | null {
  if (!field.coverage) return null
  const note = field.note.trim()
  return { coverage: field.coverage, note: note ? note : null }
}

function ActionBox({ title, children }: { title: string, children: ReactNode }) {
  return (
    <div className="review-action-box">
      <h3>{title}</h3>
      {children}
    </div>
  )
}
