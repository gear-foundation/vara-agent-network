// Daily metrics rollup. Idempotent; reruns of the same date produce identical
// rows via UPSERT on (season_id, date). Drives the stakeholder dashboard and
// the north-star metric: extrinsics/day on hackathon programs.
//
// Design choice: rollup reads from append-only source tables (chat_messages,
// announcements, interactions) + summary tables (applications). No mutation
// of source data; the rollup is a pure derived projection.
//
// Replay safety: the handler-level event_processed dedup already prevents
// double-counting upstream. The rollup itself is a set of SQL aggregates +
// UPSERT, so running it N times for the same date yields the same answer.

import { and, count, countDistinct, eq, gte, lt, sql } from "drizzle-orm";
import { log } from "../helpers/logger.js";
import type { Db } from "../model/db.js";
import { schema } from "../model/db.js";

/** ISO date in UTC, e.g. "2026-04-23". */
export type DateKey = string;

export interface RollupWindow {
  seasonId: number;
  date: DateKey;
  /** Inclusive lower bound: 00:00:00.000 UTC on `date`, ms since epoch. */
  startMs: bigint;
  /** Exclusive upper bound: 00:00:00.000 UTC on `date+1`, ms since epoch. */
  endMs: bigint;
}

export function windowForDate(seasonId: number, date: DateKey): RollupWindow {
  const startMs = BigInt(Date.UTC(
    Number(date.slice(0, 4)),
    Number(date.slice(5, 7)) - 1,
    Number(date.slice(8, 10)),
  ));
  const endMs = startMs + 86_400_000n;
  return { seasonId, date, startMs, endMs };
}

export function yesterdayUtc(): DateKey {
  const d = new Date(Date.now() - 86_400_000);
  return d.toISOString().slice(0, 10);
}

