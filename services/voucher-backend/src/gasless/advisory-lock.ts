import { DataSource, QueryRunner } from 'typeorm';

const DEFAULT_LOCK_TIMEOUT_MS = 30_000;
const DEFAULT_LOCK_RETRY_MS = 250;
const DEFAULT_IDLE_TRANSACTION_TIMEOUT_MS = 240_000;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function rollbackIfActive(qr: QueryRunner) {
  try {
    await qr.rollbackTransaction();
  } catch {
    // The connection may already have been killed by
    // idle_in_transaction_session_timeout; in that case Postgres has already
    // released the transaction-level advisory lock.
  }
}

export class AdvisoryLockTimeoutError extends Error {
  constructor(operation: string, timeoutMs: number) {
    super(`Timed out waiting for advisory lock for ${operation} after ${timeoutMs}ms`);
    this.name = 'AdvisoryLockTimeoutError';
  }
}

/**
 * Acquire a transaction-level Postgres advisory lock without letting waiters
 * occupy pooled DB connections. The transaction-level lock is released by
 * Postgres on commit, rollback, connection death, or idle-in-transaction
 * timeout, so a stuck RPC/on-chain operation cannot leave a stale session lock
 * pinned to a pooled DB connection for hours.
 */
export async function withAdvisoryLock<T>(
  dataSource: DataSource,
  [key1, key2]: [number, number],
  operation: string,
  fn: () => Promise<T>,
  options: { timeoutMs?: number; retryMs?: number; idleTransactionTimeoutMs?: number } = {},
): Promise<T> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS;
  const retryMs = options.retryMs ?? DEFAULT_LOCK_RETRY_MS;
  const idleTransactionTimeoutMs =
    options.idleTransactionTimeoutMs ?? DEFAULT_IDLE_TRANSACTION_TIMEOUT_MS;
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const qr = dataSource.createQueryRunner();
    let transactionStarted = false;

    try {
      await qr.connect();
      await qr.startTransaction();
      transactionStarted = true;
      await qr.query('SELECT set_config($1, $2, true)', [
        'idle_in_transaction_session_timeout',
        `${idleTransactionTimeoutMs}ms`,
      ]);
      const rows: Array<{ acquired: boolean }> = await qr.query(
        'SELECT pg_try_advisory_xact_lock($1, $2) AS acquired',
        [key1, key2],
      );

      if (rows[0]?.acquired) {
        try {
          const result = await fn();
          await qr.commitTransaction();
          transactionStarted = false;
          return result;
        } catch (error) {
          if (transactionStarted) {
            await rollbackIfActive(qr);
            transactionStarted = false;
          }
          throw error;
        }
      }

      await rollbackIfActive(qr);
      transactionStarted = false;
    } finally {
      if (transactionStarted) {
        await rollbackIfActive(qr);
      }
      await qr.release();
    }

    await sleep(retryMs);
  }

  throw new AdvisoryLockTimeoutError(operation, timeoutMs);
}
