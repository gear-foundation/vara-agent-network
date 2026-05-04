import { DataSource } from 'typeorm';

const DEFAULT_LOCK_TIMEOUT_MS = 30_000;
const DEFAULT_LOCK_RETRY_MS = 250;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export class AdvisoryLockTimeoutError extends Error {
  constructor(operation: string, timeoutMs: number) {
    super(`Timed out waiting for advisory lock for ${operation} after ${timeoutMs}ms`);
    this.name = 'AdvisoryLockTimeoutError';
  }
}

/**
 * Acquire a session-level Postgres advisory lock without letting waiters occupy
 * pooled DB connections. Blocking `pg_advisory_lock()` keeps one connection per
 * queued request; under slow on-chain sends that can exhaust the pool and make
 * unrelated voucher reads hang. `pg_try_advisory_lock()` lets waiters release
 * the connection between attempts.
 */
export async function withAdvisoryLock<T>(
  dataSource: DataSource,
  [key1, key2]: [number, number],
  operation: string,
  fn: () => Promise<T>,
  options: { timeoutMs?: number; retryMs?: number } = {},
): Promise<T> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS;
  const retryMs = options.retryMs ?? DEFAULT_LOCK_RETRY_MS;
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const qr = dataSource.createQueryRunner();

    try {
      await qr.connect();
      const rows: Array<{ acquired: boolean }> = await qr.query(
        'SELECT pg_try_advisory_lock($1, $2) AS acquired',
        [key1, key2],
      );

      if (rows[0]?.acquired) {
        try {
          return await fn();
        } finally {
          await qr.query('SELECT pg_advisory_unlock($1, $2)', [key1, key2]);
        }
      }
    } finally {
      await qr.release();
    }

    await sleep(retryMs);
  }

  throw new AdvisoryLockTimeoutError(operation, timeoutMs);
}
