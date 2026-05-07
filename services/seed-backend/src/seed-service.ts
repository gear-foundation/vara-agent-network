import type pg from "pg";
import { config, varaToPlanck } from "./config.js";
import {
  pool,
  type ApplicationRow,
  type FundingDecision,
  type PayoutRow as DbPayoutRow,
  findAllocation,
  getAllocationForUpdate,
  getEligibleApplication,
  getPayoutByKey,
  inheritWalletBlockForUpdate,
  listAllocations,
  listPayouts,
  listUnfundedApplications,
  recordAudit,
  upsertAllocation,
} from "./db.js";
import { parseGithubUrl, validateGithubRepo } from "./github.js";
import { ChainClient } from "./chain.js";
import { requireAddress } from "./address.js";
import { log } from "./logger.js";
import { planPayout, type PayoutPolicy } from "./decision.js";
import { payoutAttemptKey, payoutBaseKey, payoutBaseKeyLike } from "./payout-key.js";

const INITIAL_TARGET = varaToPlanck(config.initialTargetVara);
const REFILL_TARGET = varaToPlanck(config.refillTargetVara);
const REFILL_TRIGGER_BALANCE = varaToPlanck(config.refillTriggerBalanceVara);
const DAILY_CAP = varaToPlanck(config.maxDailyRefillVara);
const GLOBAL_DAILY_CAP = varaToPlanck(config.globalDailyPayoutLimitVara);
const LIFETIME_CAP_APP = varaToPlanck(config.lifetimeCapAppVara);
const LIFETIME_CAP_WALLET = varaToPlanck(config.lifetimeCapWalletVara);
const LIFETIME_CAP_GITHUB = varaToPlanck(config.lifetimeCapGithubVara);
const LIFETIME_CAP_REPO = varaToPlanck(config.lifetimeCapRepoVara);
const PAYOUT_POLICY: PayoutPolicy = {
  initialTarget: INITIAL_TARGET,
  refillTarget: REFILL_TARGET,
  refillTriggerBalance: REFILL_TRIGGER_BALANCE,
  walletDailyCap: DAILY_CAP,
  globalDailyCap: GLOBAL_DAILY_CAP,
  lifetimeCapApp: LIFETIME_CAP_APP,
  lifetimeCapWallet: LIFETIME_CAP_WALLET,
  lifetimeCapGithub: LIFETIME_CAP_GITHUB,
  lifetimeCapRepo: LIFETIME_CAP_REPO,
  minRefillIntervalMs: config.minRefillIntervalSec * 1000,
};

export class SeedService {
  constructor(private readonly chain: ChainClient) {}

  async claim(applicationId: string): Promise<FundingDecision> {
    return this.fund(applicationId, "initial");
  }

  async refill(applicationId: string): Promise<FundingDecision> {
    return this.fund(applicationId, "refill");
  }

  async scan(limit = 100): Promise<FundingDecision[]> {
    const apps = await listUnfundedApplications(limit);
    const results: FundingDecision[] = [];
    for (const app of apps) {
      try {
        results.push(await this.fundApplication(app, "initial"));
      } catch (error) {
        log.warn("seed scan failed for app", { app: app.id, error: String(error) });
      }
    }
    return results;
  }

  async autoRefillScan(limit = 500): Promise<FundingDecision[]> {
    const allocations = await listAllocations();
    const results: FundingDecision[] = [];
    for (const allocation of allocations.slice(0, limit)) {
      if (allocation.state !== "active" || BigInt(allocation.total_funded_raw) <= 0n) continue;
      try {
        results.push(await this.refill(allocation.application_id));
      } catch (error) {
        log.warn("auto refill failed", {
          wallet: allocation.wallet,
          applicationId: allocation.application_id,
          error: String(error),
        });
      }
    }
    return results;
  }

  async listPayouts(status?: string): Promise<DbPayoutRow[]> {
    return listPayouts(status);
  }

