import test from "node:test";
import assert from "node:assert/strict";
import {
  applySpendRisk,
  isAllowedRecipient,
  mostRestrictiveAllocationState,
  planPayout,
  type PayoutInputs,
  type PayoutPolicy,
} from "./decision.js";
import { parseGithubUrl } from "./github.js";

const VARA = 1_000_000_000_000n;

const policy: PayoutPolicy = {
  initialTarget: 10n * VARA,
  refillTarget: 10n * VARA,
  refillTriggerBalance: 0n,
  walletDailyCap: 100n * VARA,
  globalDailyCap: 1_000n * VARA,
  lifetimeCapApp: 100n * VARA,
  lifetimeCapWallet: 300n * VARA,
  lifetimeCapGithub: 300n * VARA,
  lifetimeCapRepo: 100n * VARA,
  minRefillIntervalMs: 86_400_000,
};

const baseInput: PayoutInputs = {
  mode: "initial",
  state: "active",
  nowMs: Date.parse("2026-05-05T00:00:00.000Z"),
  currentBalance: 0n,
  totalFunded: 0n,
  walletDailyFunded: 0n,
  globalDailyFunded: 0n,
  appLifetimeFunded: 0n,
  walletLifetimeFunded: 0n,
  githubLifetimeFunded: 0n,
  repoLifetimeFunded: 0n,
  lastFundedAtMs: null,
};

test("initial top-up funds toward the configured initial target", () => {
  const result = planPayout(baseInput, policy);
  assert.equal(result.status, "pay");
  assert.equal(result.amount, 10n * VARA);
  assert.equal(result.reason, "initial");
});

test("initial top-up subtracts existing wallet balance", () => {
  const result = planPayout({ ...baseInput, currentBalance: 3n * VARA }, policy);
  assert.equal(result.status, "pay");
  assert.equal(result.amount, 7n * VARA);
});

test("refill cooldown blocks payout before the interval elapses", () => {
  const result = planPayout(
    {
      ...baseInput,
      mode: "refill",
      totalFunded: 10n * VARA,
      lastFundedAtMs: baseInput.nowMs - 3_600_000,
    },
    policy,
  );
  assert.equal(result.status, "skip");
  assert.match(result.reason, /refill interval has not elapsed/);
});

test("refill trigger skips payout until wallet balance drops below threshold", () => {
  const result = planPayout(
    {
      ...baseInput,
      mode: "refill",
      currentBalance: 2n * VARA,
      totalFunded: 10n * VARA,
      lastFundedAtMs: baseInput.nowMs - 90_000_000,
    },
    {
      ...policy,
      refillTriggerBalance: 2n * VARA,
    },
  );
  assert.equal(result.status, "skip");
  assert.equal(result.reason, "wallet balance is above refill trigger");
});

test("refill trigger allows top-up to refill target when below threshold", () => {
  const result = planPayout(
    {
      ...baseInput,
      mode: "refill",
      currentBalance: 1n * VARA,
      totalFunded: 10n * VARA,
      lastFundedAtMs: baseInput.nowMs - 90_000_000,
    },
    {
      ...policy,
      refillTriggerBalance: 2n * VARA,
    },
  );
  assert.equal(result.status, "pay");
  assert.equal(result.amount, 9n * VARA);
});

test("daily wallet cap limits payout amount", () => {
  const result = planPayout(
    {
      ...baseInput,
      walletDailyFunded: 95n * VARA,
    },
    policy,
  );
  assert.equal(result.status, "pay");
  assert.equal(result.amount, 5n * VARA);
});

test("lifetime app cap blocks payout", () => {
  const result = planPayout(
    {
      ...baseInput,
      appLifetimeFunded: 100n * VARA,
    },
    policy,
  );
  assert.equal(result.status, "skip");
  assert.equal(result.amount, 0n);
  assert.equal(result.reason, "lifetime app funding cap reached");
});

test("paused and blacklisted allocations cannot receive payout", () => {
  const paused = planPayout({ ...baseInput, state: "paused" }, policy);
  assert.equal(paused.status, "paused");
  assert.equal(paused.amount, 0n);

  const blacklisted = planPayout({ ...baseInput, state: "blacklisted" }, policy);
  assert.equal(blacklisted.status, "blacklisted");
  assert.equal(blacklisted.amount, 0n);
});

test("wallet block inheritance keeps the most restrictive allocation state", () => {
  assert.equal(mostRestrictiveAllocationState(["active", "paused"]), "paused");
  assert.equal(mostRestrictiveAllocationState(["active", "paused", "blacklisted"]), "blacklisted");
  assert.equal(mostRestrictiveAllocationState(["active", "active"]), "active");
});

test("GitHub URL validation accepts github.com owner/repo", () => {
  const result = parseGithubUrl("https://github.com/vara-network/vara-agent");
  assert.equal(result.ok, true);
  assert.equal(result.owner, "vara-network");
  assert.equal(result.repo, "vara-agent");
  assert.equal(result.normalizedUrl, "https://github.com/vara-network/vara-agent");
});

test("GitHub URL validation rejects non-github domains", () => {
  const result = parseGithubUrl("https://example.com/vara-network/vara-agent");
  assert.equal(result.ok, false);
  assert.equal(result.reason, "github URL must use github.com domain");
});

test("suspicious outflow over threshold pauses allocation", () => {
  const result = applySpendRisk(
    {
      allowed: false,
      amountRaw: 5n * VARA,
      currentState: "active",
      suspiciousCount: 0,
    },
    { suspiciousPauseThreshold: 5n * VARA, blacklistThreshold: 3 },
  );
  assert.equal(result.suspicious, true);
  assert.equal(result.state, "paused");
  assert.equal(result.suspiciousCount, 1);
});

test("repeated suspicious outflow blacklists allocation", () => {
  const result = applySpendRisk(
    {
      allowed: false,
      amountRaw: 1n,
      currentState: "paused",
      suspiciousCount: 2,
    },
    { suspiciousPauseThreshold: 5n * VARA, blacklistThreshold: 3 },
  );
  assert.equal(result.suspicious, true);
  assert.equal(result.state, "blacklisted");
  assert.equal(result.suspiciousCount, 3);
});

test("allowed recipient is not suspicious", () => {
  const allowedRecipients = new Set(["0xabc"]);
  assert.equal(isAllowedRecipient("0xABC", allowedRecipients), true);

  const result = applySpendRisk(
    {
      allowed: true,
      amountRaw: 100n * VARA,
      currentState: "active",
      suspiciousCount: 0,
    },
    { suspiciousPauseThreshold: 5n * VARA, blacklistThreshold: 3 },
  );
  assert.equal(result.suspicious, false);
  assert.equal(result.state, "active");
  assert.equal(result.suspiciousCount, 0);
});
