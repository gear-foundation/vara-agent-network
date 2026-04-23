// Interaction handler. Projects Gear.MessageQueued into `interactions` rows
// with the origin tag (codex Q1 resolution). Every extrinsic that calls
// a tracked Application counts — wallet-initiated and program-initiated are
// stored distinctly so the Top Integrators leaderboard can split them without
// losing either signal.
//
// What counts as an interaction:
//   destination is a registered Application.id
//   source != destination (skip self-calls)
//   (source MAY or may not be a registered Application)
//
// Kind taxonomy:
//   "CrossProgramCall"   — source is registered Application, payload present
//   "WalletToProgram"    — source is not a registered Application
//   "ValueTransfer"      — value > 0 (takes precedence over the above only
//                          when payload is effectively empty; kept simple
//                          for v1: attach valuePaidRaw to any row and let
//                          the query side slice by it)
//
// Method resolution deferred: MessageQueued payload isn't on the event. v1.x
// will decode via sails-js-parser when the destination program has a
// registered IDL in the indexer.
//
// Replay safety: deterministic id = Gear messageId (globally unique per chain).
// Metric bumps gated by isFirstTimeEvent() through the event_processed table.
import { eq, sql } from "drizzle-orm";
import { config } from "../config.js";
import type { Db } from "../model/db.js";
import { schema } from "../model/db.js";
import type { MessageQueuedEvent } from "../helpers/types.js";
import type { HandlerContext } from "./common.js";
import { isFirstTimeEvent } from "./common.js";

export interface MessageQueuedContext {
  block: HandlerContext["block"];
  event: MessageQueuedEvent;
  programId: string;
}

