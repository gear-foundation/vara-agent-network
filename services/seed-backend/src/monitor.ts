import { config, varaToPlanck } from "./config.js";
import { ChainClient, type SpendEvent } from "./chain.js";
import { listAllowedRecipients, pool, recordAudit } from "./db.js";
import { log } from "./logger.js";
import { applySpendRisk, isAllowedRecipient } from "./decision.js";

const SUSPICIOUS_PAUSE_THRESHOLD = varaToPlanck(config.suspiciousPauseThresholdVara);

export class SpendMonitor {
  private running = false;
  private tickRunning = false;

  constructor(private readonly chain: ChainClient) {}

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    this.guardedTick().catch((error) => log.error("seed monitor initial tick failed", error));
    setInterval(() => {
      this.guardedTick().catch((error) => log.error("seed monitor tick failed", error));
    }, config.monitorPollIntervalMs);
  }

  private async guardedTick(): Promise<void> {
    if (this.tickRunning) return;
    this.tickRunning = true;
    try {
      await this.tick();
    } finally {
      this.tickRunning = false;
    }
  }

  private async tick(): Promise<void> {
    const head = await this.chain.finalizedHeight();
    const from = await this.resumePoint(head);
    if (from > head) return;

    const allowedRecipients = await listAllowedRecipients();

    for (let block = from; block <= head; block++) {
      const fundedWallets = await this.fundedWallets();
      const taintedPrograms = await this.taintedPrograms();
      const events = await this.chain.readSpendEvents(block, fundedWallets, taintedPrograms);
      for (const event of events) {
        const allowed = isAllowedRecipient(event.recipient, allowedRecipients);
        if (event.kind === "tainted_program_value") {
          await this.recordTaintedProgramSpend(event, allowed);
        } else {
          await this.recordSpend(event, allowed);
        }
      }
      await this.advanceCursor(block);
    }
  }

  private async resumePoint(finalizedHead: number): Promise<number> {
    const rows = await pool.query<{ last_processed_block: number }>(
      `SELECT last_processed_block FROM seed_monitor_cursor WHERE id = 'main'`,
    );
    if (rows.rows[0]) return rows.rows[0].last_processed_block + 1;
    const startBlock = config.monitorStartBlock === "latest"
      ? finalizedHead
      : config.monitorStartBlock;
    await pool.query(
      `
        INSERT INTO seed_monitor_cursor (id, last_processed_block)
        VALUES ('main', $1)
        ON CONFLICT (id) DO NOTHING
      `,
      [Math.max(0, startBlock - 1)],
    );
    return startBlock;
  }

  private async advanceCursor(blockNumber: number): Promise<void> {
    await pool.query(
      `
        INSERT INTO seed_monitor_cursor (id, last_processed_block, updated_at)
        VALUES ('main', $1, now())
        ON CONFLICT (id) DO UPDATE SET
          last_processed_block = EXCLUDED.last_processed_block,
          updated_at = now()
      `,
      [blockNumber],
    );
  }

  private async fundedWallets(): Promise<Set<string>> {
    const rows = await pool.query<{ wallet: string }>(
      `
        SELECT DISTINCT wallet
        FROM seed_allocations
        WHERE total_funded_raw > 0
          AND state <> 'blacklisted'
      `,
    );
    return new Set(rows.rows.map((r) => r.wallet.toLowerCase()));
  }

  private async taintedPrograms(): Promise<Set<string>> {
    const rows = await pool.query<{ program_id: string }>(
      `
        SELECT DISTINCT program_id
        FROM seed_taint_targets
        WHERE state = 'active'
      `,
    );
    return new Set(rows.rows.map((r) => r.program_id.toLowerCase()));
  }

  private async recordSpend(event: SpendEvent, allowed: boolean): Promise<void> {
    const inserted = await pool.query<{ id: string }>(
      `
        INSERT INTO seed_spend_events (
          id, wallet, recipient, amount_raw, kind, allowed,
          substrate_block_number, substrate_block_ts, extrinsic_idx, event_idx
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
        ON CONFLICT (id) DO NOTHING
        RETURNING id
      `,
      [
        event.id,
        event.wallet,
        event.recipient,
        event.amountRaw.toString(),
        event.kind,
        allowed,
        event.substrateBlockNumber,
        event.substrateBlockTs,
        event.extrinsicIdx,
        event.eventIdx,
      ],
    );
    if (inserted.rows.length === 0) return;

    if (allowed) {
      if (event.kind === "gear_value") await this.recordFundedWalletTaint(event);
      return;
    }

    await this.applySuspicion(event);
  }

  private async recordTaintedProgramSpend(event: SpendEvent, allowed: boolean): Promise<void> {
    const sourceProgram = event.sourceProgram?.toLowerCase() ?? event.wallet.toLowerCase();
    const links = await pool.query<{ source_wallet: string; source_application_id: string }>(
      `
        SELECT source_wallet, source_application_id
        FROM seed_taint_targets
        WHERE program_id = $1 AND state = 'active'
      `,
      [sourceProgram],
    );

    for (const link of links.rows) {
      const attributed: SpendEvent = {
        ...event,
        id: `${event.id}:${link.source_wallet}:${link.source_application_id}`,
        wallet: link.source_wallet,
        sourceProgram,
      };
      await this.recordSpend(attributed, allowed);
      if (allowed) {
        await this.recordTaintTarget({
          sourceWallet: link.source_wallet,
          sourceApplicationId: link.source_application_id,
          programId: event.recipient,
          amountRaw: event.amountRaw,
          event,
        });
      }
    }
  }

  private async recordFundedWalletTaint(event: SpendEvent): Promise<void> {
    const rows = await pool.query<{ application_id: string }>(
      `
        SELECT application_id
        FROM seed_allocations
        WHERE wallet = $1
          AND total_funded_raw > 0
          AND state <> 'blacklisted'
      `,
      [event.wallet],
    );

    for (const row of rows.rows) {
      await this.recordTaintTarget({
        sourceWallet: event.wallet,
        sourceApplicationId: row.application_id,
        programId: event.recipient,
        amountRaw: event.amountRaw,
        event,
      });
    }
  }

  private async recordTaintTarget(input: {
    sourceWallet: string;
    sourceApplicationId: string;
    programId: string;
    amountRaw: bigint;
    event: SpendEvent;
  }): Promise<void> {
    await pool.query(
      `
        INSERT INTO seed_taint_targets (
          source_wallet, source_application_id, program_id, amount_raw,
          first_seen_block, last_seen_block, last_event_id
        )
        VALUES ($1, $2, $3, $4, $5, $5, $6)
        ON CONFLICT (source_wallet, source_application_id, program_id) DO UPDATE SET
          amount_raw = seed_taint_targets.amount_raw + EXCLUDED.amount_raw,
          last_seen_block = EXCLUDED.last_seen_block,
          last_event_id = EXCLUDED.last_event_id,
          state = 'active',
          updated_at = now()
      `,
      [
        input.sourceWallet.toLowerCase(),
        input.sourceApplicationId.toLowerCase(),
        input.programId.toLowerCase(),
        input.amountRaw.toString(),
        input.event.substrateBlockNumber,
        input.event.id,
      ],
    );
  }

  private async applySuspicion(event: SpendEvent): Promise<void> {
    const reason = event.kind === "tainted_program_value" && event.sourceProgram
      ? `${event.kind} from tainted program ${event.sourceProgram} to non-hackathon recipient ${event.recipient}`
      : `${event.kind} to non-hackathon recipient ${event.recipient}`;

    const rows = await pool.query<{ wallet: string; application_id: string; suspicious_count: number; state: string }>(
      `
        UPDATE seed_allocations AS a
        SET suspicious_count = d.next_suspicious_count,
            risk_score = risk_score + 1,
            state = d.next_state,
            last_reason = $4,
            updated_at = now()
        FROM (
          SELECT id,
                 suspicious_count + 1 AS next_suspicious_count,
                 CASE
                   WHEN suspicious_count + 1 >= $2 THEN 'blacklisted'
                   WHEN $3::numeric >= $5::numeric THEN 'paused'
                   ELSE state
                 END AS next_state
          FROM seed_allocations
          WHERE wallet = $1 AND state <> 'blacklisted'
        ) d
        WHERE wallet = $1
          AND a.id = d.id
        RETURNING wallet, application_id, a.suspicious_count, a.state
      `,
      [
        event.wallet,
        config.blacklistThreshold,
        event.amountRaw.toString(),
        reason,
        SUSPICIOUS_PAUSE_THRESHOLD.toString(),
      ],
    );

    for (const row of rows.rows) {
      await recordAudit(
        row.state === "blacklisted" ? "error" : "warn",
        "suspicious seed spend detected",
        {
          spendEventId: event.id,
          recipient: event.recipient,
          amountRaw: event.amountRaw.toString(),
          kind: event.kind,
          state: row.state,
          suspiciousCount: row.suspicious_count,
        },
        row.wallet,
        row.application_id,
      );
    }
  }
}

export const spendRiskForTest = applySpendRisk;
