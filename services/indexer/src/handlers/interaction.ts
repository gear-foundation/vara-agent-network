// Interaction handler. Projects Gear.MessageQueued into `interactions` rows
// with the origin tag (codex Q1). Messages involving a registered
// Application count — wallet-initiated and program-initiated split so the
// Top Integrators leaderboard can distinguish true cross-program composition
// from wallet-driven demand.
//
// Replay safety: deterministic id = Gear messageId (globally unique per chain).
// Metric bumps gated by isFirstTimeEvent. Lookups + bumps run in parallel
// because they target distinct rows — the hot path for every extrinsic.
import { config, requireProcessorConfig } from "../config.js";
import type { Db } from "../model/db.js";
import { schema } from "../model/db.js";
import type { MessageQueuedEvent } from "../helpers/types.js";
import {
  bumpMetric,
  classifyCaller,
  isFirstTimeEvent,
  ORIGIN,
  resolveActor,
  type BumpableColumn,
  type HandlerContext,
} from "./common.js";

export async function handleMessageQueued(
  db: Db,
  ctx: HandlerContext<MessageQueuedEvent>,
): Promise<void> {
  const processorConfig = requireProcessorConfig();
  const { source, destination, messageId } = ctx.event;

  // Skip self-calls — program emitting to itself isn't a cross-program edge.
  if (source === destination) return;

  // Resolve source + destination in parallel (the hot-path latency win).
  const [srcActor, destActor] = await Promise.all([
    resolveActor(db, source),
    resolveActor(db, destination),
  ]);

  // Valid interactions: the Vara Agent Network program itself OR any message
  // where at least one side is a registered Application. The processor passes
  // all Gear.MessageQueued events so app->app messages are not dropped before
  // registry resolution.
  const networkProgramId = processorConfig.programId.toLowerCase();
  const isNetworkProgram = destination === networkProgramId || source === networkProgramId;
  if (!srcActor.isApplication && !destActor.isApplication && !isNetworkProgram) return;

  const { origin, callerKind, kind, callerHandle } = classifyCaller(
    srcActor.application,
    srcActor.participant,
  );

  const seasonId = destActor.seasonId ?? srcActor.seasonId ?? config.seasonId;
  const calleeHandle = destActor.application?.handle
    ?? (destination === networkProgramId ? "vara-agents" : null);

  await db
    .insert(schema.interactions)
    .values({
      id: `interaction:${messageId}`,
      kind,
      origin,
      caller: source,
      callerKind,
      callerHandle,
      callee: destination,
      calleeHandle,
      method: null, // Method decoding is deferred (requires target IDL registry)
      valuePaidRaw: null, // adapter doesn't plumb value through yet
      substrateBlockNumber: ctx.block.substrateBlockNumber,
      substrateBlockTs: ctx.block.substrateBlockTs,
      seasonId,
    })
    .onConflictDoNothing({ target: schema.interactions.id });

  // Gate metric bumps so replay / concurrent catch-up doesn't double-count.
  if (!(await isFirstTimeEvent(db, `interaction:${messageId}:bumps`))) return;

  const ts = ctx.block.substrateBlockTs;
  const bumps: Promise<void>[] = [];

  // integrationsIn on callee (registered Applications only — no metric row
  // exists for the network program pseudo-app).
  if (destActor.isApplication) {
    bumps.push(bumpMetric(db, destination, seasonId, "integrationsIn", ts));
  }

  // integrationsOut on caller (registered Applications only), plus origin
  // split so we can see whether this app's outbound activity is wallet-agent
  // driven or program-to-program.
  if (srcActor.isApplication && srcActor.application) {
    const originCol: BumpableColumn = origin === ORIGIN.Wallet
      ? "integrationsOutWalletInitiated"
      : "integrationsOutProgramInitiated";
    bumps.push(bumpMetric(db, source, srcActor.application.seasonId, "integrationsOut", ts));
    bumps.push(bumpMetric(db, source, srcActor.application.seasonId, originCol, ts));
  }

  // Unique partner dedup. First-time (caller, callee, season) triple bumps
  // uniquePartners on the caller side. This is an outbound composition metric,
  // so it belongs to the app initiating the interaction.
  if (srcActor.isApplication && srcActor.application) {
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
      bumps.push(
        bumpMetric(
          db,
          source,
          srcActor.application.seasonId,
          "uniquePartners",
          ts,
        ),
      );
    }
  }

  await Promise.all(bumps);
}
