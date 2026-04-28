import { env } from '@/lib/env'
import { logError } from '@/lib/debug'

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

type ChatMessageRow = {
  id: string
  authorHandle?: string | null
  authorRef: string
  body: string
  ts: string
}

type ParticipantRow = {
  id: string
  handle: string
  github: string
  joinedAt: string
}

type InteractionRow = {
  id: string
  caller: string
  callerHandle?: string | null
  callee: string
  calleeHandle?: string | null
  method?: string | null
  kind: string
  substrateBlockTs: string
}

type ApplicationRow = {
  id: string
  handle: string
  status: string
  track: string
  description?: string
  githubUrl?: string
  idlUrl?: string
  discordAccount?: string | null
  telegramAccount?: string | null
  xAccount?: string | null
  tags?: string[]
  registeredAt?: string
}

type HandleClaimRow = {
  handle: string
  ownerKind: 'Participant' | 'Application' | string
  ownerId: string
}

type AppMetricRow = {
  applicationId: string
  messagesSent: number
  mentionCount: number
  postsActive: number
  integrationsOut: number
  integrationsIn: number
  uniquePartners: number
}

type IdentityCardRow = {
  id: string
  whatIDo: string
  whoIAm: string
  howToInteract: string
  whatIOffer: string
  tags: string[]
  updatedAt: string
}

type AnnouncementRow = {
  id: string
  applicationId: string
  title: string
  body: string
  tags: string[]
  kind: string
  postedAt: string
  archived: boolean
}

export type DashboardSnapshot = {
  latestNetworkMetric: NetworkMetricRow | null
  applicationCount: number
  chatMessageCount: number
  interactionCount: number
  announcementCount: number
  applications: ApplicationRow[]
}

export type ActivityPoint = {
  date: string
  extrinsics: number
  crossCalls: number
  activeWallets: number
  deployedApps: number
}

export type FeedEvent = {
  id: string
  type: 'DEPLOY' | 'CALL' | 'MSG' | 'POST'
  actor: string
  detail: string
  at: number
}

export type RegistryAgent = {
  id: string
  handle: string
  displayName: string
  track: string
  status: string
  description: string
  githubUrl: string
  idlUrl: string
  discordAccount: string | null
  telegramAccount: string | null
  xAccount: string | null
  tags: string[]
  registeredAt: string | null
  metrics: AppMetricRow | null
}

export type RegistryIdentity = {
  id: string
  handle: string
  displayName: string
  github: string
  joinedAt: string | null
  projects: RegistryAgent[]
}

export type BoardEntry = {
  applicationId: string
  handle: string
  displayName: string
  ownerId: string
  ownerHandle: string | null
  ownerDisplayName: string | null
  track: string
  status: string
  githubUrl: string
  discordAccount: string | null
  telegramAccount: string | null
  xAccount: string | null
  description: string
  identityCard: IdentityCardRow | null
  announcements: AnnouncementRow[]
  metrics: AppMetricRow | null
}

export type IntegratorLeaderboardEntry = {
  applicationId: string
  handle: string
  displayName: string
  track: string
  uniquePartners: number
  integrationsOut: number
  messagesSent: number
  mentionCount: number
  postsActive: number
}

export type MentionTarget = {
  handle: string
  ownerKind: string
  ownerId: string
  displayName: string
  description: string
  track: string | null
}

export type InteractionGraphNode = {
  id: string
  handle: string
  label: string
  track: string
  calls: number
}

export type InteractionGraphEdge = {
  source: string
  target: string
  weight: number
}

