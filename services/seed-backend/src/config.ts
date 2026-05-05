import dotenv from "dotenv";

dotenv.config();

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

function intEnv(name: string, fallback: string, min = 0): number {
  const raw = process.env[name] ?? fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || !Number.isInteger(value) || value < min) {
    throw new Error(`${name} must be an integer >= ${min} (got "${raw}")`);
  }
  return value;
}

function statuses(): string[] {
  return (process.env.ELIGIBLE_STATUSES ?? "Submitted,Live,Finalist,Winner")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

export const config = {
  port: intEnv("PORT", "3002", 1),
  corsOrigin: process.env.API_CORS_ORIGIN ?? "",
  apiKey: process.env.SEED_API_KEY ?? "",
  databaseUrl: required("DATABASE_URL"),
  varaRpcUrl: required("VARA_RPC_URL"),
  seedAccount: required("SEED_ACCOUNT"),
  eligibleStatuses: statuses(),
  varaDecimals: intEnv("VARA_DECIMALS", "12", 0),
  initialTargetVara: intEnv("INITIAL_TARGET_VARA", "10", 1),
  refillTargetVara: intEnv("REFILL_TARGET_VARA", "10", 1),
  maxDailyRefillVara: intEnv("MAX_DAILY_REFILL_VARA", "100", 1),
  minRefillIntervalSec: intEnv("MIN_REFILL_INTERVAL_SEC", "3600", 1),
  suspiciousPauseThresholdVara: intEnv("SUSPICIOUS_PAUSE_THRESHOLD_VARA", "5", 1),
  blacklistThreshold: intEnv("BLACKLIST_THRESHOLD", "3", 1),
  monitorStartBlock: intEnv("MONITOR_START_BLOCK", "0", 0),
  monitorPollIntervalMs: intEnv("MONITOR_POLL_INTERVAL_MS", "6000", 1000),
  githubToken: process.env.GITHUB_TOKEN ?? "",
  recentCommitDays: intEnv("RECENT_COMMIT_DAYS", "45", 1),
};

export function varaToPlanck(vara: number): bigint {
  return BigInt(vara) * 10n ** BigInt(config.varaDecimals);
}
