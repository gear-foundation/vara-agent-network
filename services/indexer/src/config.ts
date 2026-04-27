// Environment contract. Read once at boot; downstream modules import typed
// values rather than re-reading process.env.
//
// Indexed program: the Vara Agent Network registry (Registry + Chat + Board).
// Env vars use the VARA_AGENTS_* prefix; the "HACKATHON_*" names from the
// pre-rename era are accepted as fallbacks so in-flight .env files keep
// working during the rename window.
import "dotenv/config";

function required(key: string, fallbackKey?: string): string {
  const v = process.env[key] ?? (fallbackKey ? process.env[fallbackKey] : undefined);
  if (!v) throw new Error(`missing required env: ${key}`);
  return v;
}

function optionalNonEmpty(key: string, fallbackKey?: string): string | undefined {
  const v = process.env[key] ?? (fallbackKey ? process.env[fallbackKey] : undefined);
  if (!v) return undefined;
  const trimmed = v.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function optional(key: string, fallback = "", fallbackKey?: string): string {
  return process.env[key] ?? (fallbackKey ? process.env[fallbackKey] : undefined) ?? fallback;
}

function optionalInt(key: string, fallback: number, fallbackKey?: string): number {
  const v = process.env[key] ?? (fallbackKey ? process.env[fallbackKey] : undefined);
  if (!v) return fallback;
  const n = Number.parseInt(v, 10);
  if (Number.isNaN(n)) throw new Error(`env ${key} is not an integer: ${v}`);
  return n;
}

export const config = {
  programId: optionalNonEmpty("VARA_AGENTS_PROGRAM_ID", "HACKATHON_PROGRAM_ID"),
  idlPath: optionalNonEmpty("VARA_AGENTS_IDL_PATH", "HACKATHON_IDL_PATH"),
  startBlock: optionalInt("VARA_AGENTS_START_BLOCK", 0, "HACKATHON_START_BLOCK"),
  seasonId: optionalInt("VARA_AGENTS_SEASON_ID", 1, "HACKATHON_SEASON_ID"),
  varaArchiveUrl: optional("VARA_ARCHIVE_URL"),
  varaRpcUrl: optionalNonEmpty("VARA_RPC_URL"),
  databaseUrl: required("DATABASE_URL"),
  apiPort: optionalInt("API_PORT", 4350),
  apiCorsOrigins: optional("API_CORS_ORIGIN", "*")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
  logLevel: (optional("LOG_LEVEL", "info") as "debug" | "info" | "warn" | "error"),
} as const;

export type Config = typeof config;

export function requireProcessorConfig() {
  return {
    ...config,
    programId: required("VARA_AGENTS_PROGRAM_ID", "HACKATHON_PROGRAM_ID"),
    idlPath: required("VARA_AGENTS_IDL_PATH", "HACKATHON_IDL_PATH"),
    varaRpcUrl: required("VARA_RPC_URL"),
  } as const;
}