export function todayUtc(): DateKey {
  return new Date().toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// NetworkMetrics — daily aggregates per season.
// ---------------------------------------------------------------------------

export async function rollupNetworkMetrics(db: Db, w: RollupWindow): Promise<void> {
  // extrinsicsOnHackathonPrograms: sum of ingested activity rows during the
  // day. Each row represents one decoded on-chain action.
  const [chatCount] = await db
    .select({ n: count() })
    .from(schema.chatMessages)
    .where(and(
      eq(schema.chatMessages.seasonId, w.seasonId),
      gte(schema.chatMessages.substrateBlockTs, w.startMs),
      lt(schema.chatMessages.substrateBlockTs, w.endMs),
    ));

  const [interactionCount] = await db
    .select({ n: count() })
    .from(schema.interactions)
    .where(and(
      eq(schema.interactions.seasonId, w.seasonId),
      gte(schema.interactions.substrateBlockTs, w.startMs),
      lt(schema.interactions.substrateBlockTs, w.endMs),
    ));

  // Announcements: posted_at is domain time (ms). Use it as the day bucket.
  const [announcementCount] = await db
    .select({ n: count() })
    .from(schema.announcements)
    .where(and(
      eq(schema.announcements.seasonId, w.seasonId),
      gte(schema.announcements.postedAt, w.startMs),
      lt(schema.announcements.postedAt, w.endMs),
    ));

  const extrinsics = (chatCount?.n ?? 0) + (interactionCount?.n ?? 0) + (announcementCount?.n ?? 0);

  // Deployed programs, cumulative at end of day.
  const [deployedCount] = await db
    .select({ n: count() })
    .from(schema.applications)
    .where(and(
      eq(schema.applications.seasonId, w.seasonId),
      lt(schema.applications.registeredAt, w.endMs),
    ));

  // Unique wallets: distinct `caller` from wallet_initiated interactions today.
  const [uniqueWallets] = await db
    .select({ n: countDistinct(schema.interactions.caller) })
    .from(schema.interactions)
    .where(and(
      eq(schema.interactions.seasonId, w.seasonId),
      eq(schema.interactions.origin, "wallet_initiated"),
      gte(schema.interactions.substrateBlockTs, w.startMs),
      lt(schema.interactions.substrateBlockTs, w.endMs),
    ));

  // Cross-program call %: program_initiated / total interactions in the day.
  const [progInit] = await db
    .select({ n: count() })
    .from(schema.interactions)
    .where(and(
      eq(schema.interactions.seasonId, w.seasonId),
      eq(schema.interactions.origin, "program_initiated"),
      gte(schema.interactions.substrateBlockTs, w.startMs),
      lt(schema.interactions.substrateBlockTs, w.endMs),
    ));
  const totalInteractions = interactionCount?.n ?? 0;
  const crossPct = totalInteractions > 0
    ? (progInit?.n ?? 0) / totalInteractions
    : 0;

  const id = `${w.seasonId}:${w.date}`;
  const updatedAt = BigInt(Date.now());
  await db
    .insert(schema.networkMetrics)
    .values({
      id,
      seasonId: w.seasonId,
      date: w.date,
      extrinsicsOnHackathonPrograms: extrinsics,
      deployedProgramCount: deployedCount?.n ?? 0,
      uniqueWalletsCalling: uniqueWallets?.n ?? 0,
      crossProgramCallPct: crossPct,
      updatedAt,
    })
    .onConflictDoUpdate({
      target: schema.networkMetrics.id,
      set: {
        extrinsicsOnHackathonPrograms: extrinsics,
        deployedProgramCount: deployedCount?.n ?? 0,
        uniqueWalletsCalling: uniqueWallets?.n ?? 0,
        crossProgramCallPct: crossPct,
        updatedAt,
      },
    });

  log.info("rolled up network_metrics", {
    season: w.seasonId,
    date: w.date,
    extrinsics,
    deployed: deployedCount?.n ?? 0,
    uniqueWallets: uniqueWallets?.n ?? 0,
    crossPct,
  });
}

// ---------------------------------------------------------------------------
// AppMetrics rolling windows — per app, per season.
//
// Recomputes windowed metrics for every known application. Simple approach:
// plain GROUP BY + SET for v1. At 1000s of apps this stays fast (≤1s total).
// Scale out with a per-app partition or materialized view later.
// ---------------------------------------------------------------------------

export async function rollupAppMetrics(db: Db, asOfDate: DateKey, seasonId: number): Promise<void> {
  const asOfWindow = windowForDate(seasonId, asOfDate);
  const asOfEnd = asOfWindow.endMs;

  // DAU wallet callers (last 7 days). callee-scoped count of distinct
  // wallet_initiated callers within the window ending at asOfEnd.
  const dauWindowStart = asOfEnd - 7n * 86_400_000n;
  const dauRows = await db
    .select({
      callee: schema.interactions.callee,
      n: countDistinct(schema.interactions.caller),
    })
    .from(schema.interactions)
    .where(and(
      eq(schema.interactions.seasonId, seasonId),
      eq(schema.interactions.origin, "wallet_initiated"),
      gte(schema.interactions.substrateBlockTs, dauWindowStart),
      lt(schema.interactions.substrateBlockTs, asOfEnd),
    ))
    .groupBy(schema.interactions.callee);

  for (const row of dauRows) {
    const id = `${row.callee}:${seasonId}`;
    await db
      .update(schema.appMetrics)
      .set({
        dauWalletCallers7d: row.n,
        updatedAt: asOfEnd,
      })
      .where(eq(schema.appMetrics.id, id));
  }

  // Time-to-first-integration: min(substrate_block) - applications.registered_at_block
  // where caller = app_id. Note `registered_at` is domain time (ms), not a
  // block number. For v1 we approximate: use min(substrate_block) absolute
  // and store as "blocks since dawn-of-time" — useful as a comparable metric.
  const firstIntRows = await db
    .select({
      caller: schema.interactions.caller,
      firstBlock: sql<number>`min(${schema.interactions.substrateBlockNumber})`,
    })
    .from(schema.interactions)
    .where(eq(schema.interactions.seasonId, seasonId))
    .groupBy(schema.interactions.caller);

  for (const row of firstIntRows) {
    const id = `${row.caller}:${seasonId}`;
    await db
      .update(schema.appMetrics)
      .set({
        timeToFirstIntegrationBlocks: row.firstBlock,
        updatedAt: asOfEnd,
      })
      .where(eq(schema.appMetrics.id, id));
  }

  // Call-graph density: for each app, distinct partners / (total apps in
  // season − 1). Partners count lives in appMetrics.uniquePartners already;
  // we compute density = uniquePartners / (n_apps - 1).
  const [{ n: totalApps } = { n: 0 }] = await db
    .select({ n: count() })
    .from(schema.applications)
    .where(eq(schema.applications.seasonId, seasonId));
  const denom = Math.max(1, totalApps - 1);
  await db
    .update(schema.appMetrics)
    .set({
      callGraphDensity: sql`${schema.appMetrics.uniquePartners}::double precision / ${denom}`,
      updatedAt: asOfEnd,
    })
    .where(eq(schema.appMetrics.seasonId, seasonId));

  // Retention 7/14/21 — simplified definition: fraction of unique wallet
  // callers on day D-N who also appear as callers on day D. Computed per
  // callee (the app). Uses DISTINCT CALLER intersection.
  for (const days of [7, 14, 21] as const) {
    await computeRetention(db, seasonId, asOfDate, days);
  }

  log.info("rolled up app_metrics", { season: seasonId, asOfDate });
}

async function computeRetention(
  db: Db,
  seasonId: number,
  asOfDate: DateKey,
  days: 7 | 14 | 21,
): Promise<void> {
  const asOf = windowForDate(seasonId, asOfDate);
  const priorDate = new Date(Number(asOf.startMs) - days * 86_400_000).toISOString().slice(0, 10);
  const prior = windowForDate(seasonId, priorDate);

  // Per-callee: |callers on priorDay ∩ callers on asOfDay| / |callers on priorDay|.
  // Single SQL: self-join interactions via a callee+caller keyset.
  const column =
    days === 7 ? "retention7d"
    : days === 14 ? "retention14d"
    : "retention21d";
  const rows = await db.execute(sql`
    WITH prior AS (
      SELECT DISTINCT callee, caller
      FROM interactions
      WHERE season_id = ${seasonId}
        AND origin = 'wallet_initiated'
        AND substrate_block_ts >= ${prior.startMs}
        AND substrate_block_ts <  ${prior.endMs}
    ),
    today AS (
      SELECT DISTINCT callee, caller
      FROM interactions
      WHERE season_id = ${seasonId}
        AND origin = 'wallet_initiated'
        AND substrate_block_ts >= ${asOf.startMs}
        AND substrate_block_ts <  ${asOf.endMs}
    )
    SELECT
      p.callee AS callee,
      CAST(COUNT(*) FILTER (WHERE t.caller IS NOT NULL) AS double precision) /
        NULLIF(COUNT(*), 0) AS ret
    FROM prior p
    LEFT JOIN today t ON t.callee = p.callee AND t.caller = p.caller
    GROUP BY p.callee
  `);
  for (const row of rows.rows as Array<{ callee: string; ret: number | null }>) {
    const id = `${row.callee}:${seasonId}`;
    const ret = row.ret ?? 0;
    await db.execute(sql`
      UPDATE app_metrics
         SET ${sql.identifier(camelToSnake(column))} = ${ret},
             updated_at = ${asOf.endMs}
       WHERE id = ${id}
    `);
  }
}

function camelToSnake(s: string): string {
  return s.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
}

// ---------------------------------------------------------------------------
// Entrypoint
// ---------------------------------------------------------------------------

export async function runDailyRollup(
  db: Db,
  seasonId: number,
  date: DateKey,
): Promise<void> {
  const window = windowForDate(seasonId, date);
  await rollupNetworkMetrics(db, window);
  await rollupAppMetrics(db, date, seasonId);
}
