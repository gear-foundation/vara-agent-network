import pg from "pg";
import { config } from "./config.js";

export const pool = new pg.Pool({
  connectionString: config.databaseUrl,
  max: 10,
});

export interface ApplicationRow {
  id: string;
  handle: string;
  owner: string;
  github_url: string;
  status: string;
  season_id: number;
}

export interface AllocationRow {
  id: number;
  wallet: string;
  application_id: string;
  github_url: string;
  state: "active" | "paused" | "blacklisted";
  total_funded_raw: string;
  daily_funded_raw: string;
  daily_window: string;
  last_funded_at: Date | null;
  suspicious_count: number;
  risk_score: number;
  last_reason: string | null;
  github_checked_at: Date | null;
  github_ok: boolean;
  created_at: Date;
  updated_at: Date;
}

export interface FundingDecision {
  status: "funded" | "skipped" | "paused" | "blacklisted";
  applicationId: string;
  wallet: string;
  amountRaw: string;
  reason: string;
  txHash?: string;
}

export async function ensureSchema(): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS seed_allocations (
      id bigserial PRIMARY KEY,
      wallet text NOT NULL,
      application_id text NOT NULL,
      github_url text NOT NULL,
      state text NOT NULL DEFAULT 'active',
      total_funded_raw numeric(78,0) NOT NULL DEFAULT 0,
      daily_funded_raw numeric(78,0) NOT NULL DEFAULT 0,
      daily_window date NOT NULL DEFAULT CURRENT_DATE,
      last_funded_at timestamptz,
      suspicious_count int NOT NULL DEFAULT 0,
      risk_score int NOT NULL DEFAULT 0,
      last_reason text,
      github_checked_at timestamptz,
      github_ok boolean NOT NULL DEFAULT false,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (wallet, application_id)
    );

    CREATE INDEX IF NOT EXISTS seed_allocations_wallet_idx ON seed_allocations(wallet);
    CREATE INDEX IF NOT EXISTS seed_allocations_state_idx ON seed_allocations(state);

    CREATE TABLE IF NOT EXISTS seed_funding_events (
      id bigserial PRIMARY KEY,
      wallet text NOT NULL,
      application_id text NOT NULL,
      amount_raw numeric(78,0) NOT NULL,
      tx_hash text,
      reason text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS seed_spend_events (
      id text PRIMARY KEY,
      wallet text NOT NULL,
      recipient text NOT NULL,
      amount_raw numeric(78,0) NOT NULL,
      kind text NOT NULL,
      allowed boolean NOT NULL,
      substrate_block_number int NOT NULL,
      substrate_block_ts timestamptz NOT NULL,
      extrinsic_idx int,
      event_idx int,
      created_at timestamptz NOT NULL DEFAULT now()
    );

    CREATE INDEX IF NOT EXISTS seed_spend_events_wallet_idx ON seed_spend_events(wallet);
    CREATE INDEX IF NOT EXISTS seed_spend_events_allowed_idx ON seed_spend_events(allowed);

    CREATE TABLE IF NOT EXISTS seed_monitor_cursor (
      id text PRIMARY KEY,
      last_processed_block int NOT NULL,
      updated_at timestamptz NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS seed_audit_events (
      id bigserial PRIMARY KEY,
      wallet text,
      application_id text,
      level text NOT NULL,
      message text NOT NULL,
      metadata jsonb NOT NULL DEFAULT '{}',
      created_at timestamptz NOT NULL DEFAULT now()
    );
  `);
}

export async function getEligibleApplication(applicationId: string): Promise<ApplicationRow | null> {
  const rows = await pool.query<ApplicationRow>(
    `
      SELECT id, handle, owner, github_url, status, season_id
      FROM applications
      WHERE lower(id) = lower($1)
        AND status = ANY($2::text[])
      LIMIT 1
    `,
    [applicationId, config.eligibleStatuses],
  );
  return rows.rows[0] ?? null;
}

export async function listEligibleApplications(limit = 100): Promise<ApplicationRow[]> {
  const rows = await pool.query<ApplicationRow>(
    `
      SELECT id, handle, owner, github_url, status, season_id
      FROM applications
      WHERE status = ANY($1::text[])
      ORDER BY registered_at ASC
      LIMIT $2
    `,
    [config.eligibleStatuses, limit],
  );
  return rows.rows;
}

export async function listAllowedRecipients(): Promise<Set<string>> {
  const rows = await pool.query<{ id: string }>(
    `SELECT lower(id) AS id FROM applications WHERE status = ANY($1::text[])`,
    [config.eligibleStatuses],
  );
  return new Set(rows.rows.map((r) => r.id));
}

export async function upsertAllocation(
  app: ApplicationRow,
  githubOk: boolean,
): Promise<AllocationRow> {
  const rows = await pool.query<AllocationRow>(
    `
      INSERT INTO seed_allocations (wallet, application_id, github_url, github_ok, github_checked_at)
      VALUES (lower($1), lower($2), $3, $4, now())
      ON CONFLICT (wallet, application_id) DO UPDATE SET
        github_url = EXCLUDED.github_url,
        github_ok = EXCLUDED.github_ok,
        github_checked_at = EXCLUDED.github_checked_at,
        updated_at = now()
      RETURNING *
    `,
    [app.owner, app.id, app.github_url, githubOk],
  );
  return rows.rows[0];
}

export async function getAllocationForUpdate(
  client: pg.PoolClient,
  wallet: string,
  applicationId: string,
): Promise<AllocationRow | null> {
  const rows = await client.query<AllocationRow>(
    `
      SELECT *
      FROM seed_allocations
      WHERE wallet = lower($1) AND application_id = lower($2)
      FOR UPDATE
    `,
    [wallet, applicationId],
  );
  return rows.rows[0] ?? null;
}

export async function listAllocations(wallet?: string): Promise<AllocationRow[]> {
  const rows = await pool.query<AllocationRow>(
    `
      SELECT *
      FROM seed_allocations
      WHERE ($1::text IS NULL OR wallet = lower($1))
      ORDER BY updated_at DESC
      LIMIT 500
    `,
    [wallet ?? null],
  );
  return rows.rows;
}

export async function recordAudit(
  level: "info" | "warn" | "error",
  message: string,
  metadata: Record<string, unknown> = {},
  wallet?: string,
  applicationId?: string,
): Promise<void> {
  await pool.query(
    `
      INSERT INTO seed_audit_events (wallet, application_id, level, message, metadata)
      VALUES ($1, $2, $3, $4, $5::jsonb)
    `,
    [wallet ?? null, applicationId ?? null, level, message, JSON.stringify(metadata)],
  );
}
