import { config } from "./config.js";
import {
  type ApplicationRow,
  type ParticipantRow,
  upsertApplicationsFromIndexer,
  upsertParticipantsFromIndexer,
} from "./db.js";
import { log } from "./logger.js";

interface GraphqlApplication {
  id: string;
  handle: string;
  owner: string;
  githubUrl: string;
  status: string;
  seasonId: number;
  registeredAt: string;
}

interface ApplicationSyncResult {
  applicationsFetched: number;
  applicationsUpserted: number;
  participantsFetched: number;
  participantsUpserted: number;
}

const QUERY = `
  query RegistryForSeedBackend($first: Int!, $applicationsAfter: Cursor, $participantsAfter: Cursor) {
    allApplications(first: $first, after: $applicationsAfter, orderBy: REGISTERED_AT_ASC) {
      nodes {
        id
        handle
        owner
        githubUrl
        status
        seasonId
        registeredAt
      }
      pageInfo {
        hasNextPage
        endCursor
      }
    }
    allParticipants(first: $first, after: $participantsAfter, orderBy: JOINED_AT_ASC) {
      nodes {
        id
        handle
        github
        joinedAt
        seasonId
      }
      pageInfo {
        hasNextPage
        endCursor
      }
    }
  }
`;

interface GraphqlParticipant {
  id: string;
  handle: string;
  github: string;
  joinedAt: string;
  seasonId: number;
}

export class IndexerApplicationSync {
  private running = false;
  private syncRunning = false;

  async start(): Promise<void> {
    if (!config.applicationSyncEnabled || !config.indexerGraphqlUrl || this.running) return;
    this.running = true;
    await this.sync().catch((error) => log.error("application sync failed", error));
    if (config.applicationSyncIntervalSec > 0) {
      setInterval(() => {
        this.sync().catch((error) => log.error("application sync failed", error));
      }, config.applicationSyncIntervalSec * 1000);
    }
  }

  async sync(): Promise<ApplicationSyncResult> {
    if (!config.applicationSyncEnabled || !config.indexerGraphqlUrl) {
      return { applicationsFetched: 0, applicationsUpserted: 0, participantsFetched: 0, participantsUpserted: 0 };
    }
    if (this.syncRunning) {
      return { applicationsFetched: 0, applicationsUpserted: 0, participantsFetched: 0, participantsUpserted: 0 };
    }
    this.syncRunning = true;
    try {
      const registry = await fetchRegistry();
      const applicationsUpserted = await upsertApplicationsFromIndexer(registry.applications);
      const participantsUpserted = await upsertParticipantsFromIndexer(registry.participants);
      const result = {
        applicationsFetched: registry.applications.length,
        applicationsUpserted,
        participantsFetched: registry.participants.length,
        participantsUpserted,
      };
      log.info("registry synced from indexer", result);
      return result;
    } finally {
      this.syncRunning = false;
    }
  }
}

async function fetchRegistry(): Promise<{ applications: ApplicationRow[]; participants: ParticipantRow[] }> {
  const applications: ApplicationRow[] = [];
  const participants: ParticipantRow[] = [];
  let applicationsAfter: string | null = null;
  let participantsAfter: string | null = null;
  for (;;) {
    const res = await fetch(config.indexerGraphqlUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query: QUERY, variables: { first: 100, applicationsAfter, participantsAfter } }),
    });
    if (!res.ok) throw new Error(`indexer graphql failed with ${res.status}`);
    const json = await res.json() as {
      data?: {
        allApplications?: {
          nodes: GraphqlApplication[];
          pageInfo: { hasNextPage: boolean; endCursor: string | null };
        };
        allParticipants?: {
          nodes: GraphqlParticipant[];
          pageInfo: { hasNextPage: boolean; endCursor: string | null };
        };
      };
      errors?: Array<{ message: string }>;
    };
    if (json.errors?.length) {
      throw new Error(`indexer graphql error: ${json.errors.map((e) => e.message).join("; ")}`);
    }
    const applicationConn = json.data?.allApplications;
    const participantConn = json.data?.allParticipants;
    if (!applicationConn || !participantConn) throw new Error("indexer graphql response missing registry data");
    applications.push(...applicationConn.nodes.map(mapApplication));
    participants.push(...participantConn.nodes.map(mapParticipant));
    if (!applicationConn.pageInfo.hasNextPage && !participantConn.pageInfo.hasNextPage) break;
    applicationsAfter = applicationConn.pageInfo.hasNextPage ? applicationConn.pageInfo.endCursor : applicationsAfter;
    participantsAfter = participantConn.pageInfo.hasNextPage ? participantConn.pageInfo.endCursor : participantsAfter;
  }
  return { applications, participants };
}

function mapApplication(app: GraphqlApplication): ApplicationRow {
  return {
    id: app.id.toLowerCase(),
    handle: app.handle,
    owner: app.owner.toLowerCase(),
    github_url: app.githubUrl,
    status: app.status,
    season_id: app.seasonId,
    registered_at: BigInt(app.registeredAt),
  };
}

function mapParticipant(participant: GraphqlParticipant): ParticipantRow {
  return {
    id: participant.id.toLowerCase(),
    handle: participant.handle,
    github: participant.github,
    joined_at: BigInt(participant.joinedAt),
    season_id: participant.seasonId,
  };
}
