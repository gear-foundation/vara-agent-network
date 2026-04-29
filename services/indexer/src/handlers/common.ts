// Shared types and helpers across handlers.
import { eq, sql } from "drizzle-orm";
import type { Db } from "../model/db.js";
import { schema } from "../model/db.js";
import { normalizeActorId, type HandleRef } from "../helpers/event-payloads.js";
import type { BlockContext, UserMessageSentEvent } from "../helpers/types.js";

export interface HandlerContext<TEvent = UserMessageSentEvent> {
  block: BlockContext;
  event: TEvent;
  /** Monotonic extrinsic position within the block if available. */
  extrinsicIdx: number;
  /** Event index within block. */
  eventIdx: number;
  /** Program id this event came from. */
  programId: string;
}

/** Deterministic id for append-only rows. */
export function makeRowId(ctx: HandlerContext<unknown>): string {
  return `${ctx.programId}:${ctx.block.substrateBlockNumber}:${ctx.extrinsicIdx}:${ctx.eventIdx}`;
}

/**
 * Event-level idempotency gate. Handlers that mutate rolling counters (metric
 * bumps, dedup tables) call this FIRST. Returns `true` when this is the first
 * time we've seen the given key, `false` on replay/concurrent-duplicate.
 *
 * Handlers that only do `INSERT ... ON CONFLICT DO NOTHING/UPDATE` on
 * deterministic-id rows can skip this — those are already idempotent.
 */
export async function isFirstTimeEvent(db: Db, key: string): Promise<boolean> {
  const rows = await db
    .insert(schema.eventProcessed)
    .values({ key, processedAt: BigInt(Date.now()) })
    .onConflictDoNothing()
    .returning({ key: schema.eventProcessed.key });
  return rows.length > 0;
}

export async function claimHandleOrThrow(
  db: Db,
  handle: string,
  ownerKind: "Participant" | "Application",
  ownerId: string,
  seasonId: number,
  claimedAt: bigint,
): Promise<void> {
  const normalizedOwnerId = normalizeActorId(ownerId as `0x${string}`);
  const inserted = await db
    .insert(schema.handleClaims)
    .values({
      handle,
      ownerKind,
      ownerId: normalizedOwnerId,
      seasonId,
      claimedAt,
    })
    .onConflictDoNothing()
    .returning({ handle: schema.handleClaims.handle });
  if (inserted.length > 0) return;

  const existing = await db
    .select({
      ownerKind: schema.handleClaims.ownerKind,
      ownerId: schema.handleClaims.ownerId,
    })
    .from(schema.handleClaims)
    .where(eq(schema.handleClaims.handle, handle))
    .limit(1);

  const claim = existing[0];
  if (!claim) {
    throw new Error(`handle claim conflict for ${handle}: insert skipped but no existing row found`);
  }
  if (claim.ownerKind !== ownerKind || claim.ownerId !== normalizedOwnerId) {
    throw new Error(
      `global handle namespace violation for ${handle}: existing=${claim.ownerKind}:${claim.ownerId}, incoming=${ownerKind}:${normalizedOwnerId}`,
    );
  }
}

// ---------------------------------------------------------------------------
// Origin taxonomy (codex Q1) — shared across interaction + metrics rollup.
// ---------------------------------------------------------------------------

export const ORIGIN = {
  Wallet: "wallet_initiated",
  Program: "program_initiated",
} as const;
export type Origin = typeof ORIGIN[keyof typeof ORIGIN];

export const CALLER_KIND = { Wallet: "Wallet", Program: "Program" } as const;
export type CallerKind = typeof CALLER_KIND[keyof typeof CALLER_KIND];

export const INTERACTION_KIND = {
  CrossProgram: "CrossProgramCall",
  WalletToProgram: "WalletToProgram",
  ValueTransfer: "ValueTransfer",
} as const;
export type InteractionKind = typeof INTERACTION_KIND[keyof typeof INTERACTION_KIND];

/**
 * Classify a caller. A wallet-agent (ActorId registered as BOTH Participant
 * AND Application) maps to `wallet_initiated` — the human IS driving the
 * call, even though their wallet is also registered as an app.
 *
 * TODO: the network program's own outbound msg::send() calls surface
 * as MessageQueued with source = network_program_id. That ActorId isn't
 * in the `applications` table, so it'll fall into the wallet_initiated
 * branch here — wrong label. Not exercised today (the contract makes no
 * outbound calls), but once ControlPlaneService lands, pass a set of
 * "known program ActorIds" through and treat those as program_initiated.
 */
