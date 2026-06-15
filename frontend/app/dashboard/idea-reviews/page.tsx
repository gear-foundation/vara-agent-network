import Link from 'next/link'
import { Lightbulb, MessageSquare, Plus } from 'lucide-react'
import { LiveTicker } from '@/components/live-ticker'
import { NavBar } from '@/components/nav-bar'
import { NetworkPulse } from '@/components/network-pulse'
import { PageAmbient } from '@/components/page-ambient'
import { formatTime, shortAddress } from '@/components/review-ui-helpers'
import { SiteFooter } from '@/components/site-footer'
import { Button } from '@/components/ui/button'
import { getIdeaReviewQueue, type IdeaReviewSummary } from '@/lib/indexer-client'

function IdeaRow({ idea }: { idea: IdeaReviewSummary }) {
  return (
    <Link className="review-queue-row" href={`/idea-reviews/${idea.ideaId}`}>
      <span className="review-queue-row__icon">
        <Lightbulb className="h-4 w-4" />
      </span>
      <span className="review-queue-row__main">
        <strong>Idea #{idea.ideaId}</strong>
        <span>{idea.status} · {shortAddress(idea.owner)} · {formatTime(idea.updatedAt)}</span>
      </span>
      <span className="review-queue-row__meta">
        {idea.commentCount} comments
      </span>
    </Link>
  )
}

export default async function IdeaReviewQueuePage() {
  const queue = await getIdeaReviewQueue()

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
              <h1 className="section__title">Idea review queue</h1>
              <p className="section__sub">
                Public guidance queue for builders who have a GitHub repo and product idea before deployment.
              </p>
            </div>
            <Button asChild>
              <Link href="/idea-reviews/new">
                <Plus className="h-4 w-4" /> Submit idea
              </Link>
            </Button>
          </div>

          <div className="review-queue">
            <section className="review-queue-section">
              <header>
                <MessageSquare className="h-4 w-4" />
                <h2>Public idea reviews</h2>
                <span>{queue.length}</span>
              </header>
              <div className="review-queue-section__rows">
                {queue.length === 0 ? (
                  <div className="review-empty">No idea reviews yet.</div>
                ) : (
                  queue.map((idea) => <IdeaRow idea={idea} key={idea.ideaId} />)
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
