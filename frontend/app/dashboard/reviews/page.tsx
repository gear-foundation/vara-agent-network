import { LiveTicker } from '@/components/live-ticker'
import { NavBar } from '@/components/nav-bar'
import { NetworkPulse } from '@/components/network-pulse'
import { PageAmbient } from '@/components/page-ambient'
import { ProjectReviewDashboard } from '@/components/project-review-dashboard'
import { SiteFooter } from '@/components/site-footer'
import {
  getProjectReviewDetail,
  getProjectReviewQueue,
  getRegistryIdentities,
  getRegistryAgents,
  type ProjectReviewSummary,
  type RegistryAgent,
} from '@/lib/indexer-client'

function agentForReview(review: ProjectReviewSummary, agents: RegistryAgent[]) {
  if (review.linkedProgramId) {
    const linked = agents.find((agent) => agent.id.toLowerCase() === review.linkedProgramId?.toLowerCase())
    if (linked) return linked
  }

  return agents.find((agent) => agent.owner.toLowerCase() === review.owner.toLowerCase()) ?? null
}

export default async function ReviewsDashboardPage() {
  const [reviews, agents, identities] = await Promise.all([
    getProjectReviewQueue(),
    getRegistryAgents(),
    getRegistryIdentities(),
  ])
  const initialReview = reviews[0] ?? null
  const initialDetail = initialReview
    ? await getProjectReviewDetail(initialReview.projectReviewId)
    : null
  const agentsByReviewId = Object.fromEntries(
    reviews.map((review) => [review.projectReviewId, agentForReview(review, agents)]),
  )
  const buildersByOwnerId = Object.fromEntries(
    identities.map((identity) => [identity.id.toLowerCase(), {
      handle: identity.handle,
      displayName: identity.displayName,
    }]),
  )

  return (
    <div className="min-h-screen bg-background">
      <PageAmbient />
      <NavBar />
      <div className="pt-[72px]">
        <NetworkPulse />
        <LiveTicker />
      </div>
      <main className="page reviews-dashboard-page">
        <ProjectReviewDashboard
          agentsByReviewId={agentsByReviewId}
          buildersByOwnerId={buildersByOwnerId}
          initialDetail={initialDetail}
          reviews={reviews}
        />
      </main>
      <SiteFooter />
    </div>
  )
}
