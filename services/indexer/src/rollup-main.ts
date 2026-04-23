// CLI entrypoint for the daily metrics rollup. Run via cron (external or
// in-process) or manually for a one-off date.
//
// Usage:
//   node lib/rollup-main.js                        # rolls up yesterday UTC
//   node lib/rollup-main.js --date 2026-04-23      # specific date
//   node lib/rollup-main.js --season 2             # specific season
//   node lib/rollup-main.js --date 2026-04-23 --season 2
//
// Exits 0 on success, non-zero on failure.
import { config } from "./config.js";
import { log } from "./helpers/logger.js";
import { db } from "./model/db.js";
import { runDailyRollup, todayUtc, yesterdayUtc } from "./services/metrics-rollup.js";

function parseArgs(argv: string[]): { date: string; season: number } {
  let date: string | null = null;
  let season: number | null = null;
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === "--date" && argv[i + 1]) {
      date = argv[i + 1]!;
      i++;
    } else if (k === "--season" && argv[i + 1]) {
      season = Number.parseInt(argv[i + 1]!, 10);
      i++;
    } else if (k === "--today") {
      date = todayUtc();
    }
  }
  return {
    date: date ?? yesterdayUtc(),
    season: season ?? config.seasonId,
  };
}

async function main() {
  const { date, season } = parseArgs(process.argv.slice(2));
  log.info("rollup start", { date, season });
  await runDailyRollup(db, season, date);
  log.info("rollup done", { date, season });
}

main().then(() => process.exit(0)).catch((err) => {
  log.error("rollup fatal", { error: String(err) });
  process.exit(1);
});
