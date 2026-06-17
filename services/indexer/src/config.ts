// Environment contract. Read once at boot; downstream modules import typed
// values rather than re-reading process.env.
//
// Indexed program: the Vara Agent Network registry (Registry + Chat + Board).
// Env vars use the VARA_AGENTS_* prefix; the "HACKATHON_*" names from the
// pre-rename era remain supported as fallbacks for existing deployments.
import "dotenv/config";

export const DEFAULT_VARA_AGENTS_PROGRAM_ID =
  "0xfc81d96a92dd5caddaf215beef6765608978753c8bbfa8bad8633c83130906b6";
export const PREVIOUS_V2_VARA_AGENTS_PROGRAM_ID =
  "0x99a8f878745e785ee6af4a59a8f1912e67e19259a35c71e6bf55861a1348251e";
export const V2_CUTOVER_REPLAY_CURSOR_BLOCK = 33754148;

const RETIRED_VARA_AGENTS_PROGRAM_IDS = new Set([
  "0x19f27f4c906a5ac230be82d907850d44c7a7fff1b4c6903f62e78e09e0b353f3",
  PREVIOUS_V2_VARA_AGENTS_PROGRAM_ID,
]);

export function activeVaraAgentsProgramId(value: string): string;
export function activeVaraAgentsProgramId(value: undefined): undefined;
export function activeVaraAgentsProgramId(value: string | undefined): string | undefined;
export function activeVaraAgentsProgramId(value: string | undefined): string | undefined {
  const candidate = value?.trim();
  if (!candidate) return candidate;
  return RETIRED_VARA_AGENTS_PROGRAM_IDS.has(candidate.toLowerCase())
    ? DEFAULT_VARA_AGENTS_PROGRAM_ID
    : candidate;
}

export function shouldReplayV2Cutover(programId: string | undefined): boolean {
  return programId?.trim().toLowerCase() === PREVIOUS_V2_VARA_AGENTS_PROGRAM_ID;
}

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
  programId: activeVaraAgentsProgramId(optionalNonEmpty("VARA_AGENTS_PROGRAM_ID", "HACKATHON_PROGRAM_ID")),
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
  processorReconnectMinMs: optionalInt("PROCESSOR_RECONNECT_MIN_MS", 5_000),
  processorReconnectMaxMs: optionalInt("PROCESSOR_RECONNECT_MAX_MS", 60_000),
  processorPrunedRpcBackfillDepth: optionalInt("PROCESSOR_PRUNED_RPC_BACKFILL_DEPTH", 0),
  processorBackfillFetchConcurrency: optionalInt("PROCESSOR_BACKFILL_FETCH_CONCURRENCY", 10),
  logLevel: (optional("LOG_LEVEL", "info") as "debug" | "info" | "warn" | "error"),
} as const;

export type Config = typeof config;

export function requireProcessorConfig() {
  const programId = activeVaraAgentsProgramId(
    required("VARA_AGENTS_PROGRAM_ID", "HACKATHON_PROGRAM_ID"),
  );

  return {
    ...config,
    programId,
    v2CutoverReplayCursorBlock: shouldReplayV2Cutover(programId)
      ? V2_CUTOVER_REPLAY_CURSOR_BLOCK
      : null,
    idlPath: required("VARA_AGENTS_IDL_PATH", "HACKATHON_IDL_PATH"),
    varaRpcUrl: required("VARA_RPC_URL"),
  } as const;
}