export function classifyCaller(
  callerApp: { handle: string } | null | undefined,
  callerParticipant: { handle: string } | null | undefined,
): {
  origin: Origin;
  callerKind: CallerKind;
  kind: InteractionKind;
  callerHandle: string | null;
} {
  const isPureProgram = !callerParticipant && !!callerApp;
  return isPureProgram
    ? {
        origin: ORIGIN.Program,
        callerKind: CALLER_KIND.Program,
        kind: INTERACTION_KIND.CrossProgram,
        callerHandle: callerApp.handle,
      }
    : {
        origin: ORIGIN.Wallet,
        callerKind: CALLER_KIND.Wallet,
        kind: INTERACTION_KIND.WalletToProgram,
        callerHandle: callerParticipant?.handle ?? callerApp?.handle ?? null,
      };
}

// ---------------------------------------------------------------------------
// Actor resolution — single place that knows how to look up an ActorId.
// ---------------------------------------------------------------------------

export interface ResolvedActor {
  /** The raw ActorId (lowercase hex). */
  id: string;
  /** Registered handle, preferring Participant (human) over Application (agent). */
  handle: string | null;
  /** Season the actor belongs to (or app's season if application-only). */
  seasonId: number | null;
  /** Is this ActorId registered as an Application? */
  isApplication: boolean;
  /** Is this ActorId registered as a Participant? */
  isParticipant: boolean;
  /** Application row fields needed by callers (handle + seasonId). */
  application: { handle: string; seasonId: number } | null;
  /** Participant row fields needed by callers (handle only for now). */
  participant: { handle: string } | null;
}

/**
 * Resolve an ActorId against both Participants and Applications in one call.
 * Runs the two lookups in parallel.
 */
export async function resolveActor(db: Db, id: string): Promise<ResolvedActor> {
  const normalizedId = normalizeActorId(id as `0x${string}`);
  const [appRows, partRows] = await Promise.all([
    db
      .select({ handle: schema.applications.handle, seasonId: schema.applications.seasonId })
      .from(schema.applications)
      .where(eq(schema.applications.id, normalizedId))
      .limit(1),
    db
      .select({ handle: schema.participants.handle })
      .from(schema.participants)
      .where(eq(schema.participants.id, normalizedId))
      .limit(1),
  ]);
  const application = appRows[0] ?? null;
  const participant = partRows[0] ?? null;
  return {
    id: normalizedId,
    handle: participant?.handle ?? application?.handle ?? null,
    seasonId: application?.seasonId ?? null,
    isApplication: application !== null,
    isParticipant: participant !== null,
    application,
    participant,
  };
}

/** Look up just the Participant or Application handle for a tagged HandleRef. */
export async function resolveHandleRef(
  db: Db,
  ref: HandleRef,
): Promise<string | null> {
  if ("participant" in ref) {
    const participantId = normalizeActorId(ref.participant);
    const rows = await db
      .select({ handle: schema.participants.handle })
      .from(schema.participants)
      .where(eq(schema.participants.id, participantId))
      .limit(1);
    return rows[0]?.handle ?? null;
  }
  const applicationId = normalizeActorId(ref.application);
  const rows = await db
    .select({ handle: schema.applications.handle })
    .from(schema.applications)
    .where(eq(schema.applications.id, applicationId))
    .limit(1);
  return rows[0]?.handle ?? null;
}

// ---------------------------------------------------------------------------
// Metric bumps — the single source of truth for app_metrics counter updates.
// Every increment anywhere in the indexer goes through here.
// ---------------------------------------------------------------------------

export type BumpableColumn =
  | "messagesSent"
  | "mentionCount"
  | "uniqueSendersToMe"
  | "postsActive"
  | "integrationsOut"
  | "integrationsOutWalletInitiated"
  | "integrationsOutProgramInitiated"
  | "integrationsIn"
  | "uniquePartners";

/** Increment an app_metrics column by 1 (create row if missing). */
export async function bumpMetric(
  db: Db,
  appId: string,
  seasonId: number,
  column: BumpableColumn,
  ts: bigint,
): Promise<void> {
  const id = `${appId}:${seasonId}`;
  const columnRef = schema.appMetrics[column];
  const initial = {
    id,
    applicationId: appId,
    seasonId,
    updatedAt: ts,
    [column]: 1,
  } as { id: string; applicationId: string; seasonId: number; updatedAt: bigint } & Record<
    BumpableColumn,
    number
  >;
  await db
    .insert(schema.appMetrics)
    .values(initial)
    .onConflictDoUpdate({
      target: schema.appMetrics.id,
      set: {
        [column]: sql`${columnRef} + 1`,
        updatedAt: ts,
      },
    });
}

/** Decrement an app_metrics column by 1, clamped to 0. Row must already exist. */
export async function decMetric(
  db: Db,
  appId: string,
  seasonId: number,
  column: BumpableColumn,
): Promise<void> {
  const id = `${appId}:${seasonId}`;
  const columnRef = schema.appMetrics[column];
  await db
    .update(schema.appMetrics)
    .set({ [column]: sql`GREATEST(${columnRef} - 1, 0)` })
    .where(eq(schema.appMetrics.id, id));
}
