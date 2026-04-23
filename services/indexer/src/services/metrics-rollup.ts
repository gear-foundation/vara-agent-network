// Daily metrics rollup. Idempotent; reruns of the same date produce identical
// rows via UPSERT on (season_id, date). Drives the stakeholder dashboard and
// the north-star metric: extrinsics/day on the Vara Agent Network program.

import { and, count, countDistinct, eq, gte, lt, sql } from "drizzle-orm";
import { ORIGIN } from "../handlers/common.js";
import { log } from "../helpers/logger.js";
import type { Db } from "../model/db.js";
import { schema } from "../model/db.js";

/** ISO date in UTC, e.g. "2026-04-23". */
export type DateKey = string;

export interface RollupWindow {
  seasonId: number;
  date: DateKey;
  startMs: bigint;
  endMs: bigint;
}

const DAY_MS = 86_400_000n;

export function windowForDate(seasonId: number, date: DateKey): RollupWindow {
  const startMs = BigInt(Date.UTC(
    Number(date.slice(0, 4)),
    Number(date.slice(5, 7)) - 1,
    Number(date.slice(8, 10)),
  ));
  return { seasonId, date, startMs, endMs: startMs + DAY_MS };
}

export function yesterdayUtc(): DateKey {
  return new Date(Date.now() - Number(DAY_MS)).toISOString().slice(0, 10);
}
export function todayUtc(): DateKey {
  return new Date().toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// NetworkMetrics — daily aggregates per season.
// ---------------------------------------------------------------------------

export async function rollupNetworkMetrics(db: Db, w: RollupWindow): Promise<void> {
  // All six aggregates are independent reads — fire them in parallel.
  const [
    chatCount,
    interactionCount,
    announcementCount,
    deployedCount,
    uniqueWallets,
    progInit,
  ] = await Promise.all([
    db.select({ n: count() }).from(schema.chatMessages).where(and(
      eq(schema.chatMessages.seasonId, w.seasonId),
      gte(schema.chatMessages.substrateBlockTs, w.startMs),
      lt(schema.chatMessages.substrateBlockTs, w.endMs),
    )).then((r) => r[0]?.n ?? 0),
    db.select({ n: count() }).from(schema.interactions).where(and(
      eq(schema.interactions.seasonId, w.seasonId),
      gte(schema.interactions.substrateBlockTs, w.startMs),
      lt(schema.interactions.substrateBlockTs, w.endMs),
    )).then((r) => r[0]?.n ?? 0),
    db.select({ n: count() }).from(schema.announcements).where(and(
      eq(schema.announcements.seasonId, w.seasonId),
      gte(schema.announcements.postedAt, w.startMs),
      lt(schema.announcements.postedAt, w.endMs),
    )).then((r) => r[0]?.n ?? 0),
    db.select({ n: count() }).from(schema.applications).where(and(
      eq(schema.applications.seasonId, w.seasonId),
      lt(schema.applications.registeredAt, w.endMs),
    )).then((r) => r[0]?.n ?? 0),
    db.select({ n: countDistinct(schema.interactions.caller) }).from(schema.interactions).where(and(
      eq(schema.interactions.seasonId, w.seasonId),
      eq(schema.interactions.origin, ORIGIN.Wallet),
      gte(schema.interactions.substrateBlockTs, w.startMs),
      lt(schema.interactions.substrateBlockTs, w.endMs),
    )).then((r) => r[0]?.n ?? 0),
    db.select({ n: count() }).from(schema.interactions).where(and(
      eq(schema.interactions.seasonId, w.seasonId),
      eq(schema.interactions.origin, ORIGIN.Program),
      gte(schema.interactions.substrateBlockTs, w.startMs),
      lt(schema.interactions.substrateBlockTs, w.endMs),
    )).then((r) => r[0]?.n ?? 0),
  ]);

  const extrinsics = chatCount + interactionCount + announcementCount;
  const crossPct = interactionCount > 0 ? progInit / interactionCount : 0;

  const id = `${w.seasonId}:${w.date}`;
  const updatedAt = BigInt(Date.now());
  const row = {
    extrinsicsOnHackathonPrograms: extrinsics,
    deployedProgramCount: deployedCount,
    uniqueWalletsCalling: uniqueWallets,
    crossProgramCallPct: crossPct,
    updatedAt,
  };
  await db
    .insert(schema.networkMetrics)
    .values({ id, seasonId: w.seasonId, date: w.date, ...row })
    .onConflictDoUpdate({ target: schema.networkMetrics.id, set: row });

  log.info("rolled up network_metrics", {
    season: w.seasonId,
    date: w.date,
    extrinsics,
    deployed: deployedCount,
    uniqueWallets,
    crossPct,
  });
}

// ---------------------------------------------------------------------------
// AppMetrics rolling windows — per app, per season.
// ---------------------------------------------------------------------------

export async function rollupAppMetrics(db: Db, asOfDate: DateKey, seasonId: number): Promise<void> {
  const asOf = windowForDate(seasonId, asOfDate);
  const asOfEnd = asOf.endMs;

  // All set-based updates below derive from a CTE and apply in one round-trip
  // per metric, independent of app count. Previous per-row loops were O(N RTT).

  // DAU wallet callers (trailing 7d, ending at asOfEnd).
  const dauStart = asOfEnd - 7n * DAY_MS;
  await db.execute(sql`
    UPDATE app_metrics m
       SET dau_wallet_callers_7d = COALESCE(d.n, 0),
           updated_at = ${asOfEnd}
      FROM (
        SELECT callee, COUNT(DISTINCT caller) AS n
          FROM interactions
         WHERE season_id = ${seasonId}
           AND origin = ${ORIGIN.Wallet}
           AND substrate_block_ts >= ${dauStart}
           AND substrate_block_ts <  ${asOfEnd}
         GROUP BY callee
      ) d
     WHERE m.season_id = ${seasonId}
       AND m.application_id = d.callee
  `);

  // First integration block per caller (absolute block, renamed from misleading
  // "timeToFirstIntegrationBlocks" which implied a delta against registration).
  await db.execute(sql`
    UPDATE app_metrics m
       SET first_integration_block = f.first_block,
           updated_at = ${asOfEnd}
      FROM (
        SELECT caller, MIN(substrate_block_number) AS first_block
          FROM interactions
         WHERE season_id = ${seasonId}
         GROUP BY caller
      ) f
     WHERE m.season_id = ${seasonId}
       AND m.application_id = f.caller
  `);

  // Call-graph density: distinct partners / (total apps − 1). Null when
  // there's only one app in the season (density is undefined there).
  const [{ n: totalApps } = { n: 0 }] = await db
    .select({ n: count() })
    .from(schema.applications)
    .where(eq(schema.applications.seasonId, seasonId));
  if (totalApps < 2) {
    await db
      .update(schema.appMetrics)
      .set({ callGraphDensity: null, updatedAt: asOfEnd })
      .where(eq(schema.appMetrics.seasonId, seasonId));
  } else {
    const denom = totalApps - 1;
    await db
      .update(schema.appMetrics)
      .set({
        callGraphDensity: sql`${schema.appMetrics.uniquePartners}::double precision / ${denom}`,
        updatedAt: asOfEnd,
      })
      .where(eq(schema.appMetrics.seasonId, seasonId));
  }

  // Retention 7/14/21 — fraction of wallet callers on day D-N who return on
  // day D. Single UPDATE per window via a CTE; column mapped statically.
  // NOTE: relies on Drizzle's PgColumn.name exposing the snake-case SQL
  // column identifier. Stable on drizzle-orm 0.36.x; pin-check on upgrade.
  const retentionColumns = {
    7: schema.appMetrics.retention7d,
    14: schema.appMetrics.retention14d,
    21: schema.appMetrics.retention21d,
  } as const;
  for (const days of [7, 14, 21] as const) {
    const priorDate = new Date(Number(asOf.startMs) - days * Number(DAY_MS))
      .toISOString().slice(0, 10);
    const prior = windowForDate(seasonId, priorDate);
    await computeRetention(db, seasonId, asOf, prior, retentionColumns[days].name);
  }

  log.info("rolled up app_metrics", { season: seasonId, asOfDate });
}

async function computeRetention(
  db: Db,
  seasonId: number,
  asOf: RollupWindow,
  prior: RollupWindow,
  columnName: string,
): Promise<void> {
  // Broad UPDATE: every app_metrics row in the season is reset based on
  // whether the callee appears in `ret`. Apps with no prior-day cohort go
  // to 0 (not left at their stale previous value — review finding #1).
  // `columnName` is a literal from a static mapping of Drizzle columns
  // (retention7d/14d/21d) via column.name, never user input — safe to inject
  // through sql.identifier.
  await db.execute(sql`
    WITH prior AS (
      SELECT DISTINCT callee, caller FROM interactions
       WHERE season_id = ${seasonId}
         AND origin = ${ORIGIN.Wallet}
         AND substrate_block_ts >= ${prior.startMs}
         AND substrate_block_ts <  ${prior.endMs}
    ),
    today AS (
      SELECT DISTINCT callee, caller FROM interactions
       WHERE season_id = ${seasonId}
         AND origin = ${ORIGIN.Wallet}
         AND substrate_block_ts >= ${asOf.startMs}
         AND substrate_block_ts <  ${asOf.endMs}
    ),
    ret AS (
      SELECT p.callee,
             CAST(COUNT(*) FILTER (WHERE t.caller IS NOT NULL) AS double precision)
               / NULLIF(COUNT(*), 0) AS value
        FROM prior p
        LEFT JOIN today t ON t.callee = p.callee AND t.caller = p.caller
       GROUP BY p.callee
    )
    UPDATE app_metrics m
       SET ${sql.identifier(columnName)} = COALESCE(ret.value, 0),
           updated_at = ${asOf.endMs}
      FROM applications a
      LEFT JOIN ret ON ret.callee = a.id
     WHERE a.season_id = ${seasonId}
       AND m.season_id = ${seasonId}
       AND m.application_id = a.id
  `);
}

export async function runDailyRollup(
  db: Db,
  seasonId: number,
  date: DateKey,
): Promise<void> {
  const window = windowForDate(seasonId, date);
  await Promise.all([
    rollupNetworkMetrics(db, window),
    rollupAppMetrics(db, date, seasonId),
  ]);
}
