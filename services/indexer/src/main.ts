// Processor entrypoint. Wires config → decoder → processor → handlers.
import cron, { type ScheduledTask } from "node-cron";
import { config, requireProcessorConfig } from "./config.js";
import { SailsDecoder } from "./decoder/sails-decoder.js";
import { handleApplicationStatusChanged } from "./handlers/admin.js";
import {
  handleAnnouncementArchived,
  handleAnnouncementEdited,
  handleAnnouncementPosted,
  handleIdentityCardUpdated,
} from "./handlers/board.js";
import { handleMessagePosted } from "./handlers/chat.js";
import { type HandlerContext } from "./handlers/common.js";
import { handleMessageQueued } from "./handlers/interaction.js";
import { handleProgramMessage } from "./handlers/p2p.js";
import {
  buildBlockSets,
  handleParticipationInference,
  handleUserMessageSentBacktrack,
} from "./handlers/p2p_inference.js";
import {
  handleApplicationRegistered,
  handleApplicationSubmitted,
  handleApplicationUpdated,
  handleParticipantRegistered,
} from "./handlers/registry.js";
import { formatError, log } from "./helpers/logger.js";
import {
  isMessageQueued,
  isMessagesDispatched,
  isProgramMessage,
  isSailsEvent,
  isUserMessageSent,
  type BlockContext,
} from "./helpers/types.js";
import { db } from "./model/db.js";
import { createProcessor } from "./processor.js";
import { runDailyRollup, todayUtc, yesterdayUtc } from "./services/metrics-rollup.js";

type Processor = Awaited<ReturnType<typeof createProcessor>>;

let shuttingDown = false;
let currentProcessor: Processor | null = null;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function retryDelayMs(attempt: number): number {
  const min = config.processorReconnectMinMs;
  const max = config.processorReconnectMaxMs;
  const exponential = min * 2 ** Math.max(0, attempt - 1);
  const jitter = Math.floor(Math.random() * Math.min(1_000, min));
  return Math.min(max, exponential + jitter);
}

function scheduleRollups(): ScheduledTask[] {
  if (process.env.ENABLE_INLINE_ROLLUP_CRON === "false") return [];

  const daily = cron.schedule("5 0 * * *", async () => {
    const date = yesterdayUtc();
    log.info("cron: daily rollup firing", { date });
    try {
      await runDailyRollup(db, config.seasonId, date);
    } catch (err) {
      log.error("cron: daily rollup failed", { date, error: formatError(err) });
    }
  }, { timezone: "UTC" });

  const refresh = cron.schedule("*/15 * * * *", async () => {
    const date = todayUtc();
    try {
      await runDailyRollup(db, config.seasonId, date);
    } catch (err) {
      log.error("cron: hourly refresh failed", { date, error: formatError(err) });
    }
  }, { timezone: "UTC" });

  log.info("rollup crons scheduled", { daily: "5 0 * * * UTC", refresh: "*/15 * * * *" });
  return [daily, refresh];
}