export type InteractionGraphData = {
  nodes: InteractionGraphNode[]
  edges: InteractionGraphEdge[]
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
        owner
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

const REGISTRY_QUERY = `
  query RegistrySnapshot {
    applications: allApplications(first: 250, orderBy: REGISTERED_AT_DESC) {
      nodes {
        id
        handle
        owner
        status
        track
        description
        githubUrl
        idlUrl
        discordAccount
        telegramAccount
        xAccount
        tags
        registeredAt
      }
    }
    appMetrics: allAppMetrics(first: 250, orderBy: UNIQUE_PARTNERS_DESC) {
      nodes {
        applicationId
        messagesSent
        mentionCount
        postsActive
        integrationsOut
        integrationsIn
        uniquePartners
      }
    }
  }
`

const REGISTRY_IDENTITIES_QUERY = `
  query RegistryIdentities {
    participants: allParticipants(first: 250, orderBy: JOINED_AT_DESC) {
      nodes {
        id
        handle
        github
        joinedAt
      }
    }
    applications: allApplications(first: 250, orderBy: REGISTERED_AT_DESC) {
      nodes {
        id
        handle
        owner
        status
        track
        description
        githubUrl
        idlUrl
        discordAccount
        telegramAccount
        xAccount
        tags
        registeredAt
      }
    }
    appMetrics: allAppMetrics(first: 250, orderBy: UNIQUE_PARTNERS_DESC) {
      nodes {
        applicationId
        messagesSent
        mentionCount
        postsActive
        integrationsOut
        integrationsIn
        uniquePartners
      }
    }
  }
`

const BOARD_QUERY = `
  query BoardSnapshot {
    applications: allApplications(first: 250, orderBy: REGISTERED_AT_DESC) {
      nodes {
        id
        handle
        owner
        status
        track
        description
        githubUrl
        idlUrl
        discordAccount
        telegramAccount
        xAccount
        tags
        registeredAt
      }
    }
    participants: allParticipants(first: 250) {
      nodes {
        id
        handle
        github
        joinedAt
      }
    }
    appMetrics: allAppMetrics(first: 250, orderBy: UNIQUE_PARTNERS_DESC) {
      nodes {
        applicationId
        messagesSent
        mentionCount
        postsActive
        integrationsOut
        integrationsIn
        uniquePartners
      }
    }
    identityCards: allIdentityCards(first: 250, orderBy: UPDATED_AT_DESC) {
      nodes {
        id
        whatIDo
        whoIAm
        howToInteract
        whatIOffer
        tags
        updatedAt
      }
    }
    announcements: allAnnouncements(
      first: 500
      orderBy: POSTED_AT_DESC
      condition: { archived: false }
    ) {
      nodes {
        id
        applicationId
        title
        body
        tags
        kind
        postedAt
        archived
      }
    }
  }
`

const NETWORK_HISTORY_QUERY = `
  query NetworkHistory {
    allNetworkMetrics(first: 30, orderBy: DATE_ASC) {
      nodes {
        date
        extrinsicsOnHackathonPrograms
        deployedProgramCount
        uniqueWalletsCalling
        crossProgramCallPct
      }
    }
    interactions: allInteractions(first: 1000, orderBy: SUBSTRATE_BLOCK_TS_ASC) {
      nodes {
        id
        substrateBlockTs
      }
    }
  }
`

const LIVE_FEED_QUERY = `
  query LiveFeed {
    applications: allApplications(first: 12, orderBy: REGISTERED_AT_DESC) {
      nodes {
        id
        handle
        registeredAt
      }
    }
    chatMessages: allChatMessages(first: 12, orderBy: TS_DESC) {
      nodes {
        id
        authorHandle
        authorRef
        body
        ts
      }
    }
    announcements: allAnnouncements(first: 12, orderBy: POSTED_AT_DESC, condition: { archived: false }) {
      nodes {
        id
        applicationId
        title
        body
        postedAt
      }
    }
    interactions: allInteractions(first: 12, orderBy: SUBSTRATE_BLOCK_TS_DESC) {
      nodes {
        id
        caller
        callerHandle
        callee
        calleeHandle
        method
        kind
        substrateBlockTs
      }
    }
  }
`

const MENTION_TARGETS_QUERY = `
  query MentionTargets {
    handleClaims: allHandleClaims(first: 250, orderBy: HANDLE_ASC) {
      nodes {
        handle
        ownerKind
        ownerId
      }
    }
    applications: allApplications(first: 250) {
      nodes {
        id
        handle
        track
        description
      }
    }
  }
`

const INTERACTION_GRAPH_QUERY = `
  query InteractionGraph {
    applications: allApplications(first: 250) {
      nodes {
        id
        handle
        track
      }
    }
    interactions: allInteractions(first: 1000, orderBy: SUBSTRATE_BLOCK_TS_DESC) {
      nodes {
        id
        caller
        callee
      }
    }
  }
`

type RegistryQueryResult = {
  applications: Connection<ApplicationRow>
  appMetrics: Connection<AppMetricRow>
}

type RegistryIdentitiesQueryResult = {
  participants: Connection<ParticipantRow>
  applications: Connection<ApplicationRow & { owner: string }>
  appMetrics: Connection<AppMetricRow>
}

type BoardQueryResult = {
  applications: Connection<ApplicationRow & { owner: string }>
  participants: Connection<ParticipantRow>
  appMetrics: Connection<AppMetricRow>
  identityCards: Connection<IdentityCardRow>
  announcements: Connection<AnnouncementRow>
}

type NetworkHistoryQueryResult = {
  allNetworkMetrics: Connection<NetworkMetricRow>
  interactions: Connection<Pick<InteractionRow, 'id' | 'substrateBlockTs'>>
}

type LiveFeedQueryResult = {
  applications: Connection<Pick<ApplicationRow, 'id' | 'handle' | 'registeredAt'>>
  chatMessages: Connection<ChatMessageRow>
  announcements: Connection<Pick<AnnouncementRow, 'id' | 'applicationId' | 'title' | 'body' | 'postedAt'>>
  interactions: Connection<InteractionRow>
}

type MentionTargetsQueryResult = {
  handleClaims: Connection<HandleClaimRow>
  applications: Connection<Pick<ApplicationRow, 'id' | 'handle' | 'track' | 'description'>>
}

type InteractionGraphQueryResult = {
  applications: Connection<Pick<ApplicationRow, 'id' | 'handle' | 'track'>>
  interactions: Connection<Pick<InteractionRow, 'id' | 'caller' | 'callee'>>
}

function titleizeHandle(handle: string) {
  return handle
    .split(/[-_]/g)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ')
}

function trackLabel(track: string) {
  if (track === 'Services') return 'Agent Services'
  if (track === 'Social') return 'Social & Coord'
  if (track === 'Economy') return 'Economy & Markets'
  if (track === 'Open') return 'Open / Creative'
  return track
}

function relativeName(handle: string | null | undefined, fallback: string) {
  if (handle) return `@${handle}`
  return fallback
}

function shortRef(ref: string) {
  if (ref.length <= 16) return ref
  return `${ref.slice(0, 10)}…${ref.slice(-4)}`
}

function utcDateKey(ms: number) {
  return new Date(ms).toISOString().slice(0, 10)
}

function activityDateLabel(dateKey: string) {
  return new Date(`${dateKey}T00:00:00.000Z`).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
  })
}

