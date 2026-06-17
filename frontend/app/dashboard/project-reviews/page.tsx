import Link from 'next/link'
import { Lightbulb, MessageSquare, Plus } from 'lucide-react'
import { LiveTicker } from '@/components/live-ticker'
import { NavBar } from '@/components/nav-bar'
import { NetworkPulse } from '@/components/network-pulse'
import { PageAmbient } from '@/components/page-ambient'
import { formatTime, shortAddress } from '@/components/review-ui-helpers'
import { SiteFooter } from '@/components/site-footer'
import { Button } from '@/components/ui/button'
import { getProjectReviewQueue, type ProjectReviewSummary } from '@/lib/indexer-client'

function ProjectReviewRow({ review }: { review: ProjectReviewSummary }) {
  return (
    <Link className="review-queue-row" href={`/project-reviews/${review.projectReviewId}`}>
      <span className="review-queue-row__icon">
        <Lightbulb className="h-4 w-4" />
      </span>
      <span className="review-queue-row__main">
        <strong>Project Review #{review.projectReviewId}</strong>
        <span>{review.status} · {shortAddress(review.owner)} · {formatTime(review.updatedAt)}</span>
      </span>
      <span className="review-queue-row__meta">
        {review.commentCount} comments
      </span>
    </Link>
  )
}

export default async function ProjectReviewQueuePage() {
  const queue = await getProjectReviewQueue()

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
              <div className="section__kicker">Pre-deploy review</div>
              <h1 className="section__title">Project Review queue</h1>
              <p className="section__sub">
                Public guidance queue for builders who have a GitHub repo and product idea before deployment.
              </p>
            </div>
            <Button asChild>
              <Link href="/project-reviews/new">
                <Plus className="h-4 w-4" /> Submit project
              </Link>
            </Button>
          </div>

          <div className="review-queue">
            <section className="review-queue-section">
              <header>
                <MessageSquare className="h-4 w-4" />
                <h2>Public project reviews</h2>
                <span>{queue.length}</span>
              </header>
              <div className="review-queue-section__rows">
                {queue.length === 0 ? (
                  <div className="review-empty">No project reviews yet.</div>
                ) : (
                  queue.map((review) => <ProjectReviewRow review={review} key={review.projectReviewId} />)
                )}
              </div>
            </section>
          </div>
        </section>
      </main>
      <SiteFooter />
    </div>
  )
}
