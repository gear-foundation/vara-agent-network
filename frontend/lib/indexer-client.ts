import { env } from '@/lib/env'

type GraphqlResponse<T> = {
  data?: T
  errors?: Array<{ message?: string }>
}

type Connection<T> = {
  totalCount: number
  nodes: T[]
}

type NetworkMetricRow = {
  date: string
  extrinsicsOnHackathonPrograms: number
  deployedProgramCount: number
  uniqueWalletsCalling: number
  crossProgramCallPct: number
}

type ApplicationRow = {
  id: string
  handle: string
  status: string
  track: string
}

export type DashboardSnapshot = {
  latestNetworkMetric: NetworkMetricRow | null
  applicationCount: number
  chatMessageCount: number
  interactionCount: number
  announcementCount: number
  applications: ApplicationRow[]
}

const DASHBOARD_QUERY = `
  query DashboardSnapshot {
    latestNetworkMetrics: allNetworkMetrics(first: 1, orderBy: DATE_DESC) {
      nodes {
        date
        extrinsicsOnHackathonPrograms
        deployedProgramCount
        uniqueWalletsCalling
        crossProgramCallPct
      }
    }
    applications: allApplications(first: 100) {
      totalCount
      nodes {
        id
        handle
        status
        track
      }
    }
    chatMessages: allChatMessages {
      totalCount
    }
    interactions: allInteractions {
      totalCount
    }
    announcements: allAnnouncements {
      totalCount
    }
  }
`

type DashboardQueryResult = {
  latestNetworkMetrics: { nodes: NetworkMetricRow[] }
  applications: Connection<ApplicationRow>
  chatMessages: { totalCount: number }
  interactions: { totalCount: number }
  announcements: { totalCount: number }
}

export async function fetchIndexerGraphql<T>(
  query: string,
  variables?: Record<string, unknown>,
): Promise<T | null> {
  if (!env.indexerGraphqlUrl) return null

  try {
    const res = await fetch(env.indexerGraphqlUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({ query, variables }),
      cache: 'no-store',
    })

    if (!res.ok) return null

    const json = (await res.json()) as GraphqlResponse<T>
    if (json.errors?.length) return null
    return json.data ?? null
  } catch {
    return null
  }
}

export async function getDashboardSnapshot(): Promise<DashboardSnapshot | null> {
  const data = await fetchIndexerGraphql<DashboardQueryResult>(DASHBOARD_QUERY)
  if (!data) return null

  return {
    latestNetworkMetric: data.latestNetworkMetrics.nodes[0] ?? null,
    applicationCount: data.applications.totalCount,
    chatMessageCount: data.chatMessages.totalCount,
    interactionCount: data.interactions.totalCount,
    announcementCount: data.announcements.totalCount,
    applications: data.applications.nodes,
  }
}
