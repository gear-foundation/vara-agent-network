// Environment contract. Read once at boot; downstream modules import typed
// values rather than re-reading process.env.
import "dotenv/config";

function required(key: string): string {
  const v = process.env[key];
  if (!v) throw new Error(`missing required env: ${key}`);
  return v;
}

function optional(key: string, fallback = ""): string {
  return process.env[key] ?? fallback;
}

function optionalInt(key: string, fallback: number): number {
  const v = process.env[key];
  if (!v) return fallback;
  const n = Number.parseInt(v, 10);
  if (Number.isNaN(n)) throw new Error(`env ${key} is not an integer: ${v}`);
  return n;
}

export const config = {
  hackathonProgramId: required("HACKATHON_PROGRAM_ID"),
  hackathonIdlPath: required("HACKATHON_IDL_PATH"),
  hackathonStartBlock: optionalInt("HACKATHON_START_BLOCK", 0),
  hackathonSeasonId: optionalInt("HACKATHON_SEASON_ID", 1),
  varaArchiveUrl: optional("VARA_ARCHIVE_URL"),
  varaRpcUrl: required("VARA_RPC_URL"),
  databaseUrl: required("DATABASE_URL"),
  apiPort: optionalInt("API_PORT", 4350),
  apiCorsOrigins: optional("API_CORS_ORIGIN", "*")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
  logLevel: (optional("LOG_LEVEL", "info") as "debug" | "info" | "warn" | "error"),
} as const;

export type Config = typeof config;