export async function handleMessageQueued(
  db: Db,
  ctx: MessageQueuedContext,
): Promise<void> {
  const { source, destination, messageId } = ctx.event;

  // Skip self-calls — program emitting to itself isn't a cross-program edge.
  if (source.toLowerCase() === destination.toLowerCase()) return;

  // Resolve destination. Valid callees:
  //   1. The hackathon program itself — every extrinsic targeting it is an
  //      interaction (the CEO metric wants "extrinsics/day on hackathon
  //      programs"). No app_metrics row for this case since the program
  //      isn't a registered Application.
  //   2. A registered Application — when program-to-program composition
  //      happens (deployed Sails app X calls registered app Y via msg::send).
  //      This path drives the Top Integrators leaderboard.
  const hackathonProgramId = config.hackathonProgramId.toLowerCase();
  const isTrackedProgram = destination === hackathonProgramId;
  const calleeApp = await lookupApplication(db, destination);
  if (!calleeApp && !isTrackedProgram) return;

  // Resolve source: registered Application? registered Participant? Neither?
  // Note we look up BOTH tables always — the wallet-agent archetype means the
  // same ActorId can be both a Participant (human) and an Application (agent).
  const callerApp = await lookupApplication(db, source);
  const callerParticipant = await lookupParticipant(db, source);

  // Origin taxonomy (codex Q1):
  //   wallet_initiated  — source is a registered Participant (including
  //                       wallet-agents that are ALSO Applications). Covers
  //                       "real human / real wallet clicked a button".
  //   program_initiated — source is registered as an Application ONLY (no
  //                       matching Participant row). A deployed program
  //                       composing with another program.
  //   wallet_initiated  — source is unknown (no rows): treat as wallet by
  //                       default — on-chain ActorId format doesn't let us
  //                       distinguish an unregistered wallet from an
  //                       unregistered program, and the CEO metric counts
  //                       the extrinsic either way.
  const origin: "program_initiated" | "wallet_initiated" =
    !callerParticipant && callerApp ? "program_initiated" : "wallet_initiated";
  const callerKind: "Program" | "Wallet" =
    origin === "program_initiated" ? "Program" : "Wallet";
  const kind = origin === "program_initiated" ? "CrossProgramCall" : "WalletToProgram";
  // Prefer participant handle (human-readable) over app handle when both exist.
  const callerHandle = callerParticipant?.handle ?? callerApp?.handle ?? null;

  // Resolve season id. Prefer calleeApp's, fall back to the indexer's
  // configured season (hackathon program itself has no per-row record).
  const seasonId = calleeApp?.seasonId ?? config.hackathonSeasonId;
  const calleeHandle = calleeApp?.handle ?? (isTrackedProgram ? "hackathon" : null);

  // Deterministic id: Gear messageId is unique chain-wide.
  const id = `interaction:${messageId}`;

  await db
    .insert(schema.interactions)
    .values({
      id,
      kind,
      origin,
      caller: source,
      callerKind,
      callerHandle,
      callee: destination,
      calleeHandle,
      method: null, // v1 defers method decoding
      valuePaidRaw: null, // v1 doesn't propagate value through the adapter yet
      substrateBlockNumber: ctx.block.substrateBlockNumber,
      substrateBlockTs: ctx.block.substrateBlockTs,
      seasonId,
    })
    .onConflictDoNothing({ target: schema.interactions.id });

  // Metric bumps — gated by isFirstTimeEvent so replay doesn't double-count.
  if (!(await isFirstTimeEvent(db, `interaction:${messageId}:bumps`))) {
    return;
  }

  // Callee side: bump integrationsIn only for registered Applications.
  // Calls into the hackathon program itself are counted in `interactions` but
  // don't mutate per-app metrics (no Application row exists for it). The
  // network-wide count still rolls up from `interactions` in Phase 5.2.
  if (calleeApp) {
    await bumpMetric(db, destination, seasonId, "integrationsIn", ctx.block.substrateBlockTs);
  }

  // Caller side: only meaningful if the caller is a registered Application
  // (we don't maintain metric rows for unknown wallets). For wallet-agents
  // — which ARE registered Applications — we bump integrationsOut and also
  // the origin-tagged counterpart, so the caller's own row tells us whether
  // their outbound activity was driven by their wallet-agent half or their
  // program half.
  if (callerApp) {
    await bumpMetric(db, source, callerApp.seasonId, "integrationsOut", ctx.block.substrateBlockTs);
    const originCol = origin === "wallet_initiated"
      ? "integrationsOutWalletInitiated"
      : "integrationsOutProgramInitiated";
    await bumpMetric(db, source, callerApp.seasonId, originCol, ctx.block.substrateBlockTs);
  }

  // Unique partner dedup: first-time (caller, callee, season) triple bumps
  // uniquePartners on the callee's app row (if it's a registered Application).
  if (calleeApp) {
    const partnerInsert = await db
      .insert(schema.partnerDedup)
      .values({
        caller: source,
        callee: destination,
        seasonId,
        firstSeenBlock: ctx.block.substrateBlockNumber,
      })
      .onConflictDoNothing()
      .returning({ caller: schema.partnerDedup.caller });
    if (partnerInsert.length > 0) {
      await bumpMetric(db, destination, seasonId, "uniquePartners", ctx.block.substrateBlockTs);
    }
  }
}

async function lookupApplication(db: Db, id: string) {
  const rows = await db
    .select({ handle: schema.applications.handle, seasonId: schema.applications.seasonId })
    .from(schema.applications)
    .where(eq(schema.applications.id, id))
    .limit(1);
  return rows[0] ?? null;
}

async function lookupParticipant(db: Db, id: string) {
  const rows = await db
    .select({ handle: schema.participants.handle })
    .from(schema.participants)
    .where(eq(schema.participants.id, id))
    .limit(1);
  return rows[0] ?? null;
}

type BumpColumn =
  | "integrationsOut"
  | "integrationsOutWalletInitiated"
  | "integrationsOutProgramInitiated"
  | "integrationsIn"
  | "uniquePartners";

async function bumpMetric(
  db: Db,
  appId: string,
  seasonId: number,
  column: BumpColumn,
  ts: bigint,
): Promise<void> {
  const id = `${appId}:${seasonId}`;
  const columnRef = schema.appMetrics[column];
  const base = {
    id,
    applicationId: appId,
    seasonId,
    updatedAt: ts,
  };
  const initial = { ...base, [column]: 1 } as typeof base & Record<BumpColumn, number>;
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