  async markPayoutSent(idempotencyKey: string, txHash: string): Promise<DbPayoutRow> {
    const payout = await getPayoutByKey(idempotencyKey);
    if (!payout) throw new Error("payout not found");
    if (payout.status !== "PENDING") throw new Error(`payout is ${payout.status}, expected PENDING`);
    await markPayoutSent(
      payout.idempotency_key,
      payout.wallet,
      payout.application_id,
      BigInt(payout.amount_raw),
      txHash,
      payout.reason,
    );
    const updated = await getPayoutByKey(idempotencyKey);
    if (!updated) throw new Error("payout disappeared after mark-sent");
    await recordAudit(
      "info",
      "pending seed payout reconciled as sent",
      { idempotencyKey, txHash },
      updated.wallet,
      updated.application_id,
    );
    return updated;
  }

  async cancelPayout(idempotencyKey: string, reason: string): Promise<DbPayoutRow> {
    const payout = await getPayoutByKey(idempotencyKey);
    if (!payout) throw new Error("payout not found");
    if (payout.status !== "PENDING") throw new Error(`payout is ${payout.status}, expected PENDING`);
    await pool.query(
      `
        UPDATE seed_payouts
        SET status = 'CANCELLED', error = $2, updated_at = now()
        WHERE idempotency_key = $1 AND status = 'PENDING'
      `,
      [idempotencyKey, reason],
    );
    const updated = await getPayoutByKey(idempotencyKey);
    if (!updated) throw new Error("payout disappeared after cancellation");
    await recordAudit(
      "warn",
      "pending seed payout cancelled",
      { idempotencyKey, reason },
      updated.wallet,
      updated.application_id,
    );
    return updated;
  }

  async unblacklistWallet(walletInput: string, reason: string): Promise<number> {
    const wallet = requireAddress(walletInput, "wallet");
    const rows = await pool.query<{ application_id: string }>(
      `
        UPDATE seed_allocations
        SET state = 'active',
            suspicious_count = 0,
            risk_score = 0,
            last_reason = $2,
            updated_at = now()
        WHERE wallet = $1 AND state IN ('paused', 'blacklisted')
        RETURNING application_id
      `,
      [wallet, `manual unblock: ${reason}`],
    );

    await recordAudit(
      "warn",
      "seed wallet manually unblocked",
      { reason, affectedAllocations: rows.rows.length },
      wallet,
    );
    return rows.rows.length;
  }

  private async fund(applicationId: string, mode: "initial" | "refill"): Promise<FundingDecision> {
    const app = await getEligibleApplication(applicationId);
    if (!app) {
      return {
        status: "skipped",
        applicationId,
        wallet: "",
        amountRaw: "0",
        reason: "application is not registered",
      };
    }
    return this.fundApplication(app, mode);
  }

  private async fundApplication(app: ApplicationRow, mode: "initial" | "refill"): Promise<FundingDecision> {
    const wallet = requireAddress(app.owner, "application owner");
    const applicationId = requireAddress(app.id, "application id");

    const github = await this.githubCheck(app, wallet, applicationId);
    if (!github.ok) {
      await upsertAllocation(app, false, github.owner ?? null, github.repo ?? null);
      await recordAudit("warn", "github validation failed", { reason: github.reason }, wallet, applicationId);
      return {
        status: "skipped",
        applicationId,
        wallet,
        amountRaw: "0",
        reason: github.reason ?? "github validation failed",
      };
    }

    if (!github.owner || !github.repo) {
      throw new Error("github validation succeeded without normalized owner/repo");
    }

    await upsertAllocation(app, true, github.owner, github.repo);

    const client = await pool.connect();
    let pending:
      | { idempotencyKey: string; amount: bigint; reason: string; githubOwner: string; githubRepo: string }
      | null = null;
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(hashtext('seed-payout-global'))");
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [wallet]);
      const allocation = await getAllocationForUpdate(client, wallet, applicationId);
      if (!allocation) throw new Error("allocation row disappeared after upsert");

