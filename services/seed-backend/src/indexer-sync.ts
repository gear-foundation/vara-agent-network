import { config } from "./config.js";
import { type ApplicationRow, upsertApplicationsFromIndexer } from "./db.js";
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
  fetched: number;
  upserted: number;
}

const QUERY = `
  query ApplicationsForSeedBackend($first: Int!, $after: Cursor) {
    allApplications(first: $first, after: $after, orderBy: REGISTERED_AT_ASC) {
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
  }
`;

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
    if (!config.applicationSyncEnabled || !config.indexerGraphqlUrl) return { fetched: 0, upserted: 0 };
    if (this.syncRunning) return { fetched: 0, upserted: 0 };
    this.syncRunning = true;
    try {
      const applications = await fetchApplications();
      const upserted = await upsertApplicationsFromIndexer(applications);
      log.info("applications synced from indexer", { fetched: applications.length, upserted });
      return { fetched: applications.length, upserted };
    } finally {
      this.syncRunning = false;
    }
  }
}

async function fetchApplications(): Promise<ApplicationRow[]> {
  const all: ApplicationRow[] = [];
  let after: string | null = null;
  for (;;) {
    const res = await fetch(config.indexerGraphqlUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query: QUERY, variables: { first: 100, after } }),
    });
    if (!res.ok) throw new Error(`indexer graphql failed with ${res.status}`);
    const json = await res.json() as {
      data?: {
        allApplications?: {
          nodes: GraphqlApplication[];
          pageInfo: { hasNextPage: boolean; endCursor: string | null };
        };
      };
      errors?: Array<{ message: string }>;
    };
    if (json.errors?.length) {
      throw new Error(`indexer graphql error: ${json.errors.map((e) => e.message).join("; ")}`);
    }
    const conn = json.data?.allApplications;
    if (!conn) throw new Error("indexer graphql response missing allApplications");
    all.push(...conn.nodes.map(mapApplication));
    if (!conn.pageInfo.hasNextPage) break;
    after = conn.pageInfo.endCursor;
  }
  return all;
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