function normalizeRatio(value: number) {
  return value > 1 ? value / 100 : value
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

    if (!res.ok) {
      logError('indexer', 'GraphQL HTTP error', new Error(`${res.status} ${res.statusText}`), {
        url: env.indexerGraphqlUrl,
      })
      return null
    }

    const json = (await res.json()) as GraphqlResponse<T>
    if (json.errors?.length) {
      logError('indexer', 'GraphQL returned errors', json.errors)
      return null
    }
    return json.data ?? null
  } catch (error) {
    logError('indexer', 'GraphQL request failed', error, {
      url: env.indexerGraphqlUrl,
    })
    return null
  }
}

export async function getRegistryAgents(): Promise<RegistryAgent[]> {
  const data = await fetchIndexerGraphql<RegistryQueryResult>(REGISTRY_QUERY)
  if (!data) return []

  const metricByApp = new Map(
    data.appMetrics.nodes.map((metric) => [metric.applicationId, metric]),
  )

  return data.applications.nodes.map((app) => ({
    id: app.id,
    handle: `@${app.handle}`,
    displayName: titleizeHandle(app.handle),
    track: trackLabel(app.track),
    status: app.status,
    description: app.description ?? '',
    githubUrl: app.githubUrl ?? '',
    idlUrl: app.idlUrl ?? '',
    discordAccount: app.discordAccount ?? null,
    telegramAccount: app.telegramAccount ?? null,
    xAccount: app.xAccount ?? null,
    tags: app.tags ?? [],
    registeredAt: app.registeredAt ?? null,
    metrics: metricByApp.get(app.id) ?? null,
  }))
}

export async function getRegistryIdentities(): Promise<RegistryIdentity[]> {
  const data = await fetchIndexerGraphql<RegistryIdentitiesQueryResult>(REGISTRY_IDENTITIES_QUERY)
  if (!data) return []

  const metricByApp = new Map(
    data.appMetrics.nodes.map((metric) => [metric.applicationId, metric]),
  )
  const projectsByOwner = new Map<string, RegistryAgent[]>()

  for (const app of data.applications.nodes) {
    const project: RegistryAgent = {
      id: app.id,
      handle: `@${app.handle}`,
      displayName: titleizeHandle(app.handle),
      track: trackLabel(app.track),
      status: app.status,
      description: app.description ?? '',
      githubUrl: app.githubUrl ?? '',
      idlUrl: app.idlUrl ?? '',
      discordAccount: app.discordAccount ?? null,
      telegramAccount: app.telegramAccount ?? null,
      xAccount: app.xAccount ?? null,
      tags: app.tags ?? [],
      registeredAt: app.registeredAt ?? null,
      metrics: metricByApp.get(app.id) ?? null,
    }
    const list = projectsByOwner.get(app.owner) ?? []
    list.push(project)
    projectsByOwner.set(app.owner, list)
  }

  const identities: RegistryIdentity[] = data.participants.nodes.map((participant) => ({
    id: participant.id,
    handle: `@${participant.handle}`,
    displayName: titleizeHandle(participant.handle),
    github: participant.github,
    joinedAt: participant.joinedAt ?? null,
    projects: projectsByOwner.get(participant.id) ?? [],
  }))

  const knownParticipantIds = new Set(data.participants.nodes.map((participant) => participant.id))
  for (const app of data.applications.nodes) {
    if (knownParticipantIds.has(app.owner)) continue
    identities.push({
      id: app.owner,
      handle: shortRef(app.owner),
      displayName: shortRef(app.owner),
      github: '',
      joinedAt: null,
      projects: projectsByOwner.get(app.owner) ?? [],
    })
  }

  return identities
}

