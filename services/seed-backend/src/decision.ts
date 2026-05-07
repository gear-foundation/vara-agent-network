export type AllocationState = "active" | "paused" | "blacklisted";
export type FundingMode = "initial" | "refill";

export interface PayoutPolicy {
  initialTarget: bigint;
  refillTarget: bigint;
  refillTriggerBalance: bigint;
  walletDailyCap: bigint;
  globalDailyCap: bigint;
  lifetimeCapApp: bigint;
  lifetimeCapWallet: bigint;
  lifetimeCapGithub: bigint;
  lifetimeCapRepo: bigint;
  minRefillIntervalMs: number;
}

export interface PayoutInputs {
  mode: FundingMode;
  state: AllocationState;
  nowMs: number;
  currentBalance: bigint;
  totalFunded: bigint;
  walletDailyFunded: bigint;
  globalDailyFunded: bigint;
  appLifetimeFunded: bigint;
  walletLifetimeFunded: bigint;
  githubLifetimeFunded: bigint;
  repoLifetimeFunded: bigint;
  lastFundedAtMs: number | null;
}

export interface PayoutPlan {
  status: "pay" | "skip" | "paused" | "blacklisted";
  amount: bigint;
  reason: string;
}

export function planPayout(input: PayoutInputs, policy: PayoutPolicy): PayoutPlan {
  if (input.state === "paused") return { status: "paused", amount: 0n, reason: "allocation is paused" };
  if (input.state === "blacklisted") {
    return { status: "blacklisted", amount: 0n, reason: "allocation is blacklisted" };
  }

  if (input.mode === "refill" && input.lastFundedAtMs !== null) {
    const nextEligible = input.lastFundedAtMs + policy.minRefillIntervalMs;
    if (input.nowMs < nextEligible) {
      return {
        status: "skip",
        amount: 0n,
        reason: `refill interval has not elapsed; next eligible at ${new Date(nextEligible).toISOString()}`,
      };
    }
  }

  if (
    input.mode === "refill" &&
    policy.refillTriggerBalance > 0n &&
    input.currentBalance >= policy.refillTriggerBalance
  ) {
    return {
      status: "skip",
      amount: 0n,
      reason: "wallet balance is above refill trigger",
    };
  }

  const target = input.totalFunded === 0n || input.mode === "initial"
    ? policy.initialTarget
    : policy.refillTarget;
  const needed = target > input.currentBalance ? target - input.currentBalance : 0n;
  const walletDailyLeft = left(policy.walletDailyCap, input.walletDailyFunded);
  const globalDailyLeft = left(policy.globalDailyCap, input.globalDailyFunded);
  const appLeft = left(policy.lifetimeCapApp, input.appLifetimeFunded);
  const walletLeft = left(policy.lifetimeCapWallet, input.walletLifetimeFunded);
  const githubLeft = left(policy.lifetimeCapGithub, input.githubLifetimeFunded);
  const repoLeft = left(policy.lifetimeCapRepo, input.repoLifetimeFunded);
  const amount = minBigInt(
    needed,
    walletDailyLeft,
    globalDailyLeft,
    appLeft,
    walletLeft,
    githubLeft,
    repoLeft,
  );

  if (amount <= 0n) {
    return {
      status: "skip",
      amount: 0n,
      reason: firstCapReason([
        [needed, "wallet balance is already at target"],
        [walletDailyLeft, "daily wallet funding cap reached"],
        [globalDailyLeft, "global daily payout limit reached"],
        [appLeft, "lifetime app funding cap reached"],
        [walletLeft, "lifetime wallet funding cap reached"],
        [githubLeft, "lifetime github funding cap reached"],
        [repoLeft, "lifetime repo funding cap reached"],
      ]),
    };
  }

  return { status: "pay", amount, reason: input.mode };
}

export interface RiskPolicy {
  suspiciousPauseThreshold: bigint;
  blacklistThreshold: number;
}

export interface SpendRiskInput {
  allowed: boolean;
  amountRaw: bigint;
  currentState: AllocationState;
  suspiciousCount: number;
}

export interface SpendRiskDecision {
  suspicious: boolean;
  state: AllocationState;
  suspiciousCount: number;
}

export function mostRestrictiveAllocationState(states: AllocationState[]): AllocationState {
  if (states.includes("blacklisted")) return "blacklisted";
  if (states.includes("paused")) return "paused";
  return "active";
}

export function applySpendRisk(input: SpendRiskInput, policy: RiskPolicy): SpendRiskDecision {
  if (input.allowed || input.currentState === "blacklisted") {
    return {
      suspicious: false,
      state: input.currentState,
      suspiciousCount: input.suspiciousCount,
    };
  }

  const nextCount = input.suspiciousCount + 1;
  if (nextCount >= policy.blacklistThreshold) {
    return { suspicious: true, state: "blacklisted", suspiciousCount: nextCount };
  }
  if (input.amountRaw >= policy.suspiciousPauseThreshold) {
    return { suspicious: true, state: "paused", suspiciousCount: nextCount };
  }
  return { suspicious: true, state: input.currentState, suspiciousCount: nextCount };
}

export function isAllowedRecipient(recipient: string, allowedRecipients: Set<string>): boolean {
  return allowedRecipients.has(recipient.toLowerCase());
}

function left(cap: bigint, used: bigint): bigint {
  return cap > used ? cap - used : 0n;
}

function firstCapReason(entries: Array<[bigint, string]>): string {
  return entries.find(([amount]) => amount <= 0n)?.[1] ?? "funding cap reached";
}

function minBigInt(...values: bigint[]): bigint {
  return values.reduce((min, value) => value < min ? value : min);
}
