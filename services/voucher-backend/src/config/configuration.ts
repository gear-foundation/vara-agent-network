import { config } from 'dotenv';

config();

const required = (name: string): string => {
  const val = process.env[name];
  if (!val) throw new Error(`${name} is not set`);
  return val;
};

/**
 * Parse a positive integer env var with a default. Fails fast on NaN, <=0,
 * or non-integer input so a typo in `HOURLY_TRANCHE_VARA=abc` crashes the
 * boot instead of silently running with `BigInt(NaN)` at request time.
 */
const posInt = (name: string, defaultValue: string): number => {
  const raw = process.env[name] ?? defaultValue;
  const n = Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) {
    throw new Error(
      `${name} must be a positive integer (got "${raw}"). Fix the env and redeploy.`,
    );
  }
  return n;
};

/**
 * Parse a non-negative integer env var (0 is a valid sentinel for "disabled").
 * Used for the per-IP ceiling — setting `PER_IP_TRANCHES_PER_DAY=0` turns the
 * gate off for test/dev/internal environments. `reserveIpTrancheCount()`
 * checks for `ceiling <= 0` and short-circuits.
 */
const nonNegInt = (name: string, defaultValue: string): number => {
  const raw = process.env[name] ?? defaultValue;
  const n = Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < 0) {
    throw new Error(
      `${name} must be a non-negative integer (got "${raw}"). Use 0 to disable, or a positive integer.`,
    );
  }
  return n;
};

export default () => {
  const trancheIntervalSec = posInt('TRANCHE_INTERVAL_SEC', '3600');
  const trancheDurationSec = posInt('TRANCHE_DURATION_SEC', '86400');

  // Cross-field invariant: voucher lifetime must cover at least one refill
  // cycle. If duration < interval, a voucher expires on-chain before the
  // user is eligible for the next tranche — getVoucherState keeps returning
  // canTopUpNow=false and requestVoucher keeps 429-ing based on stale
  // lastRenewedAt, leaving agents unable to transact for the gap.
  if (trancheDurationSec < trancheIntervalSec) {
    throw new Error(
      `TRANCHE_DURATION_SEC (${trancheDurationSec}) must be >= TRANCHE_INTERVAL_SEC (${trancheIntervalSec}). Otherwise vouchers expire before top-up is eligible and agents get stuck.`,
    );
  }

  return {
    port: posInt('PORT', '3001'),
    database: {
      host: process.env.DB_HOST || 'localhost',
      port: posInt('DB_PORT', '5432'),
      user: required('DB_USER'),
      password: required('DB_PASSWORD'),
      name: required('DB_NAME'),
    },
    nodeUrl: required('NODE_URL'),
    voucherAccount: required('VOUCHER_ACCOUNT'),
    // Per-tranche VARA amount added on issue() and every hourly top-up.
    hourlyTrancheVara: posInt('HOURLY_TRANCHE_VARA', '500'),
    // Max tranches per IP per UTC day (second abuse gate — the only aggregate limit).
    // 40 × 500 = 20,000 VARA/day/IP at current tranche size. Set to 0 to disable.
    perIpTranchesPerDay: nonNegInt('PER_IP_TRANCHES_PER_DAY', '40'),
    // Seconds between eligible top-ups per wallet.
    trancheIntervalSec,
    // Voucher validity duration. Extended by trancheDurationSec on every top-up
    // (sliding window — voucher expires only if user abandons ≥24h).
    trancheDurationSec,
    infoApiKey: process.env.INFO_API_KEY || '',
  };
};