      await resetDailyWindowIfNeeded(client, wallet);
      await inheritWalletBlockForUpdate(client, wallet, applicationId);
      const fresh = await getAllocationForUpdate(client, wallet, applicationId);
      if (!fresh) throw new Error("allocation row disappeared after daily reset");

      const now = Date.now();
      const currentBalance = await this.chain.balanceOf(wallet);
      const totalFunded = BigInt(fresh.total_funded_raw);
      const dailyFunded = await dailyFundedForWallet(client, wallet);
      const globalDailyFunded = await payoutSum(client, "global_daily");
      const appLifetimeFunded = await payoutSum(client, "app_lifetime", { applicationId });
      const walletLifetimeFunded = await payoutSum(client, "wallet_lifetime", { wallet });
      const githubLifetimeFunded = await payoutSum(client, "github_lifetime", { githubOwner: github.owner });
      const repoLifetimeFunded = await payoutSum(client, "repo_lifetime", {
        githubOwner: github.owner,
        githubRepo: github.repo,
      });
      const plan = planPayout(
        {
          mode,
          state: fresh.state,
          nowMs: now,
          currentBalance,
          totalFunded,
          walletDailyFunded: dailyFunded,
          globalDailyFunded,
          appLifetimeFunded,
          walletLifetimeFunded,
          githubLifetimeFunded,
          repoLifetimeFunded,
          lastFundedAtMs: fresh.last_funded_at?.getTime() ?? null,
        },
        PAYOUT_POLICY,
      );

      if (plan.status !== "pay") {
        await client.query("COMMIT");
        return {
          status: plan.status === "skip" ? "skipped" : plan.status,
          applicationId,
          wallet,
          amountRaw: "0",
          reason: fresh.last_reason && plan.status !== "skip" ? fresh.last_reason : plan.reason,
        };
      }

      if (mode === "refill" && config.minRefillActivityEvents > 0 && fresh.last_funded_at) {
        const activityCount = await refillActivityCount(client, wallet, applicationId, fresh.last_funded_at);
        if (activityCount < config.minRefillActivityEvents) {
          await client.query("COMMIT");
          return {
            status: "skipped",
            applicationId,
            wallet,
            amountRaw: "0",
            reason: `not enough meaningful activity since last funding: ${activityCount}/${config.minRefillActivityEvents}`,
          };
        }
      }

      const baseKey = payoutBaseKey(mode, wallet, applicationId);
      const blockingPayout = await getBlockingPayout(client, baseKey, mode);
      if (blockingPayout) {
        await client.query("COMMIT");
        return {
          status: blockingPayout.status === "SENT" ? "funded" : "pending",
          applicationId,
          wallet,
          amountRaw: blockingPayout.amount_raw,
          reason: `payout is already ${blockingPayout.status.toLowerCase()}`,
          txHash: blockingPayout.tx_hash ?? undefined,
        };
      }
      const idempotencyKey = payoutAttemptKey(baseKey, await payoutAttemptCount(client, baseKey));

      await createPendingPayout(client, {
        idempotencyKey,
        wallet,
        applicationId,
        githubOwner: github.owner,
        githubRepo: github.repo,
        amount: plan.amount,
        reason: mode,
      });
      await client.query("COMMIT");
      pending = { idempotencyKey, amount: plan.amount, reason: mode, githubOwner: github.owner, githubRepo: github.repo };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }

    if (!pending) throw new Error("pending payout was not created");

    try {
      const txHash = await this.chain.transfer(wallet, pending.amount);
      await markPayoutSent(
        pending.idempotencyKey,
        wallet,
        applicationId,
        pending.amount,
        txHash,
        pending.reason,
      );
      await recordAudit("info", "seed funds transferred", { amountRaw: pending.amount.toString(), txHash, mode }, wallet, applicationId);
      return {
        status: "funded",
        applicationId,
        wallet,
        amountRaw: pending.amount.toString(),
        reason: mode,
        txHash,
      };
    } catch (error) {
      await recordAudit(
        "error",
        "seed payout left pending after transfer failure",
        {
          idempotencyKey: pending.idempotencyKey,
          error: error instanceof Error ? error.message : String(error),
        },
        wallet,
        applicationId,
      );
      throw error;
    }
  }

  private async githubCheck(
    app: ApplicationRow,
    wallet: string,
    applicationId: string,
  ): Promise<ReturnType<typeof parseGithubUrl>> {
    const parsed = parseGithubUrl(app.github_url);
    const allocation = await findAllocation(wallet, applicationId);
    const checkedAt = allocation?.github_checked_at?.getTime() ?? 0;
    const fresh = checkedAt > 0 && Date.now() - checkedAt < config.githubValidationTtlSec * 1000;
    if (
      parsed.ok &&
      fresh &&
      allocation?.github_ok &&
      allocation.github_owner &&
      allocation.github_repo
    ) {
      return {
        ok: true,
        owner: allocation.github_owner,
        repo: allocation.github_repo,
        normalizedUrl: parsed.normalizedUrl,
      };
    }
    return validateGithubRepo(app.github_url);
  }
}

