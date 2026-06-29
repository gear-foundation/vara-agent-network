'use client'

import { useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import {
  CheckCircle2,
  Clock3,
  ExternalLink,
  Github,
  MessageSquare,
  Search,
  ShieldCheck,
  UserRound,
  WrapText,
} from 'lucide-react'
import { formatTime, shortAddress } from '@/components/review-ui-helpers'
import { Button } from '@/components/ui/button'
import {
  getProjectReviewDetail,
  type ProjectReviewDetail,
  type ProjectReviewEvent,
  type ProjectReviewSummary,
  type RegistryAgent,
} from '@/lib/indexer-client'

type AgentByReview = Record<string, RegistryAgent | null>
type BuilderByOwner = Record<string, { handle: string; displayName: string }>
type VisibleReviewEvent = Exclude<ProjectReviewEvent, { kind: 'link' }>

type DashboardProps = {
  reviews: ProjectReviewSummary[]
  agentsByReviewId: AgentByReview
  buildersByOwnerId: BuilderByOwner
  initialDetail: ProjectReviewDetail | null
}

type Metric = {
  label: string
  value: number
  tone: 'neutral' | 'good' | 'warn' | 'info'
}

const STATUS_LABELS: Record<string, string> = {
  Submitted: 'Submitted',
  Commented: 'Commented',
  GuidanceRecorded: 'Guidance recorded',
  Linked: 'Linked app',
}

const OUTCOME_LABELS: Record<string, string> = {
  Proceed: 'Proceed',
  NeedsChanges: 'Needs changes',
  NotRecommended: 'Not recommended',
}

function reviewTitle(review: ProjectReviewSummary) {
  const repoName = repoSlug(review.githubUrl)
  if (repoName) return humanizeSlug(repoName)

  const firstLine = review.idea
    .split('\n')
    .map((line) => line.trim())
    .find(Boolean)
    ?? `Project Review #${review.projectReviewId}`

  return firstLine
    .replace(/^#+\s*/, '')
    .replace(/^project\s*:\s*/i, '')
    .slice(0, 64)
}

function reviewPreview(review: ProjectReviewSummary) {
  const compact = review.idea.replace(/\s+/g, ' ').trim()
  return compact.length > 220 ? `${compact.slice(0, 217)}...` : compact
}

function repoSlug(githubUrl: string) {
  try {
    const url = new URL(githubUrl)
    const parts = url.pathname.split('/').filter(Boolean)
    const treeIndex = parts.indexOf('tree')
    if (treeIndex >= 0 && parts.length > treeIndex + 2) {
      return parts[parts.length - 1]
    }
    return parts[1] ?? parts[0] ?? null
  } catch {
    const parts = githubUrl.split('/').filter(Boolean)
    return parts[parts.length - 1] ?? null
  }
}

function humanizeSlug(value: string) {
  return value
    .replace(/\.(git|md)$/i, '')
    .replace(/^\d+[-_]+/, '')
    .replace(/[-_]+/g, ' ')
    .replace(/\b\w/g, (char) => char.toUpperCase())
}

function builderForReview(review: ProjectReviewSummary, buildersByOwnerId: BuilderByOwner) {
  return buildersByOwnerId[review.owner.toLowerCase()] ?? null
}

function statusLabel(status: string) {
  return STATUS_LABELS[status] ?? status
}

function outcomeLabel(outcome: string | null) {
  return outcome ? OUTCOME_LABELS[outcome] ?? outcome : 'Pending'
}

function outcomeTone(outcome: string | null) {
  if (outcome === 'Proceed') return 'good'
  if (outcome === 'NeedsChanges') return 'warn'
  if (outcome === 'NotRecommended') return 'danger'
  return 'neutral'
}

function builderLabel(review: ProjectReviewSummary, buildersByOwnerId: BuilderByOwner) {
  return builderForReview(review, buildersByOwnerId)?.handle ?? shortAddress(review.owner)
}

function applicationLabel(agent: RegistryAgent | null, review: ProjectReviewSummary) {
  if (agent) return agent.handle.replace(/^@/, '')
  if (review.linkedProgramId) return shortAddress(review.linkedProgramId)
  return null
}

function eventTitle(event: VisibleReviewEvent) {
  if (event.kind === 'guidance') return `Cerberus guidance: ${outcomeLabel(event.outcome)}`
  return event.authorRole === 'Reviewer' ? 'Cerberus comment' : 'Builder reply'
}

function eventTone(event: VisibleReviewEvent) {
  if (event.kind === 'guidance') return outcomeTone(event.outcome)
  if (event.authorRole === 'Reviewer') return 'coach'
  return 'owner'
}

function buildMetrics(reviews: ProjectReviewSummary[]): Metric[] {
  return [
    { label: 'Reviews', value: reviews.length, tone: 'neutral' },
    { label: 'Awaiting Cerberus', value: reviews.filter((review) => !review.latestGuidanceOutcome).length, tone: 'info' },
    { label: 'Proceed', value: reviews.filter((review) => review.latestGuidanceOutcome === 'Proceed').length, tone: 'good' },
    { label: 'Needs changes', value: reviews.filter((review) => review.latestGuidanceOutcome === 'NeedsChanges').length, tone: 'warn' },
  ]
}

export function ProjectReviewDashboard({
  reviews,
  agentsByReviewId,
  buildersByOwnerId,
  initialDetail,
}: DashboardProps) {
  const [selectedId, setSelectedId] = useState(reviews[0]?.projectReviewId ?? '')
  const [detailsById, setDetailsById] = useState<Record<string, ProjectReviewDetail>>(
    initialDetail?.summary ? { [initialDetail.summary.projectReviewId]: initialDetail } : {},
  )
  const [query, setQuery] = useState('')
  const [descriptionOpen, setDescriptionOpen] = useState(false)
  const [loadingId, setLoadingId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const metrics = useMemo(() => buildMetrics(reviews), [reviews])
  const filteredReviews = useMemo(() => {
    const normalized = query.trim().toLowerCase()
    if (!normalized) return reviews

    return reviews.filter((review) => {
      const agent = agentsByReviewId[review.projectReviewId]
      return [
        review.projectReviewId,
        review.idea,
        review.status,
        review.latestGuidanceOutcome ?? '',
        review.owner,
        review.linkedProgramId ?? '',
        agent?.handle ?? '',
        agent?.displayName ?? '',
        builderForReview(review, buildersByOwnerId)?.handle ?? '',
        builderForReview(review, buildersByOwnerId)?.displayName ?? '',
        reviewTitle(review),
      ].some((value) => value.toLowerCase().includes(normalized))
    })
  }, [agentsByReviewId, buildersByOwnerId, query, reviews])

  const selectedReview = reviews.find((review) => review.projectReviewId === selectedId) ?? reviews[0] ?? null
  const selectedAgent = selectedReview ? agentsByReviewId[selectedReview.projectReviewId] ?? null : null
  const selectedDetail = selectedReview ? detailsById[selectedReview.projectReviewId] ?? null : null
  const selectedEvents = (selectedDetail?.events ?? []).filter(
    (event): event is VisibleReviewEvent => event.kind !== 'link',
  )

  useEffect(() => {
    setDescriptionOpen(false)
  }, [selectedId])

  useEffect(() => {
    if (!selectedReview || detailsById[selectedReview.projectReviewId]) return

    let active = true
    setLoadingId(selectedReview.projectReviewId)
    setError(null)
    void getProjectReviewDetail(selectedReview.projectReviewId)
      .then((detail) => {
        if (!active) return
        setDetailsById((current) => ({
          ...current,
          [selectedReview.projectReviewId]: detail,
        }))
      })
      .catch((err) => {
        if (!active) return
        setError(err instanceof Error ? err.message : String(err))
      })
      .finally(() => {
        if (active) setLoadingId(null)
      })

    return () => {
      active = false
    }
  }, [detailsById, selectedReview])

  if (reviews.length === 0) {
    return (
      <section className="reviews-dashboard-empty">
        <MessageSquare className="h-8 w-8" />
        <h1>No project reviews yet</h1>
        <p>Project reviews will appear here after builders coordinate with Cerberus in chat.</p>
        <Button asChild>
          <Link href="/chat">Open chat</Link>
        </Button>
      </section>
    )
  }

  return (
    <section className="reviews-dashboard">
      <div className="reviews-dashboard__header">
        <div>
          <div className="section__kicker">Cerberus reviews</div>
          <h1 className="section__title">Project review console</h1>
          <p className="section__sub">
            Project reviews with Cerberus guidance, builder context, and matching on-chain chat.
          </p>
        </div>
        <Button asChild>
          <Link href="/chat">
            <MessageSquare className="h-4 w-4" /> Open chat
          </Link>
        </Button>
      </div>

      <div className="reviews-dashboard__metrics">
        {metrics.map((metric) => (
          <div className="reviews-metric" data-tone={metric.tone} key={metric.label}>
            <span>{metric.label}</span>
            <strong>{metric.value}</strong>
          </div>
        ))}
      </div>

      <div className="reviews-console">
        <aside className="reviews-list-panel">
          <div className="reviews-search">
            <Search className="h-4 w-4" />
            <input
              aria-label="Search reviews"
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search title, agent, status, address"
              value={query}
            />
          </div>

          <div className="reviews-list">
            {filteredReviews.length === 0 ? (
              <div className="review-empty">No reviews match this search.</div>
            ) : (
              filteredReviews.map((review) => {
                const agent = agentsByReviewId[review.projectReviewId] ?? null
                const selected = review.projectReviewId === selectedReview?.projectReviewId

                return (
                  <button
                    className="reviews-list-item"
                    data-selected={selected ? 'true' : undefined}
                    key={review.projectReviewId}
                    onClick={() => setSelectedId(review.projectReviewId)}
                    type="button"
                  >
                    <span className="reviews-list-item__top">
                      <strong>{reviewTitle(review)}</strong>
                      <span className="reviews-status" data-status={review.status}>
                        {statusLabel(review.status)}
                      </span>
                    </span>
                    <span className="reviews-list-item__meta">
                      <span>{builderLabel(review, buildersByOwnerId)}</span>
                      <span>{formatTime(review.updatedAt)}</span>
                    </span>
                    <span className="reviews-list-item__summary">{reviewPreview(review)}</span>
                    <span className="reviews-list-item__bottom">
                      <span className="reviews-outcome" data-tone={outcomeTone(review.latestGuidanceOutcome)}>
                        {outcomeLabel(review.latestGuidanceOutcome)}
                      </span>
                      <span>#{review.projectReviewId}</span>
                    </span>
                  </button>
                )
              })
            )}
          </div>
        </aside>

        {selectedReview ? (
          <div className="reviews-detail">
            <div className="reviews-detail__topline">
              <div>
                <div className="review-panel__kicker">Selected review</div>
                <h2>{reviewTitle(selectedReview)}</h2>
              </div>
              <div className="reviews-detail__actions">
                <Button asChild size="sm" variant="outline">
                  <Link href="/chat">
                    Open chat <MessageSquare className="h-4 w-4" />
                  </Link>
                </Button>
              </div>
            </div>

            <div className="reviews-detail__grid">
              <section className="reviews-dossier">
                <div className="reviews-dossier__headline">
                  <span className="reviews-agent-chip">
                    <UserRound className="h-4 w-4" />
                    {builderLabel(selectedReview, buildersByOwnerId)}
                  </span>
                  {applicationLabel(selectedAgent, selectedReview) ? (
                    <span className="reviews-app-chip">
                      <ShieldCheck className="h-4 w-4" />
                      app: {applicationLabel(selectedAgent, selectedReview)}
                    </span>
                  ) : null}
                  <span className="reviews-status" data-status={selectedReview.status}>
                    {statusLabel(selectedReview.status)}
                  </span>
                  <span className="reviews-outcome" data-tone={outcomeTone(selectedReview.latestGuidanceOutcome)}>
                    {outcomeLabel(selectedReview.latestGuidanceOutcome)}
                  </span>
                </div>
                <button
                  className="reviews-description"
                  data-expanded={descriptionOpen ? 'true' : undefined}
                  onClick={() => setDescriptionOpen((value) => !value)}
                  type="button"
                >
                  <span>{descriptionOpen ? selectedReview.idea : reviewPreview(selectedReview)}</span>
                  <strong>
                    <WrapText className="h-3.5 w-3.5" />
                    {descriptionOpen ? 'Collapse description' : 'Full description'}
                  </strong>
                </button>
                <dl className="reviews-dossier__facts">
                  <div>
                    <dt>Review</dt>
                    <dd>#{selectedReview.projectReviewId}</dd>
                  </div>
                  <div>
                    <dt>Updated</dt>
                    <dd>{formatTime(selectedReview.updatedAt)}</dd>
                  </div>
                </dl>
                <div className="reviews-link-row">
                  <a href={selectedReview.githubUrl} rel="noreferrer" target="_blank">
                    <Github className="h-4 w-4" /> GitHub <ExternalLink className="h-3.5 w-3.5" />
                  </a>
                  <Link href="/chat">
                    <MessageSquare className="h-4 w-4" /> Open chat <ExternalLink className="h-3.5 w-3.5" />
                  </Link>
                </div>
              </section>

              <section className="reviews-thread-panel">
                <div className="reviews-thread-panel__header">
                  <div>
                    <div className="review-panel__kicker">Cerberus review</div>
                    <h3>Guidance notes</h3>
                  </div>
                  {loadingId === selectedReview.projectReviewId ? (
                    <span className="review-sync"><Clock3 className="h-4 w-4" /> loading</span>
                  ) : (
                    <span>{selectedEvents.length} notes</span>
                  )}
                </div>
                {error ? <div className="review-error">{error}</div> : null}
                {selectedEvents.length === 0 && loadingId !== selectedReview.projectReviewId ? (
                  <div className="review-empty">No indexed comments or guidance yet.</div>
                ) : (
                  <div className="reviews-thread">
                    {selectedEvents.map((event) => (
                      <article className="reviews-thread-event" data-tone={eventTone(event)} key={event.id}>
                        <div className="reviews-thread-event__icon">
                          {event.kind === 'guidance' ? <CheckCircle2 className="h-4 w-4" /> : <MessageSquare className="h-4 w-4" />}
                        </div>
                        <div className="reviews-thread-event__body">
                          <header>
                            <strong>{eventTitle(event)}</strong>
                            <time>{formatTime(event.at)}</time>
                          </header>
                          <p>{event.body}</p>
                          <footer>
                            <span title={event.author}>{shortAddress(event.author)}</span>
                          </footer>
                        </div>
                      </article>
                    ))}
                  </div>
                )}
              </section>
            </div>
          </div>
        ) : null}
      </div>
    </section>
  )
}
