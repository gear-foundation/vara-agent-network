import type pg from "pg";
import { config, varaToPlanck } from "./config.js";
import {
  pool,
  type ApplicationRow,
  type FundingDecision,
  getAllocationForUpdate,
  getEligibleApplication,
  listAllocations,
  listEligibleApplications,
  recordAudit,
  upsertAllocation,
} from "./db.js";
import { validateGithubRepo } from "./github.js";
import { ChainClient } from "./chain.js";
import { requireAddress } from "./address.js";
import { log } from "./logger.js";

const INITIAL_TARGET = varaToPlanck(config.initialTargetVara);
const REFILL_TARGET = varaToPlanck(config.refillTargetVara);
const DAILY_CAP = varaToPlanck(config.maxDailyRefillVara);

export class SeedService {
  constructor(private readonly chain: ChainClient) {}

  async claim(applicationId: string): Promise<FundingDecision> {
    return this.fund(applicationId, "initial");
  }

  async refill(applicationId: string): Promise<FundingDecision> {
    return this.fund(applicationId, "refill");
  }

  async scan(limit = 100): Promise<FundingDecision[]> {
    const apps = await listEligibleApplications(limit);
    const results: FundingDecision[] = [];
    for (const app of apps) {
      try {
        const allocation = (await listAllocations(app.owner)).find(
          (row) => row.application_id === app.id.toLowerCase(),
        );
        if (allocation && BigInt(allocation.total_funded_raw) > 0n) continue;
        results.push(await this.fundApplication(app, "initial"));
      } catch (error) {
        log.warn("seed scan failed for app", { app: app.id, error: String(error) });
      }
    }
    return results;
  }

  private async fund(applicationId: string, mode: "initial" | "refill"): Promise<FundingDecision> {
    const app = await getEligibleApplication(applicationId);
    if (!app) {
      return {
        status: "skipped",
        applicationId,
        wallet: "",
        amountRaw: "0",
        reason: `application is not found or not in eligible statuses: ${config.eligibleStatuses.join(", ")}`,
      };
    }
    return this.fundApplication(app, mode);
  }

  private async fundApplication(app: ApplicationRow, mode: "initial" | "refill"): Promise<FundingDecision> {
    const wallet = requireAddress(app.owner, "application owner");
    const applicationId = requireAddress(app.id, "application id");

    const github = await validateGithubRepo(app.github_url);
    if (!github.ok) {
      await upsertAllocation(app, false);
      await recordAudit("warn", "github validation failed", { reason: github.reason }, wallet, applicationId);
      return {
        status: "skipped",
        applicationId,
        wallet,
        amountRaw: "0",
        reason: github.reason ?? "github validation failed",
      };
    }

    await upsertAllocation(app, true);

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [wallet]);
      const allocation = await getAllocationForUpdate(client, wallet, applicationId);
      if (!allocation) throw new Error("allocation row disappeared after upsert");

      if (allocation.state === "blacklisted" || allocation.state === "paused") {
        await client.query("COMMIT");
        return {
          status: allocation.state,
          applicationId,
          wallet,
          amountRaw: "0",
          reason: allocation.last_reason ?? `allocation is ${allocation.state}`,
        };
      }

      const now = Date.now();
      if (mode === "refill" && allocation.last_funded_at) {
        const next = allocation.last_funded_at.getTime() + config.minRefillIntervalSec * 1000;
        if (now < next) {
          await client.query("COMMIT");
          return {
            status: "skipped",
            applicationId,
            wallet,
            amountRaw: "0",
            reason: `refill interval has not elapsed; next eligible at ${new Date(next).toISOString()}`,
          };
        }
      }

      await resetDailyWindowIfNeeded(client, wallet);
      const fresh = await getAllocationForUpdate(client, wallet, applicationId);
      if (!fresh) throw new Error("allocation row disappeared after daily reset");

      const currentBalance = await this.chain.balanceOf(wallet);
      const totalFunded = BigInt(fresh.total_funded_raw);
      const dailyFunded = await dailyFundedForWallet(client, wallet);
      const target = totalFunded === 0n || mode === "initial" ? INITIAL_TARGET : REFILL_TARGET;
      const needed = target > currentBalance ? target - currentBalance : 0n;
      const dailyLeft = DAILY_CAP > dailyFunded ? DAILY_CAP - dailyFunded : 0n;
      const amount = minBigInt(needed, dailyLeft);

      if (amount <= 0n) {
        await client.query("COMMIT");
        return {
          status: "skipped",
          applicationId,
          wallet,
          amountRaw: "0",
          reason: needed <= 0n ? "wallet balance is already at target" : "daily funding cap reached",
        };
      }

      const txHash = await this.chain.transfer(wallet, amount);
      await recordFunding(client, wallet, applicationId, amount, txHash, mode);
      await client.query("COMMIT");

      await recordAudit("info", "seed funds transferred", { amountRaw: amount.toString(), txHash, mode }, wallet, applicationId);
      return {
        status: "funded",
        applicationId,
        wallet,
        amountRaw: amount.toString(),
        reason: mode,
        txHash,
      };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
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
      SELECT COALESCE(sum(daily_funded_raw), 0)::text AS total
      FROM seed_allocations
      WHERE wallet = $1 AND daily_window = CURRENT_DATE
    `,
    [wallet],
  );
  return BigInt(rows.rows[0]?.total ?? "0");
}

async function recordFunding(
  client: pg.PoolClient,
  wallet: string,
  applicationId: string,
  amountRaw: bigint,
  txHash: string,
  reason: string,
): Promise<void> {
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
}

function minBigInt(a: bigint, b: bigint): bigint {
  return a < b ? a : b;
}