async function resetDailyWindowIfNeeded(client: pg.PoolClient, wallet: string): Promise<void> {
  await client.query(
    `
      UPDATE seed_allocations
      SET daily_funded_raw = 0, daily_window = CURRENT_DATE, updated_at = now()
      WHERE wallet = $1 AND daily_window <> CURRENT_DATE
    `,
    [wallet],
  );
}

async function dailyFundedForWallet(client: pg.PoolClient, wallet: string): Promise<bigint> {
  const rows = await client.query<{ total: string }>(
    `
      SELECT COALESCE(sum(amount_raw), 0)::text AS total
      FROM seed_payouts
      WHERE wallet = $1
        AND status IN ('PENDING', 'SENT')
        AND created_at >= date_trunc('day', now())
    `,
    [wallet],
  );
  return BigInt(rows.rows[0]?.total ?? "0");
}

async function refillActivityCount(
  client: pg.PoolClient,
  wallet: string,
  applicationId: string,
  since: Date,
): Promise<number> {
  let interactionsCount = 0;
  const hasInteractions = await relationExists(client, "interactions");
  if (hasInteractions) {
    const rows = await client.query<{ count: string }>(
      `
        SELECT count(*)::text AS count
        FROM interactions
        WHERE substrate_block_ts >= $3
          AND (caller = $1 OR caller = $2 OR callee = $2)
      `,
      [wallet, applicationId, since.getTime().toString()],
    );
    interactionsCount = Number(rows.rows[0]?.count ?? 0);
  }

  const spendRows = await client.query<{ count: string }>(
    `
      SELECT count(*)::text AS count
      FROM seed_spend_events
      WHERE substrate_block_ts >= $2
        AND wallet = $1
        AND allowed = true
    `,
    [wallet, since],
  );
  return interactionsCount + Number(spendRows.rows[0]?.count ?? 0);
}

async function relationExists(client: pg.PoolClient, tableName: string): Promise<boolean> {
  const rows = await client.query<{ exists: boolean }>(
    `SELECT to_regclass($1) IS NOT NULL AS exists`,
    [`public.${tableName}`],
  );
  return rows.rows[0]?.exists ?? false;
}

type PayoutSumScope =
  | "global_daily"
  | "app_lifetime"
  | "wallet_lifetime"
  | "github_lifetime"
  | "repo_lifetime";

async function payoutSum(
  client: pg.PoolClient,
  scope: PayoutSumScope,
  values: { wallet?: string; applicationId?: string; githubOwner?: string; githubRepo?: string } = {},
): Promise<bigint> {
  const filters: string[] = ["status IN ('PENDING', 'SENT')"];
  const args: string[] = [];
  if (scope === "global_daily") {
    filters.push("created_at >= date_trunc('day', now())");
  }
  if (scope === "app_lifetime") {
    args.push(values.applicationId!);
    filters.push(`application_id = $${args.length}`);
  }
  if (scope === "wallet_lifetime") {
    args.push(values.wallet!);
    filters.push(`wallet = $${args.length}`);
  }
  if (scope === "github_lifetime") {
    args.push(values.githubOwner!.toLowerCase());
    filters.push(`github_owner = $${args.length}`);
  }
  if (scope === "repo_lifetime") {
    args.push(values.githubOwner!.toLowerCase(), values.githubRepo!.toLowerCase());
    filters.push(`github_owner = $${args.length - 1} AND github_repo = $${args.length}`);
  }

  const rows = await client.query<{ total: string }>(
    `SELECT COALESCE(sum(amount_raw), 0)::text AS total FROM seed_payouts WHERE ${filters.join(" AND ")}`,
    args,
  );
  return BigInt(rows.rows[0]?.total ?? "0");
}

