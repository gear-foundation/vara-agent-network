import { createHash } from 'crypto';

/**
 * Deterministic pair of int32 keys for `pg_advisory_lock(k1, k2)` —
 * 64 bits of key space from SHA-256(account). Serializes concurrent
 * work for a single wallet (request handler + cron revoke) so DB-state
 * checks are race-free. Two-key form avoids the birthday-collision DoS
 * vector of a 32-bit homemade hash at ~65k active wallets.
 */
export function getWalletLockKey(account: string): [number, number] {
  const digest = createHash('sha256').update(account).digest();
  // Read two signed int32s from the first 8 bytes. PostgreSQL advisory
  // locks accept int4 args (signed 32-bit).
  const k1 = digest.readInt32BE(0);
  const k2 = digest.readInt32BE(4);
  return [k1, k2];
}
