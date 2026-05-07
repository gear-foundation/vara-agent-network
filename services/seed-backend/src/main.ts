import express from "express";
import cors from "cors";
import { config, validateRuntimeConfig } from "./config.js";
import { ChainClient } from "./chain.js";
import { ensureSchema, listAllocations, pool, validateDatabaseSchema } from "./db.js";
import { SeedService } from "./seed-service.js";
import { SpendMonitor } from "./monitor.js";
import { log } from "./logger.js";
import { IndexerApplicationSync } from "./indexer-sync.js";

validateRuntimeConfig();

if (config.seedAutoMigrate) {
  await ensureSchema();
}
await validateDatabaseSchema();

const chain = new ChainClient();
await chain.connect();

const seedService = new SeedService(chain);
const applicationSync = new IndexerApplicationSync();
await applicationSync.start();
const monitor = new SpendMonitor(chain);
await monitor.start();

if (config.autoClaimIntervalSec > 0) {
  scheduleRecurring("auto claim scan", config.autoClaimIntervalSec, () => seedService.scan(500));
}

if (config.autoRefillIntervalSec > 0) {
  scheduleRecurring("auto refill scan", config.autoRefillIntervalSec, () => seedService.autoRefillScan(500));
}

const app = express();
app.use(express.json({ limit: "64kb" }));
if (config.corsOrigin) {
  app.use(cors({ origin: config.corsOrigin.split(",").map((s) => s.trim()).filter(Boolean) }));
} else {
  app.use(cors());
}

app.get("/health", async (_req, res, next) => {
  try {
    const db = await pool.query("SELECT 1 AS ok");
    res.json({
      ok: db.rows[0]?.ok === 1,
      fundingEligibility: "any_registered_application",
    });
  } catch (error) {
    next(error);
  }
});

app.get("/seed/allocations", requireApiKey, async (req, res, next) => {
  try {
    const wallet = typeof req.query.wallet === "string" ? req.query.wallet : undefined;
    res.json({ allocations: await listAllocations(wallet) });
  } catch (error) {
    next(error);
  }
});

app.get("/seed/allocations/:wallet", requireApiKey, async (req, res, next) => {
  try {
    res.json({ allocations: await listAllocations(req.params.wallet) });
  } catch (error) {
    next(error);
  }
});

app.get("/seed/payouts", requireApiKey, async (req, res, next) => {
  try {
    const status = typeof req.query.status === "string" ? req.query.status : undefined;
    res.json({ payouts: await seedService.listPayouts(status) });
  } catch (error) {
    next(error);
  }
});

app.post("/seed/claim", requireApiKey, async (req, res, next) => {
  try {
    const applicationId = requireApplicationId(req.body);
    res.json(await seedService.claim(applicationId));
  } catch (error) {
    next(error);
  }
});

app.post("/seed/refill", requireApiKey, async (req, res, next) => {
  try {
    const applicationId = requireApplicationId(req.body);
    res.json(await seedService.refill(applicationId));
  } catch (error) {
    next(error);
  }
});

app.post("/seed/scan", requireApiKey, async (req, res, next) => {
  try {
    const limit = Number.isInteger(req.body?.limit) ? Number(req.body.limit) : 100;
    res.json({ results: await seedService.scan(Math.max(1, Math.min(limit, 500))) });
  } catch (error) {
    next(error);
  }
});

app.post("/seed/sync-applications", requireApiKey, async (_req, res, next) => {
  try {
    res.json(await applicationSync.sync());
  } catch (error) {
    next(error);
  }
});

app.post("/seed/refill-scan", requireApiKey, async (req, res, next) => {
  try {
    const limit = Number.isInteger(req.body?.limit) ? Number(req.body.limit) : 500;
    res.json({ results: await seedService.autoRefillScan(Math.max(1, Math.min(limit, 500))) });
  } catch (error) {
    next(error);
  }
});

app.post("/seed/payouts/:idempotencyKey/mark-sent", requireApiKey, async (req, res, next) => {
  try {
    const txHash = requireString(req.body, "txHash");
    res.json({ payout: await seedService.markPayoutSent(req.params.idempotencyKey, txHash) });
  } catch (error) {
    next(error);
  }
});

app.post("/seed/payouts/:idempotencyKey/cancel", requireApiKey, async (req, res, next) => {
  try {
    const reason = requireString(req.body, "reason");
    res.json({ payout: await seedService.cancelPayout(req.params.idempotencyKey, reason) });
  } catch (error) {
    next(error);
  }
});

app.post("/seed/allocations/:wallet/unblacklist", requireApiKey, async (req, res, next) => {
  try {
    const reason = requireString(req.body, "reason");
    const affectedAllocations = await seedService.unblacklistWallet(req.params.wallet, reason);
    res.json({ affectedAllocations });
  } catch (error) {
    next(error);
  }
});

app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  const message = error instanceof Error ? error.message : String(error);
  log.error("request failed", error);
  res.status(500).json({ error: message });
});

app.listen(config.port, () => {
  log.info("seed backend listening", { port: config.port });
});

function requireApiKey(req: express.Request, res: express.Response, next: express.NextFunction): void {
  if (!config.apiKey) {
    next();
    return;
  }
  const token = req.header("authorization")?.replace(/^Bearer\s+/i, "");
  if (token !== config.apiKey) {
    res.status(401).json({ error: "unauthorized" });
    return;
  }
  next();
}

function requireApplicationId(body: unknown): string {
  if (!body || typeof body !== "object") throw new Error("request body is required");
  const value = (body as { applicationId?: unknown }).applicationId;
  if (typeof value !== "string" || !value.startsWith("0x")) {
    throw new Error("applicationId must be a hex ActorId");
  }
  return value;
}

function requireString(body: unknown, field: string): string {
  if (!body || typeof body !== "object") throw new Error("request body is required");
  const value = (body as Record<string, unknown>)[field];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${field} must be a non-empty string`);
  }
  return value.trim();
}

function scheduleRecurring<T>(name: string, intervalSec: number, task: () => Promise<T>): void {
  let running = false;
  const run = async () => {
    if (running) return;
    running = true;
    try {
      const result = await task();
      if (Array.isArray(result)) {
        log.info(`${name} completed`, { results: result.length });
      }
    } catch (error) {
      log.error(`${name} failed`, error);
    } finally {
      running = false;
    }
  };
  run().catch((error) => log.error(`${name} failed`, error));
  setInterval(() => {
    run().catch((error) => log.error(`${name} failed`, error));
  }, intervalSec * 1000);
}
