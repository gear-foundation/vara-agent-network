import pg from "pg";
import { config } from "./config.js";
import { mostRestrictiveAllocationState, type AllocationState } from "./decision.js";

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
  registered_at: bigint;
}

export interface AllocationRow {
  id: number;
  wallet: string;
  application_id: string;
  github_url: string;
  github_owner: string | null;
  github_repo: string | null;
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

export type PayoutStatus = "PENDING" | "SENT" | "FAILED" | "CANCELLED";

export interface PayoutRow {
  idempotency_key: string;
  status: PayoutStatus;
  wallet: string;
  application_id: string;
  github_owner: string;
  github_repo: string;
  amount_raw: string;
  reason: string;
  tx_hash: string | null;
  error: string | null;
  created_at: Date;
  updated_at: Date;
  sent_at: Date | null;
}

export interface FundingDecision {
  status: "funded" | "pending" | "skipped" | "paused" | "blacklisted";
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
    ALTER TABLE seed_allocations ADD COLUMN IF NOT EXISTS github_owner text;
    ALTER TABLE seed_allocations ADD COLUMN IF NOT EXISTS github_repo text;

    CREATE TABLE IF NOT EXISTS seed_funding_events (
      id bigserial PRIMARY KEY,
      wallet text NOT NULL,
      application_id text NOT NULL,
      amount_raw numeric(78,0) NOT NULL,
      tx_hash text,
      reason text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS seed_payouts (
      idempotency_key text PRIMARY KEY,
      status text NOT NULL,
      wallet text NOT NULL,
      application_id text NOT NULL,
      github_owner text NOT NULL,
      github_repo text NOT NULL,
      amount_raw numeric(78,0) NOT NULL,
      reason text NOT NULL,
      tx_hash text,
      error text,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      sent_at timestamptz
    );

    ALTER TABLE seed_payouts ADD COLUMN IF NOT EXISTS error text;

    CREATE INDEX IF NOT EXISTS seed_payouts_status_idx ON seed_payouts(status);
    CREATE INDEX IF NOT EXISTS seed_payouts_wallet_idx ON seed_payouts(wallet);
    CREATE INDEX IF NOT EXISTS seed_payouts_app_idx ON seed_payouts(application_id);
    CREATE INDEX IF NOT EXISTS seed_payouts_github_idx ON seed_payouts(github_owner);
    CREATE INDEX IF NOT EXISTS seed_payouts_repo_idx ON seed_payouts(github_owner, github_repo);

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

    CREATE TABLE IF NOT EXISTS seed_taint_targets (
      id bigserial PRIMARY KEY,
      source_wallet text NOT NULL,
      source_application_id text NOT NULL,
      program_id text NOT NULL,
      amount_raw numeric(78,0) NOT NULL DEFAULT 0,
      first_seen_block int NOT NULL,
      last_seen_block int NOT NULL,
      last_event_id text NOT NULL,
      state text NOT NULL DEFAULT 'active',
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (source_wallet, source_application_id, program_id)
    );

    CREATE INDEX IF NOT EXISTS seed_taint_targets_program_idx ON seed_taint_targets(program_id);
    CREATE INDEX IF NOT EXISTS seed_taint_targets_source_wallet_idx ON seed_taint_targets(source_wallet);

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

export async function validateDatabaseSchema(): Promise<void> {
  await requireColumns("applications", [
    "id",
    "handle",
    "owner",
    "github_url",
    "status",
    "season_id",
    "registered_at",
  ]);

  for (const table of [
    "seed_allocations",
    "seed_payouts",
    "seed_funding_events",
    "seed_spend_events",
    "seed_taint_targets",
    "seed_monitor_cursor",
    "seed_audit_events",
  ]) {
    await requireTable(table);
  }
}

async function requireTable(tableName: string): Promise<void> {
  const rows = await pool.query<{ exists: boolean }>(
    `SELECT to_regclass($1) IS NOT NULL AS exists`,
    [`public.${tableName}`],
  );
  if (!rows.rows[0]?.exists) {
    throw new Error(`required database table "${tableName}" is missing; run seed-backend migrations first`);
  }
}

async function requireColumns(tableName: string, columnNames: string[]): Promise<void> {
  await requireTable(tableName);
  const rows = await pool.query<{ column_name: string }>(
    `
      SELECT column_name
      FROM information_schema.columns
      WHERE table_schema = current_schema()
        AND table_name = $1
        AND column_name = ANY($2::text[])
    `,
    [tableName, columnNames],
  );
  const found = new Set(rows.rows.map((row) => row.column_name));
  const missing = columnNames.filter((columnName) => !found.has(columnName));
  if (missing.length > 0) {
    throw new Error(`required database table "${tableName}" is missing columns: ${missing.join(", ")}`);
  }
}

export async function getEligibleApplication(applicationId: string): Promise<ApplicationRow | null> {
  const rows = await pool.query<ApplicationRow>(
    `
      SELECT id, handle, owner, github_url, status, season_id, registered_at
      FROM applications
      WHERE lower(id) = lower($1)
      LIMIT 1
    `,
    [applicationId],
  );
  return rows.rows[0] ?? null;
}

export async function upsertApplicationsFromIndexer(applications: ApplicationRow[]): Promise<number> {
  if (applications.length === 0) return 0;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    for (const app of applications) {
      await client.query(
        `
          INSERT INTO applications (id, handle, owner, github_url, status, season_id, registered_at)
          VALUES (lower($1), $2, lower($3), $4, $5, $6, $7)
          ON CONFLICT (id) DO UPDATE SET
            handle = EXCLUDED.handle,
            owner = EXCLUDED.owner,
            github_url = EXCLUDED.github_url,
            status = EXCLUDED.status,
            season_id = EXCLUDED.season_id,
            registered_at = EXCLUDED.registered_at
        `,
        [
          app.id,
          app.handle,
          app.owner,
          app.github_url,
          app.status,
          app.season_id,
          app.registered_at,
        ],
      );
    }
    await client.query("COMMIT");
    return applications.length;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function listEligibleApplications(limit = 100): Promise<ApplicationRow[]> {
  const rows = await pool.query<ApplicationRow>(
    `
      SELECT id, handle, owner, github_url, status, season_id, registered_at
      FROM applications
      ORDER BY registered_at ASC
      LIMIT $1
    `,
    [limit],
  );
  return rows.rows;
}

export async function listUnfundedApplications(limit = 100): Promise<ApplicationRow[]> {
  const rows = await pool.query<ApplicationRow>(
    `
      SELECT a.id, a.handle, a.owner, a.github_url, a.status, a.season_id, a.registered_at
      FROM applications a
      WHERE NOT EXISTS (
        SELECT 1
        FROM seed_allocations sa
        WHERE sa.application_id = lower(a.id)
          AND sa.wallet = lower(a.owner)
          AND sa.total_funded_raw > 0
      )
      ORDER BY a.registered_at ASC
      LIMIT $1
    `,
    [limit],
  );
  return rows.rows;
}

export async function listAllowedRecipients(): Promise<Set<string>> {
  const rows = await pool.query<{ id: string }>(
    `SELECT lower(id) AS id FROM applications`,
  );
  return new Set(rows.rows.map((r) => r.id));
}

export async function upsertAllocation(
  app: ApplicationRow,
  githubOk: boolean,
  githubOwner: string | null,
  githubRepo: string | null,
): Promise<AllocationRow> {
  const rows = await pool.query<AllocationRow>(
    `
      INSERT INTO seed_allocations (
        wallet, application_id, github_url, github_ok, github_checked_at, github_owner, github_repo
      )
      VALUES (lower($1), lower($2), $3, $4, now(), lower($5), lower($6))
      ON CONFLICT (wallet, application_id) DO UPDATE SET
        github_url = EXCLUDED.github_url,
        github_ok = EXCLUDED.github_ok,
        github_checked_at = EXCLUDED.github_checked_at,
        github_owner = EXCLUDED.github_owner,
        github_repo = EXCLUDED.github_repo,
        updated_at = now()
      RETURNING *
    `,
    [app.owner, app.id, app.github_url, githubOk, githubOwner, githubRepo],
  );
  return rows.rows[0];
}

export async function findAllocation(wallet: string, applicationId: string): Promise<AllocationRow | null> {
  const rows = await pool.query<AllocationRow>(
    `
      SELECT *
      FROM seed_allocations
      WHERE wallet = lower($1) AND application_id = lower($2)
      LIMIT 1
    `,
    [wallet, applicationId],
  );
  return rows.rows[0] ?? null;
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

export async function inheritWalletBlockForUpdate(
  client: pg.PoolClient,
  wallet: string,
  applicationId: string,
): Promise<AllocationRow | null> {
  const inheritedRows = await client.query<{
    state: AllocationState;
    suspicious_count: number;
    risk_score: number;
    last_reason: string | null;
  }>(
    `
      SELECT state, suspicious_count, risk_score, last_reason
      FROM seed_allocations
      WHERE wallet = lower($1)
      ORDER BY updated_at DESC
      FOR UPDATE
    `,
    [wallet],
  );
  if (inheritedRows.rows.length === 0) return null;

  const inheritedState = mostRestrictiveAllocationState(inheritedRows.rows.map((row) => row.state));
  if (inheritedState === "active") {
    return getAllocationForUpdate(client, wallet, applicationId);
  }

  const inheritedSuspiciousCount = Math.max(...inheritedRows.rows.map((row) => row.suspicious_count));
  const inheritedRiskScore = Math.max(...inheritedRows.rows.map((row) => row.risk_score));
  const inheritedReason =
    inheritedRows.rows.find((row) => row.state === inheritedState && row.last_reason)?.last_reason ??
    `wallet has existing ${inheritedState} seed allocation`;

  const rows = await client.query<AllocationRow>(
    `
      UPDATE seed_allocations
      SET state = $3,
          suspicious_count = GREATEST(suspicious_count, $4),
          risk_score = GREATEST(risk_score, $5),
          last_reason = COALESCE(last_reason, $6),
          updated_at = now()
      WHERE wallet = lower($1) AND application_id = lower($2)
      RETURNING *
    `,
    [wallet, applicationId, inheritedState, inheritedSuspiciousCount, inheritedRiskScore, inheritedReason],
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

export async function listPayouts(status?: string): Promise<PayoutRow[]> {
  const rows = await pool.query<PayoutRow>(
    `
      SELECT idempotency_key, status, wallet, application_id, github_owner, github_repo,
             amount_raw::text, reason, tx_hash, error, created_at, updated_at, sent_at
      FROM seed_payouts
      WHERE ($1::text IS NULL OR status = upper($1))
      ORDER BY updated_at DESC
      LIMIT 500
    `,
    [status ?? null],
  );
  return rows.rows;
}

export async function getPayoutByKey(idempotencyKey: string): Promise<PayoutRow | null> {
  const rows = await pool.query<PayoutRow>(
    `
      SELECT idempotency_key, status, wallet, application_id, github_owner, github_repo,
             amount_raw::text, reason, tx_hash, error, created_at, updated_at, sent_at
      FROM seed_payouts
      WHERE idempotency_key = $1
      LIMIT 1
    `,
    [idempotencyKey],
  );
  return rows.rows[0] ?? null;
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
