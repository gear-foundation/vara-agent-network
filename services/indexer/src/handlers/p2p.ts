// Handler for synthetic ProgramMessage events surfaced by the P2P detector.
//
// Mirrors `interaction.ts` for projection into the `interactions` table, but:
//   - origin is always `program_initiated` (the detector only sees program
//     senders by construction)
//   - metric bumps target the `p2p_*` columns, NOT `integrations_*`. The
//     latter remain the wallet-driven leaderboard surface; P2P metrics are
//     a separate axis with its own coverage caveats (cross-block-only on a
//     public RPC).
//   - `detected_via` records whether the edge came from dispatches or waitlist
//     diff, so ops can audit detector behaviour.
//
// Replay-safe in the same way as the wallet-driven path: deterministic row id
// keyed off the message id, idempotency gate around metric bumps, partner
// dedup via a separate `p2p_partner_dedup` table.

import { config, requireProcessorConfig } from "../config.js";
import type { Db } from "../model/db.js";
import { schema } from "../model/db.js";
import type { ProgramMessageEvent } from "../helpers/types.js";
import {
  bumpMetric,
  CALLER_KIND,
  INTERACTION_KIND,
  isFirstTimeEvent,
  ORIGIN,
  resolveActor,
  type HandlerContext,
} from "./common.js";

export async function handleProgramMessage(
  db: Db,
  ctx: HandlerContext<ProgramMessageEvent>,
): Promise<void> {
  const processorConfig = requireProcessorConfig();
  const { source, destination, messageId, detectedVia } = ctx.event;

  // Self-calls aren't cross-program edges.
  if (source === destination) return;

  const [srcActor, destActor] = await Promise.all([
    resolveActor(db, source),
    resolveActor(db, destination),
  ]);

  const networkProgramId = processorConfig.programId.toLowerCase();
  const isNetworkProgram = destination === networkProgramId || source === networkProgramId;
  if (!srcActor.isApplication && !destActor.isApplication && !isNetworkProgram) return;

  const seasonId = destActor.seasonId ?? srcActor.seasonId ?? config.seasonId;
  const callerHandle = srcActor.application?.handle
    ?? (source === networkProgramId ? "vara-agents" : null);
  const calleeHandle = destActor.application?.handle
    ?? (destination === networkProgramId ? "vara-agents" : null);

  await db
    .insert(schema.interactions)
    .values({
      id: `interaction:${messageId}`,
      kind: INTERACTION_KIND.CrossProgram,
      origin: ORIGIN.Program,
      caller: source,
      callerKind: CALLER_KIND.Program,
      callerHandle,
      callee: destination,
      calleeHandle,
      method: null,
      valuePaidRaw: null,
      substrateBlockNumber: ctx.block.substrateBlockNumber,
      substrateBlockTs: ctx.block.substrateBlockTs,
      seasonId,
      detectedVia,
    })
    .onConflictDoNothing({ target: schema.interactions.id });

  // Metric bumps gated by replay-safe key. Distinct from the
  // wallet-driven `interaction:<id>:bumps` key — this is a different axis
  // and may fire for the same id if a message appears in BOTH dispatches
  // and waitlist across consecutive blocks (we want exactly one bump).
  if (!(await isFirstTimeEvent(db, `p2p:${messageId}:bumps`))) return;

  const ts = ctx.block.substrateBlockTs;
  const bumps: Promise<void>[] = [];

  if (destActor.isApplication) {
    bumps.push(bumpMetric(db, destination, seasonId, "p2pCallsIn", ts));
  }
  if (srcActor.isApplication && srcActor.application) {
    bumps.push(
      bumpMetric(db, source, srcActor.application.seasonId, "p2pCallsOut", ts),
    );

    // Unique partner dedup, P2P-side. Insert into the dedicated dedup table
    // so wallet-driven `partner_dedup` stays untouched.
    const inserted = await db
      .insert(schema.p2pPartnerDedup)
      .values({
        caller: source,
        callee: destination,
        seasonId,
        firstSeenBlock: ctx.block.substrateBlockNumber,
      })
      .onConflictDoNothing()
      .returning({ caller: schema.p2pPartnerDedup.caller });
    if (inserted.length > 0) {
      bumps.push(
        bumpMetric(
          db,
          source,
          srcActor.application.seasonId,
          "p2pUniquePartners",
          ts,
        ),
      );
    }
  }

  await Promise.all(bumps);
}
