// Processor entrypoint. Wires config → decoder → processor → handlers.
import cron from "node-cron";
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
import {
  handleApplicationRegistered,
  handleApplicationSubmitted,
  handleApplicationUpdated,
  handleParticipantRegistered,
} from "./handlers/registry.js";
import { log } from "./helpers/logger.js";
import {
  isMessageQueued,
  isSailsEvent,
  isUserMessageSent,
  type BlockContext,
} from "./helpers/types.js";
import { db } from "./model/db.js";
import { createProcessor } from "./processor.js";
import { runDailyRollup, todayUtc, yesterdayUtc } from "./services/metrics-rollup.js";

async function main() {
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
      let eventIdx = 0;
      for (const event of ctx.events) {
        if (!isUserMessageSent(event)) {
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

      log.debug("block processed", {
        block: ctx.substrateBlockNumber,
        events: ctx.events.length,
        messageQueued: messageQueuedCount,
        sailsEvents: sailsEventCount,
        decodedEvents: decodedEventCount,
      });
    },
  });

  const finalizedHead = (await processor.api.rpc.chain.getFinalizedHead()).toHex();
  const latestHeader = await processor.api.rpc.chain.getHeader(finalizedHead);
  const latestHeight = latestHeader.number.toNumber();

  log.info("finalized head", { height: latestHeight });

  await processor.runBackfill(latestHeight);
  await processor.runLive();

  // Schedule daily metrics rollup at 00:05 UTC. Covers the day that just
  // ended (yesterday UTC). Also runs a "today-so-far" rollup once per hour
  // so the stakeholder dashboard has fresh numbers throughout the day.
  // Set ENABLE_INLINE_ROLLUP_CRON=false to turn off (e.g., when using an
  // external cron / k8s CronJob instead).
  if (process.env.ENABLE_INLINE_ROLLUP_CRON !== "false") {
    cron.schedule("5 0 * * *", async () => {
      const date = yesterdayUtc();
      log.info("cron: daily rollup firing", { date });
      try {
        await runDailyRollup(db, config.seasonId, date);
      } catch (err) {
        log.error("cron: daily rollup failed", { date, error: String(err) });
      }
    }, { timezone: "UTC" });
    cron.schedule("*/15 * * * *", async () => {
      // Refresh today's rollup every 15 minutes so the live dashboard tracks
      // extrinsics/day with sub-hour latency. Idempotent.
      const date = todayUtc();
      try {
        await runDailyRollup(db, config.seasonId, date);
      } catch (err) {
        log.error("cron: hourly refresh failed", { date, error: String(err) });
      }
    }, { timezone: "UTC" });
    log.info("rollup crons scheduled", { daily: "5 0 * * * UTC", refresh: "*/15 * * * *" });
  }

  // Graceful shutdown.
  const onExit = async () => {
    log.info("shutting down");
    await processor.stop();
    process.exit(0);
  };
  process.on("SIGINT", onExit);
  process.on("SIGTERM", onExit);
}

main().catch((err) => {
  log.error("fatal", { error: String(err) });
  process.exit(1);
});