async function runProcessorOnce() {
  const processorConfig = requireProcessorConfig();
  log.info("boot", {
    programId: processorConfig.programId,
    startBlock: processorConfig.startBlock,
    season: config.seasonId,
  });

  const decoder = await SailsDecoder.fromIdlFile(processorConfig.idlPath);

  const processor = await createProcessor({
    onBlock: async (ctx: BlockContext) => {
      let messageQueuedCount = 0;
      let sailsEventCount = 0;
      let decodedEventCount = 0;

      // Pass 1: Sails service events (Registry / Chat / Board).
      // Registry discovery runs before interactions so an ApplicationRegistered
      // event and a following app message in the same block can resolve.
      // Track per-block extrinsic position heuristically — we don't have a
      // direct extrinsic index from polkadot raw events without a deeper
      // join. Use indexInBlock as a proxy for deterministic row id purposes.
      const networkProgramIdLower = processorConfig.programId.toLowerCase();
      let eventIdx = 0;
      for (const event of ctx.events) {
        if (!isUserMessageSent(event)) {
          eventIdx++;
          continue;
        }
        // Replaces the old `source !== networkProgram` filter that lived in
        // processor.ts. The processor now passes UserMessageSent from every
        // program (so Strategy C in p2p_inference.ts can read replies from
        // registered apps), but the Sails decoder still only knows the
        // network program's IDL — gating here keeps log output clean. If
        // you remove this gate, restore the filter at the matching site in
        // processor.ts (look for the `replyToMessageId` extraction). Co-
        // landed change.
        if (event.source !== networkProgramIdLower) {
          eventIdx++;
          continue;
        }
        if (!isSailsEvent(event)) {
          eventIdx++;
          continue;
        }
        sailsEventCount++;
        const decoded = decoder.decodeEvent(event);
        if (!decoded) {
          log.warn("undecodable sails event", {
            block: ctx.substrateBlockNumber,
            msg: event.messageId,
          });
          eventIdx++;
          continue;
        }
        decodedEventCount++;

        const hctx: HandlerContext = {
          block: ctx,
          event,
          // Proxy for extrinsic idx (no direct mapping at this adapter layer).
          extrinsicIdx: event.indexInBlock,
          eventIdx,
          programId: processorConfig.programId,
        };

        // Handler errors MUST propagate so the processor can bail without
        // advancing the cursor (review finding #2). Retry happens on the next
        // finalized-head tick, gated idempotently by deterministic row ids +
        // event_processed dedup for metric bumps.
        if (decoded.service === "Registry") {
          switch (decoded.event) {
            case "ParticipantRegistered":
              await handleParticipantRegistered(db, hctx, decoded.payload as never);
              break;
            case "ApplicationRegistered":
              await handleApplicationRegistered(db, hctx, decoded.payload as never);
              break;
            case "ApplicationUpdated":
              await handleApplicationUpdated(db, hctx, decoded.payload as never);
              break;
            case "ApplicationSubmitted":
              await handleApplicationSubmitted(db, hctx, decoded.payload as never);
              break;
            default:
              log.debug("unhandled registry event", { event: decoded.event });
          }
        } else if (decoded.service === "Chat") {
          switch (decoded.event) {
            case "MessagePosted":
              await handleMessagePosted(db, hctx, decoded.payload as never);
              break;
            default:
              log.debug("unhandled chat event", { event: decoded.event });
          }
        } else if (decoded.service === "Board") {
          switch (decoded.event) {
            case "IdentityCardUpdated":
              await handleIdentityCardUpdated(db, hctx, decoded.payload as never);
              break;
            case "AnnouncementPosted":
              await handleAnnouncementPosted(db, hctx, decoded.payload as never);
              break;
            case "AnnouncementEdited":
              await handleAnnouncementEdited(db, hctx, decoded.payload as never);
              break;
            case "AnnouncementArchived":
              await handleAnnouncementArchived(db, hctx, decoded.payload as never);
              break;
            default:
              log.debug("unhandled board event", { event: decoded.event });
          }
        } else {
          if (decoded.service === "Admin") {
            switch (decoded.event) {
              case "ApplicationStatusChanged":
                await handleApplicationStatusChanged(db, hctx, decoded.payload as never);
                break;
              default:
                log.debug("unhandled admin event", { event: decoded.event });
            }
          } else {
            log.warn("unknown service", { service: decoded.service });
          }
        }
        eventIdx++;
      }

      // Pass 2: Gear.MessageQueued → interactions (cross-program call log).
      // Drives the Top Integrators leaderboard and app-to-app graph.
      for (const event of ctx.events) {
        if (!isMessageQueued(event)) continue;
        messageQueuedCount++;
        await handleMessageQueued(db, {
          block: ctx,
          event,
          extrinsicIdx: event.indexInBlock,
          eventIdx: event.indexInBlock,
          programId: processorConfig.programId,
        });
      }

      // Single pass over ctx.events to build the three block-scoped sets the
      // P2P passes need. `knownMessageIds` filters wallet-originated messages
      // out of the P2P axis (Pass 3 + Strategy C). `knownMQDestinations` and
      // `programsWithCrossBlockEdge` are Strategy A's exclusion sets.
      const blockSets = buildBlockSets(ctx.events);

      // Pass 3: ProgramMessage events synthesized by the storage-diff detector.
      // Captures program → program edges that pallet-gear does not emit as
      // events. Wallet→program messages that briefly appear in dispatches/
      // waitlist this block are filtered by `knownMessageIds` inside the
      // handler so they don't inflate the P2P axis.
      let programMessageCount = 0;
      for (const event of ctx.events) {
        if (!isProgramMessage(event)) continue;
        programMessageCount++;
        await handleProgramMessage(
          db,
          {
            block: ctx,
            event,
            extrinsicIdx: event.indexInBlock,
            eventIdx: event.indexInBlock,
            programId: processorConfig.programId,
          },
          blockSets.knownMessageIds,
        );
      }

      // Pass 4: event-only inference for intra-block P2P participation.
      // Strategy A bumps `p2p_active_blocks` for programs in
      // `MessagesDispatched.state_changes` minus the wallet-MQ and
      // cross-block-edge exclusion sets. Strategy C bumps `p2p_replies_origin`
      // when `UserMessageSent.details.to` is unknown to this block's MQ ids.
      //
      // Gated by ctx.inLiveWindow because Strategy A's cross-block exclusion
      // is empty during backfill, which would cause spurious bumps. New
      // counters intentionally start clean from live cutover.
      let participationCount = 0;
      let backtrackCount = 0;
      if (ctx.inLiveWindow !== false) {
        for (const event of ctx.events) {
          if (isMessagesDispatched(event)) {
            participationCount++;
            await handleParticipationInference(
              db,
              ctx,
              event,
              blockSets.knownMQDestinations,
              blockSets.programsWithCrossBlockEdge,
            );
          } else if (isUserMessageSent(event) && event.hasReplyDetails) {
            backtrackCount++;
            await handleUserMessageSentBacktrack(db, ctx, event, blockSets.knownMessageIds);
          }
        }
      }

      log.debug("block processed", {
        block: ctx.substrateBlockNumber,
        events: ctx.events.length,
        messageQueued: messageQueuedCount,
        programMessage: programMessageCount,
        participation: participationCount,
        backtrack: backtrackCount,
        sailsEvents: sailsEventCount,
        decodedEvents: decodedEventCount,
      });
    },
  });
  currentProcessor = processor;

  const finalizedHead = (await processor.api.rpc.chain.getFinalizedHead()).toHex();
  const latestHeader = await processor.api.rpc.chain.getHeader(finalizedHead);
  const latestHeight = latestHeader.number.toNumber();

  log.info("finalized head", { height: latestHeight });

  await processor.runBackfill(latestHeight);
  await processor.runLive();

  const rollupTasks = scheduleRollups();
  try {
    await processor.waitUntilStopped;
  } finally {
    for (const task of rollupTasks) task.stop();
    await processor.stop();
    if (currentProcessor === processor) currentProcessor = null;
  }
}

async function main() {
  process.on("unhandledRejection", (reason) => {
    log.error("unhandled rejection", { error: formatError(reason) });
  });
  process.on("uncaughtException", (err) => {
    log.error("uncaught exception", { error: formatError(err) });
  });

  // Graceful shutdown.
  const onExit = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info("shutting down");
    await currentProcessor?.stop();
    process.exit(0);
  };
  process.on("SIGINT", onExit);
  process.on("SIGTERM", onExit);

  let attempt = 0;
  while (!shuttingDown) {
    try {
      await runProcessorOnce();
      attempt = 0;
      if (!shuttingDown) {
        log.warn("processor stopped unexpectedly; restarting");
      }
    } catch (err) {
      if (shuttingDown) break;
      attempt++;
      const retryInMs = retryDelayMs(attempt);
      log.error("processor crashed; retrying", {
        attempt,
        retryInMs,
        error: formatError(err),
      });
      try {
        await currentProcessor?.stop();
      } catch (stopErr) {
        log.warn("processor stop after crash failed", { error: formatError(stopErr) });
      } finally {
        currentProcessor = null;
      }
      await sleep(retryInMs);
    }
  }
}

main().catch((err) => {
  log.error("fatal", { error: formatError(err) });
  process.exit(1);
});
