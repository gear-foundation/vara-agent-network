import type { FundingMode } from "./decision.js";

export function payoutBaseKey(
  mode: FundingMode,
  wallet: string,
  applicationId: string,
  now: Date = new Date(),
): string {
  if (mode === "initial") return `initial:${wallet}:${applicationId}`;
  return `refill:${wallet}:${applicationId}:${now.toISOString().slice(0, 10)}`;
}

export function payoutAttemptKey(baseKey: string, existingAttemptCount: number): string {
  if (existingAttemptCount <= 0) return baseKey;
  return `${baseKey}:attempt-${existingAttemptCount + 1}`;
}

export function payoutBaseKeyLike(baseKey: string): string {
  return `${baseKey}:attempt-%`;
}
