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

function boolEnv(name: string, fallback: string): boolean {
  const raw = (process.env[name] ?? fallback).toLowerCase();
  if (["1", "true", "yes", "on"].includes(raw)) return true;
  if (["0", "false", "no", "off"].includes(raw)) return false;
  throw new Error(`${name} must be a boolean value (got "${process.env[name]}")`);
}

function monitorStartBlock(): number | "latest" {
  const raw = process.env.MONITOR_START_BLOCK ?? "latest";
  if (raw.toLowerCase() === "latest") return "latest";
  const value = Number(raw);
  if (!Number.isFinite(value) || !Number.isInteger(value) || value < 0) {
    throw new Error(`MONITOR_START_BLOCK must be "latest" or an integer >= 0 (got "${raw}")`);
  }
  return value;
}

export const config = {
  port: intEnv("PORT", "3002", 1),
  corsOrigin: process.env.API_CORS_ORIGIN ?? "",
  apiKey: process.env.SEED_API_KEY ?? "",
  databaseUrl: required("DATABASE_URL"),
  seedAutoMigrate: boolEnv("SEED_AUTO_MIGRATE", "true"),
  varaRpcUrl: process.env.VARA_RPC_URL ?? "",
  seedAccount: process.env.SEED_ACCOUNT ?? "",
  varaDecimals: intEnv("VARA_DECIMALS", "12", 0),
  initialTargetVara: intEnv("INITIAL_TARGET_VARA", "500", 1),
  refillTargetVara: intEnv("REFILL_TARGET_VARA", "2000", 1),
  refillTriggerBalanceVara: intEnv("REFILL_TRIGGER_BALANCE_VARA", "0", 0),
  maxDailyRefillVara: intEnv("MAX_DAILY_REFILL_VARA", "2000", 1),
  globalDailyPayoutLimitVara: intEnv("GLOBAL_DAILY_PAYOUT_LIMIT_VARA", "40000", 1),
  lifetimeCapAppVara: intEnv("LIFETIME_CAP_APP_VARA", "2000", 1),
  lifetimeCapWalletVara: intEnv("LIFETIME_CAP_WALLET_VARA", "10000", 1),
  lifetimeCapGithubVara: intEnv("LIFETIME_CAP_GITHUB_VARA", "10000", 1),
  lifetimeCapRepoVara: intEnv("LIFETIME_CAP_REPO_VARA", "2000", 1),
  minRefillIntervalSec: intEnv("MIN_REFILL_INTERVAL_SEC", "86400", 1),
  suspiciousPauseThresholdVara: intEnv("SUSPICIOUS_PAUSE_THRESHOLD_VARA", "10", 1),
  blacklistThreshold: intEnv("BLACKLIST_THRESHOLD", "3", 1),
  monitorStartBlock: monitorStartBlock(),
  monitorPollIntervalMs: intEnv("MONITOR_POLL_INTERVAL_MS", "6000", 1000),
  githubToken: process.env.GITHUB_TOKEN ?? "",
  recentCommitDays: intEnv("RECENT_COMMIT_DAYS", "45", 1),
  githubValidationTtlSec: intEnv("GITHUB_VALIDATION_TTL_SEC", "86400", 1),
  minRefillActivityEvents: intEnv("MIN_REFILL_ACTIVITY_EVENTS", "1", 0),
  indexerGraphqlUrl: process.env.INDEXER_GRAPHQL_URL ?? "",
  applicationSyncEnabled: boolEnv(
    "APPLICATION_SYNC_ENABLED",
    process.env.NODE_ENV === "production" ? "false" : "true",
  ),
  applicationSyncIntervalSec: intEnv("APPLICATION_SYNC_INTERVAL_SEC", "300", 0),
  autoClaimIntervalSec: intEnv("AUTO_CLAIM_INTERVAL_SEC", "0", 0),
  autoRefillIntervalSec: intEnv("AUTO_REFILL_INTERVAL_SEC", "0", 0),
};

export function validateRuntimeConfig(): void {
  if (!config.varaRpcUrl) throw new Error("VARA_RPC_URL is not set");
  if (!config.seedAccount) throw new Error("SEED_ACCOUNT is not set");
  if (process.env.NODE_ENV === "production" && !config.apiKey) {
    throw new Error("SEED_API_KEY is required when NODE_ENV=production");
  }
  if (process.env.NODE_ENV === "production" && !config.githubToken) {
    throw new Error("GITHUB_TOKEN is required when NODE_ENV=production");
  }
  if (process.env.NODE_ENV === "production" && config.indexerGraphqlUrl && config.applicationSyncEnabled) {
    throw new Error("APPLICATION_SYNC_ENABLED must be false in production shared-DB mode");
  }
}

export function varaToPlanck(vara: number): bigint {
  return BigInt(vara) * 10n ** BigInt(config.varaDecimals);
}
