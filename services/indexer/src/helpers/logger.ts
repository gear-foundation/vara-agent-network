// Minimal leveled logger. Stdout JSON per line for easy shipping to any log
// aggregator later.
import { config } from "../config.js";

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 } as const;
type Level = keyof typeof LEVELS;

const threshold = LEVELS[config.logLevel];

export function formatError(error: unknown): Record<string, unknown> {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      stack: error.stack,
    };
  }
  if (error && typeof error === "object") {
    const record = error as Record<string, unknown>;
    return {
      name: typeof record.name === "string" ? record.name : error.constructor.name,
      message: typeof record.message === "string" ? record.message : String(error),
      type: typeof record.type === "string" ? record.type : undefined,
      code: typeof record.code === "string" || typeof record.code === "number" ? record.code : undefined,
    };
  }
  return { message: String(error) };
}

function emit(level: Level, msg: string, fields?: Record<string, unknown>): void {
  if (LEVELS[level] < threshold) return;
  const row = { ts: new Date().toISOString(), level, msg, ...fields };
  const s = JSON.stringify(row);
  if (level === "error") process.stderr.write(s + "\n");
  else process.stdout.write(s + "\n");
}

export const log = {
  debug: (m: string, f?: Record<string, unknown>) => emit("debug", m, f),
  info: (m: string, f?: Record<string, unknown>) => emit("info", m, f),
  warn: (m: string, f?: Record<string, unknown>) => emit("warn", m, f),
  error: (m: string, f?: Record<string, unknown>) => emit("error", m, f),
};