interface PayoutRow {
  status: "PENDING" | "SENT" | "FAILED";
  amount_raw: string;
  tx_hash: string | null;
}

async function getBlockingPayout(
  client: pg.PoolClient,
  baseKey: string,
  mode: "initial" | "refill",
): Promise<PayoutRow | null> {
  const statuses = mode === "initial" ? ["PENDING", "SENT"] : ["PENDING"];
  const rows = await client.query<PayoutRow>(
    `
      SELECT status, amount_raw::text, tx_hash
      FROM seed_payouts
      WHERE (idempotency_key = $1 OR idempotency_key LIKE $2)
        AND status = ANY($3::text[])
      ORDER BY created_at DESC
      LIMIT 1
      FOR UPDATE
    `,
    [baseKey, payoutBaseKeyLike(baseKey), statuses],
  );
  return rows.rows[0] ?? null;
}

async function payoutAttemptCount(client: pg.PoolClient, baseKey: string): Promise<number> {
  const rows = await client.query<{ count: string }>(
    `
      SELECT count(*)::text AS count
      FROM seed_payouts
      WHERE idempotency_key = $1 OR idempotency_key LIKE $2
    `,
    [baseKey, payoutBaseKeyLike(baseKey)],
  );
  return Number(rows.rows[0]?.count ?? 0);
}

async function createPendingPayout(
  client: pg.PoolClient,
  payout: {
    idempotencyKey: string;
    wallet: string;
    applicationId: string;
    githubOwner: string;
    githubRepo: string;
    amount: bigint;
    reason: string;
  },
): Promise<void> {
  await client.query(
    `
      INSERT INTO seed_payouts (
        idempotency_key, status, wallet, application_id, github_owner, github_repo, amount_raw, reason
      )
      VALUES ($1, 'PENDING', $2, $3, lower($4), lower($5), $6, $7)
    `,
    [
      payout.idempotencyKey,
      payout.wallet,
      payout.applicationId,
      payout.githubOwner,
      payout.githubRepo,
      payout.amount.toString(),
      payout.reason,
    ],
  );
}

async function markPayoutSent(
  idempotencyKey: string,
  wallet: string,
  applicationId: string,
  amountRaw: bigint,
  txHash: string,
  reason: string,
): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const updated = await client.query<{ idempotency_key: string }>(
      `
        UPDATE seed_payouts
        SET status = 'SENT', tx_hash = $2, sent_at = now(), updated_at = now(), error = NULL
        WHERE idempotency_key = $1 AND status = 'PENDING'
        RETURNING idempotency_key
      `,
      [idempotencyKey, txHash],
    );
    if (updated.rows.length === 0) {
      await client.query("COMMIT");
      return;
    }

    await client.query(
      `
        INSERT INTO seed_funding_events (wallet, application_id, amount_raw, tx_hash, reason)
        VALUES ($1, $2, $3, $4, $5)
      `,
      [wallet, applicationId, amountRaw.toString(), txHash, reason],
    );
    await client.query(
      `
        UPDATE seed_allocations
        SET total_funded_raw = total_funded_raw + $3::numeric,
            daily_funded_raw = daily_funded_raw + $3::numeric,
            last_funded_at = now(),
            last_reason = $4,
            updated_at = now()
        WHERE wallet = $1 AND application_id = $2
      `,
      [wallet, applicationId, amountRaw.toString(), reason],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
