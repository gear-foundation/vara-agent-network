// Minimal leveled logger. Stdout JSON per line for easy shipping to any log
// aggregator later.
import { config } from "../config.js";

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 } as const;
type Level = keyof typeof LEVELS;

const threshold = LEVELS[config.logLevel];

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