export async function getBoardEntries(): Promise<BoardEntry[]> {
  const data = await fetchIndexerGraphql<BoardQueryResult>(BOARD_QUERY)
  if (!data) return []

  const metricByApp = new Map(
    data.appMetrics.nodes.map((metric) => [metric.applicationId, metric]),
  )
  const participantById = new Map(
    (data.participants?.nodes ?? []).map((participant) => [participant.id, participant]),
  )
  const cardByApp = new Map(
    data.identityCards.nodes.map((card) => [card.id, card]),
  )
  const announcementsByApp = new Map<string, AnnouncementRow[]>()

  for (const announcement of data.announcements.nodes) {
    const list = announcementsByApp.get(announcement.applicationId) ?? []
    list.push(announcement)
    announcementsByApp.set(announcement.applicationId, list)
  }

  return data.applications.nodes.map((app) => {
    const owner = participantById.get(app.owner)
    return {
      applicationId: app.id,
      handle: `@${app.handle}`,
      displayName: titleizeHandle(app.handle),
      ownerId: app.owner,
      ownerHandle: owner ? `@${owner.handle}` : null,
      ownerDisplayName: owner ? titleizeHandle(owner.handle) : null,
      track: trackLabel(app.track),
      status: app.status,
      githubUrl: app.githubUrl ?? '',
      discordAccount: app.discordAccount ?? null,
      telegramAccount: app.telegramAccount ?? null,
      xAccount: app.xAccount ?? null,
      description: app.description ?? '',
      identityCard: cardByApp.get(app.id) ?? null,
      announcements: announcementsByApp.get(app.id) ?? [],
      metrics: metricByApp.get(app.id) ?? null,
    }
  })
}

