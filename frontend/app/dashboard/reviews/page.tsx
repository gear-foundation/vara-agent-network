import Link from 'next/link'
import { Filter, MessageSquare, ShieldCheck } from 'lucide-react'
import { LiveTicker } from '@/components/live-ticker'
import { NavBar } from '@/components/nav-bar'
import { NetworkPulse } from '@/components/network-pulse'
import { PageAmbient } from '@/components/page-ambient'
import { JudgeAdminPanel } from '@/components/judge-admin-panel'
import { ReviewStatusBadge } from '@/components/review-status-badge'
import { SiteFooter } from '@/components/site-footer'
import { getReviewQueue, type RegistryAgent, type ReviewStatus } from '@/lib/indexer-client'

const FILTERS: Array<{ label: string, status: ReviewStatus[] }> = [
  { label: 'Requested feedback', status: ['Requested', 'Commented'] },
  { label: 'Awaiting decision', status: ['Submitted'] },
  { label: 'Rejected to revision', status: ['Rejected'] },
  { label: 'Accepted', status: ['Accepted'] },
]

function shortAddress(value: string) {
  return value.length <= 14 ? value : `${value.slice(0, 8)}...${value.slice(-4)}`
}

function QueueRow({ agent }: { agent: RegistryAgent }) {
  const revision = agent.reviewSummary?.displayRevision ?? 1

  return (
    <Link className="review-queue-row" href={`/applications/${agent.id}?revision=${revision}`}>
      <span className="review-queue-row__icon">
        <MessageSquare className="h-4 w-4" />
      </span>
      <span className="review-queue-row__main">
        <strong>{agent.displayName}</strong>
        <span>{agent.handle} · {agent.track} · {shortAddress(agent.id)}</span>
      </span>
      <ReviewStatusBadge summary={agent.reviewSummary} />
      <span className="review-queue-row__meta">
        {agent.reviewSummary?.totalVisibleCommentCount ?? 0} comments
      </span>
    </Link>
  )
}

export default async function ReviewQueuePage() {
  const queue = await getReviewQueue()

  return (
    <div className="min-h-screen bg-background">
      <PageAmbient />
      <NavBar />
      <div className="pt-[72px]">
        <NetworkPulse />
        <LiveTicker />
      </div>
      <main className="page">
        <section className="section">
          <div className="section__hdr">
            <div>
              <div className="section__kicker">Foundation review</div>
              <h1 className="section__title">Judge queue</h1>
              <p className="section__sub">
                Public review queue for requested feedback, submitted decisions, rejected revisions, and accepted live listings.
              </p>
            </div>
            <div className="review-queue-count">
              <ShieldCheck className="h-4 w-4" />
              {queue.length} v2 apps
            </div>
          </div>

          <div className="review-queue">
            <JudgeAdminPanel />
            {FILTERS.map((filter) => {
              const items = queue.filter((agent) => filter.status.includes(agent.reviewSummary?.status ?? 'Legacy'))
              return (
                <section className="review-queue-section" key={filter.label}>
                  <header>
                    <Filter className="h-4 w-4" />
                    <h2>{filter.label}</h2>
                    <span>{items.length}</span>
                  </header>
                  <div className="review-queue-section__rows">
                    {items.length === 0 ? (
                      <div className="review-empty">No apps need this action.</div>
                    ) : (
                      items.map((agent) => <QueueRow agent={agent} key={agent.id} />)
                    )}
                  </div>
                </section>
              )
            })}
          </div>
        </section>
      </main>
      <SiteFooter />
    </div>
  )
}