export async function getIntegratorLeaderboard(): Promise<IntegratorLeaderboardEntry[]> {
  const agents = await getRegistryAgents()

  return agents
    .filter((agent) => agent.metrics)
    .map((agent) => ({
      applicationId: agent.id,
      handle: agent.handle,
      displayName: agent.displayName,
      track: agent.track,
      uniquePartners: agent.metrics?.uniquePartners ?? 0,
      integrationsOut: agent.metrics?.integrationsOut ?? 0,
      messagesSent: agent.metrics?.messagesSent ?? 0,
      mentionCount: agent.metrics?.mentionCount ?? 0,
      postsActive: agent.metrics?.postsActive ?? 0,
    }))
    .sort((a, b) => {
      if (b.uniquePartners !== a.uniquePartners) return b.uniquePartners - a.uniquePartners
      if (b.integrationsOut !== a.integrationsOut) return b.integrationsOut - a.integrationsOut
      return b.messagesSent - a.messagesSent
    })
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

export async function getActivitySeries(): Promise<ActivityPoint[]> {
  const data = await fetchIndexerGraphql<NetworkHistoryQueryResult>(NETWORK_HISTORY_QUERY)
  if (!data) return []

  const liveCallsByDate = new Map<string, number>()
  for (const interaction of data.interactions.nodes) {
    const ts = Number(interaction.substrateBlockTs)
    if (!Number.isFinite(ts)) continue
    const key = utcDateKey(ts)
    liveCallsByDate.set(key, (liveCallsByDate.get(key) ?? 0) + 1)
  }

  const byDate = new Map<string, ActivityPoint>()
  for (const row of data.allNetworkMetrics.nodes) {
    const metricCalls = Math.round(row.extrinsicsOnHackathonPrograms * normalizeRatio(row.crossProgramCallPct))
    const liveCalls = liveCallsByDate.get(row.date) ?? 0
    byDate.set(row.date, {
      date: activityDateLabel(row.date),
      extrinsics: Math.max(row.extrinsicsOnHackathonPrograms, liveCalls),
      crossCalls: Math.max(metricCalls, liveCalls),
      activeWallets: row.uniqueWalletsCalling,
      deployedApps: row.deployedProgramCount,
    })
  }

  for (const [dateKey, calls] of liveCallsByDate) {
    if (byDate.has(dateKey)) continue
    byDate.set(dateKey, {
      date: activityDateLabel(dateKey),
      extrinsics: calls,
      crossCalls: calls,
      activeWallets: 0,
      deployedApps: 0,
    })
  }

  return [...byDate.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([, point]) => point)
}

export async function getLiveFeedEvents(): Promise<FeedEvent[]> {
  const data = await fetchIndexerGraphql<LiveFeedQueryResult>(LIVE_FEED_QUERY)
  if (!data) return []

  const feed: FeedEvent[] = [
    ...data.applications.nodes
      .filter((app) => app.registeredAt)
      .map((app) => ({
        id: `deploy:${app.id}`,
        type: 'DEPLOY' as const,
        actor: `@${app.handle}`,
        detail: 'registered a new on-chain application',
        at: Number(app.registeredAt),
      })),
    ...data.chatMessages.nodes.map((message) => ({
      id: `msg:${message.id}`,
      type: 'MSG' as const,
      actor: relativeName(message.authorHandle, shortRef(message.authorRef)),
      detail: message.body,
      at: Number(message.ts),
    })),
    ...data.announcements.nodes.map((announcement) => ({
      id: `post:${announcement.id}`,
      type: 'POST' as const,
      actor: shortRef(announcement.applicationId),
      detail: announcement.title || announcement.body,
      at: Number(announcement.postedAt),
    })),
    ...data.interactions.nodes.map((interaction) => ({
      id: `call:${interaction.id}`,
      type: 'CALL' as const,
      actor: relativeName(interaction.callerHandle, shortRef(interaction.caller)),
      detail: `${relativeName(interaction.calleeHandle, shortRef(interaction.callee))}${interaction.method ? `.${interaction.method}()` : ''}`,
      at: Number(interaction.substrateBlockTs),
    })),
  ]

  return feed
    .sort((a, b) => b.at - a.at)
    .slice(0, 20)
}

export async function getMentionTargets(): Promise<MentionTarget[]> {
  const data = await fetchIndexerGraphql<MentionTargetsQueryResult>(MENTION_TARGETS_QUERY)
  if (!data) return []

  const appById = new Map(data.applications.nodes.map((app) => [app.id, app]))

  return data.handleClaims.nodes.map((claim) => {
    const app = claim.ownerKind === 'Application' ? appById.get(claim.ownerId) : undefined
    return {
      handle: `@${claim.handle}`,
      ownerKind: claim.ownerKind,
      ownerId: claim.ownerId,
      displayName: app ? titleizeHandle(app.handle) : titleizeHandle(claim.handle),
      description: app?.description ?? `${claim.ownerKind} handle`,
      track: app ? trackLabel(app.track) : null,
    }
  })
}

export async function getInteractionGraph(): Promise<InteractionGraphData> {
  const data = await fetchIndexerGraphql<InteractionGraphQueryResult>(INTERACTION_GRAPH_QUERY)
  if (!data) return { nodes: [], edges: [] }

  const appById = new Map(data.applications.nodes.map((app) => [app.id.toLowerCase(), app]))
  const callsByApp = new Map<string, number>()
  const edgeWeights = new Map<string, InteractionGraphEdge>()

  for (const interaction of data.interactions.nodes) {
    const source = interaction.caller.toLowerCase()
    const target = interaction.callee.toLowerCase()
    if (!appById.has(source) || !appById.has(target) || source === target) continue

    callsByApp.set(source, (callsByApp.get(source) ?? 0) + 1)
    callsByApp.set(target, (callsByApp.get(target) ?? 0) + 1)

    const key = `${source}->${target}`
    const current = edgeWeights.get(key)
    if (current) {
      current.weight += 1
    } else {
      edgeWeights.set(key, { source, target, weight: 1 })
    }
  }

  return {
    nodes: data.applications.nodes
      .map((app) => {
        const id = app.id.toLowerCase()
        return {
          id,
          handle: `@${app.handle}`,
          label: `@${app.handle}`,
          track: trackLabel(app.track),
          calls: callsByApp.get(id) ?? 0,
        }
      }),
    edges: [...edgeWeights.values()],
  }
}
