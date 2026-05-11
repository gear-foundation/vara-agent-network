import { createHash } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { signatureVerify } from "@polkadot/util-crypto";
import { config, varaToPlanck } from "./config.js";
import { pool, getParticipantByWallet, type ParticipantRow } from "./db.js";
import { requireAddress } from "./address.js";
import type { ChainClient } from "./chain.js";
import { log } from "./logger.js";

const TWITTER_EPOCH_MS = 1_288_834_974_657n;
const MAX_FUTURE_TWEET_MS = 10 * 60 * 1000;
const PAYOUT_TRANSFER_ATTEMPTS = 3;
const PAYOUT_RETRY_DELAY_MS = 2_000;
const VALID_HOSTS = new Set(["x.com", "www.x.com", "twitter.com", "www.twitter.com", "mobile.twitter.com"]);
const RESERVED_AUTHORS = new Set(["home", "i", "intent", "share", "notifications", "messages", "explore"]);

export type SocialXClaimStatus = "PENDING" | "SENT" | "FAILED";

export interface ParsedTweetUrl {
  normalizedUrl: string;
  tweetId: string;
  author: string;
  createdAt: Date;
}

export interface SocialXClaimRow {
  id: number;
  wallet: string;
  participant_handle: string;
  tweet_url: string;
  tweet_id: string;
  tweet_author: string;
  tweet_created_at: Date;
  amount_raw: string;
  status: SocialXClaimStatus;
  tx_hash: string | null;
  error: string | null;
  created_at: Date;
  updated_at: Date;
  sent_at: Date | null;
}

export class ClaimRequestError extends Error {
  readonly statusCode: number;

  constructor(message: string, statusCode = 400) {
    super(message);
    this.statusCode = statusCode;
  }
}

export function buildSocialXClaimMessage(wallet: string, tweetUrl: string): string {
  return [
    "Vara Agent Network social reward claim",
    `Wallet: ${wallet.trim()}`,
    `Tweet: ${tweetUrl.trim()}`,
    `Reward: ${config.socialXRewardVara} VARA`,
  ].join("\n");
}

export function parseTweetUrl(input: string, now = new Date()): ParsedTweetUrl {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    throw new ClaimRequestError("tweetUrl must be a valid X/Twitter URL");
  }

  if (!["https:", "http:"].includes(url.protocol) || !VALID_HOSTS.has(url.hostname.toLowerCase())) {
    throw new ClaimRequestError("tweetUrl must point to x.com or twitter.com");
  }

  const parts = url.pathname.split("/").filter(Boolean);
  if (parts.length < 3 || !["status", "statuses"].includes(parts[1])) {
    throw new ClaimRequestError("tweetUrl must look like https://x.com/<username>/status/<tweetId>");
  }

  const author = parts[0].replace(/^@/, "").toLowerCase();
  const tweetId = parts[2];
  if (!/^[a-zA-Z0-9_]{1,15}$/.test(author) || RESERVED_AUTHORS.has(author)) {
    throw new ClaimRequestError("tweet URL has an invalid X username");
  }
  if (!/^\d{10,25}$/.test(tweetId)) {
    throw new ClaimRequestError("tweet URL has an invalid tweet id");
  }

  const createdAt = tweetCreatedAtFromSnowflake(tweetId);
  if (createdAt.getTime() > now.getTime() + MAX_FUTURE_TWEET_MS) {
    throw new ClaimRequestError("tweet timestamp is in the future");
  }
  if (config.socialXCampaignStart && createdAt < config.socialXCampaignStart) {
    throw new ClaimRequestError("tweet is older than the current hackathon campaign");
  }

  return {
    normalizedUrl: `https://x.com/${author}/status/${tweetId}`,
    tweetId,
    author,
    createdAt,
  };
}

export function tweetCreatedAtFromSnowflake(tweetId: string): Date {
  const createdAtMs = (BigInt(tweetId) >> 22n) + TWITTER_EPOCH_MS;
  return new Date(Number(createdAtMs));
}

export function publicClaim(row: SocialXClaimRow | null) {
  if (!row) return null;
  return {
    status: row.status,
    wallet: row.wallet,
    participantHandle: row.participant_handle,
    tweetUrl: row.tweet_url,
    tweetId: row.tweet_id,
    tweetAuthor: row.tweet_author,
    rewardVara: config.socialXRewardVara,
    txHash: row.tx_hash,
    error: row.error,
    createdAt: row.created_at,
    sentAt: row.sent_at,
  };
}

export class SocialXClaimService {
  constructor(private readonly chain: ChainClient) {}

  async getClaim(walletInput: unknown): Promise<SocialXClaimRow | null> {
    const wallet = requireAddress(walletInput, "wallet");
    return getClaimByWallet(wallet);
  }

  async submitClaim(body: unknown, ip: string): Promise<SocialXClaimRow> {
    if (!body || typeof body !== "object") throw new ClaimRequestError("request body is required");
    const walletRaw = requireBodyString(body, "wallet");
    const tweetUrlRaw = requireBodyString(body, "tweetUrl");
    const signature = requireBodyString(body, "signature");
    const wallet = requireAddress(walletRaw, "wallet");
    const parsed = parseTweetUrl(tweetUrlRaw);
    const ipShape = ipFingerprint(ip);

    const expectedMessage = buildSocialXClaimMessage(walletRaw, tweetUrlRaw);
    const verified = signatureVerify(expectedMessage, signature, walletRaw);
    if (!verified.isValid) {
      await recordAttempt(null, {
        wallet,
        parsed,
        ipHash: ipShape.hash,
        ipSubnet: ipShape.subnet,
        outcome: "rejected",
        reason: "bad_signature",
      });
      throw new ClaimRequestError("signature does not match wallet");
    }

    const participant = await getParticipantByWallet(wallet);
    if (!participant) {
      await recordAttempt(null, {
        wallet,
        parsed,
        ipHash: ipShape.hash,
        ipSubnet: ipShape.subnet,
        outcome: "rejected",
        reason: "not_registered",
      });
      throw new ClaimRequestError("wallet is not a registered participant");
    }

    assertParticipantAge(participant);

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const existing = await getClaimByWallet(wallet, client);
      if (existing) {
        await recordAttempt(client, {
          wallet,
          parsed,
          ipHash: ipShape.hash,
          ipSubnet: ipShape.subnet,
          outcome: "duplicate",
          reason: "wallet_already_claimed",
        });
        await client.query("COMMIT");
        return existing;
      }

      await assertSubmitLimits(client, wallet, parsed, ipShape);

      const rows = await client.query<SocialXClaimRow>(
        `
          INSERT INTO social_x_claims (
            wallet, participant_handle, tweet_url, tweet_id, tweet_author, tweet_created_at,
            amount_raw, status, ip_hash, ip_subnet
          )
          VALUES (lower($1), $2, $3, $4, $5, $6, $7, 'PENDING', $8, $9)
          RETURNING id, wallet, participant_handle, tweet_url, tweet_id, tweet_author,
                    tweet_created_at, amount_raw::text, status, tx_hash, error,
                    created_at, updated_at, sent_at
        `,
        [
          wallet,
          participant.handle,
          parsed.normalizedUrl,
          parsed.tweetId,
          parsed.author,
          parsed.createdAt,
          varaToPlanck(config.socialXRewardVara).toString(),
          ipShape.hash,
          ipShape.subnet,
        ],
      );

      await recordAttempt(client, {
        wallet,
        parsed,
        ipHash: ipShape.hash,
        ipSubnet: ipShape.subnet,
        outcome: "accepted",
        reason: "queued",
      });
      await client.query("COMMIT");
      return rows.rows[0];
    } catch (error) {
      await client.query("ROLLBACK");
      if (error instanceof ClaimRequestError) {
        await recordAttempt(null, {
          wallet,
          parsed,
          ipHash: ipShape.hash,
          ipSubnet: ipShape.subnet,
          outcome: "rejected",
          reason: error.message.slice(0, 200),
        });
        throw error;
      }
      if (isPgUniqueViolation(error, "social_x_claims_tweet_id_key")) {
        await recordAttempt(null, {
          wallet,
          parsed,
          ipHash: ipShape.hash,
          ipSubnet: ipShape.subnet,
          outcome: "rejected",
          reason: "tweet_already_claimed",
        });
        throw new ClaimRequestError("this tweet was already used for a reward", 409);
      }
      if (isPgUniqueViolation(error, "social_x_claims_tweet_author_key")) {
        await recordAttempt(null, {
          wallet,
          parsed,
          ipHash: ipShape.hash,
          ipSubnet: ipShape.subnet,
          outcome: "rejected",
          reason: "x_username_already_claimed",
        });
        throw new ClaimRequestError("this X username already claimed the reward", 409);
      }
      throw error;
    } finally {
      client.release();
    }
  }

  async processQueue(limit = 10): Promise<SocialXClaimRow[]> {
    const sent: SocialXClaimRow[] = [];
    const rows = await pool.query<SocialXClaimRow>(
      `
        SELECT id, wallet, participant_handle, tweet_url, tweet_id, tweet_author,
               tweet_created_at, amount_raw::text, status, tx_hash, error,
               created_at, updated_at, sent_at
        FROM social_x_claims
        WHERE status = 'PENDING'
        ORDER BY created_at ASC
        LIMIT $1
      `,
      [Math.max(1, Math.min(limit, 50))],
    );

    for (const claim of rows.rows) {
      if (!(await hasPayoutBudget())) break;
      try {
        const txHash = await transferWithRpcRetry(this.chain, claim);
        const updated = await markClaimSent(claim.id, txHash);
        sent.push(updated);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        log.error("social X payout failed", {
          error: message,
          claimId: claim.id,
          wallet: claim.wallet,
        });
        await markClaimRetryable(claim.id, message);
      }
    }
    return sent;
  }
}

async function transferWithRpcRetry(chain: ChainClient, claim: SocialXClaimRow): Promise<string> {
  let lastError: unknown = null;
  for (let attempt = 1; attempt <= PAYOUT_TRANSFER_ATTEMPTS; attempt += 1) {
    try {
      return await chain.transfer(claim.wallet, BigInt(claim.amount_raw));
    } catch (error) {
      lastError = error;
      if (!isRetryableRpcError(error)) throw error;
      await chain.reset();
      log.warn("social X payout RPC retry", {
        claimId: claim.id,
        wallet: claim.wallet,
        attempt,
        maxAttempts: PAYOUT_TRANSFER_ATTEMPTS,
        error: error instanceof Error ? error.message : String(error),
      });
      if (attempt < PAYOUT_TRANSFER_ATTEMPTS) await delay(PAYOUT_RETRY_DELAY_MS * attempt);
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

function isRetryableRpcError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return [
    "WebSocket is not connected",
    "Failed WS Request",
    "disconnected",
    "connection",
    "ECONNRESET",
    "ETIMEDOUT",
    "timeout",
  ].some((pattern) => message.toLowerCase().includes(pattern.toLowerCase()));
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function assertSubmitLimits(
  client: PoolClient,
  wallet: string,
  parsed: ParsedTweetUrl,
  ipShape: { hash: string; subnet: string },
): Promise<void> {
  const ipHour = await countAttempts(client, "ip_hash = $1 AND created_at >= now() - interval '1 hour'", [ipShape.hash]);
  const ipDay = await countAttempts(client, "ip_hash = $1 AND created_at >= now() - interval '1 day'", [ipShape.hash]);
  const walletHour = await countAttempts(client, "wallet = lower($1) AND created_at >= now() - interval '1 hour'", [wallet]);
  const subnetDay = await countClaims(client, "ip_subnet = $1 AND created_at >= now() - interval '1 day'", [ipShape.subnet]);

  if (ipHour >= config.socialXIpAttemptsPerHour) throw new ClaimRequestError("too many claim attempts from this IP", 429);
  if (ipDay >= config.socialXIpAttemptsPerDay) throw new ClaimRequestError("daily claim attempt limit reached for this IP", 429);
  if (walletHour >= 3) throw new ClaimRequestError("too many claim attempts for this wallet", 429);
  if (subnetDay >= config.socialXSubnetClaimsPerDay) throw new ClaimRequestError("daily claim limit reached for this network", 429);

  const duplicateRows = await client.query<{ kind: string }>(
    `
      SELECT 'tweet' AS kind FROM social_x_claims WHERE tweet_id = $1
      UNION ALL
      SELECT 'author' AS kind FROM social_x_claims WHERE tweet_author = $2
      LIMIT 1
    `,
    [parsed.tweetId, parsed.author],
  );
  if (duplicateRows.rows[0]?.kind === "tweet") {
    throw new ClaimRequestError("this tweet was already used for a reward", 409);
  }
  if (duplicateRows.rows[0]?.kind === "author") {
    throw new ClaimRequestError("this X username already claimed the reward", 409);
  }
}

async function hasPayoutBudget(): Promise<boolean> {
  const rows = await pool.query<{ hour_count: string; day_count: string; day_total_raw: string }>(
    `
      SELECT
        count(*) FILTER (WHERE sent_at >= now() - interval '1 hour')::text AS hour_count,
        count(*) FILTER (WHERE sent_at >= now() - interval '1 day')::text AS day_count,
        COALESCE(sum(amount_raw) FILTER (WHERE sent_at >= now() - interval '1 day'), 0)::text AS day_total_raw
      FROM social_x_claims
      WHERE status = 'SENT'
    `,
  );
  const row = rows.rows[0];
  if (!row) return true;
  const dailyLimitRaw = varaToPlanck(config.socialXGlobalDailyLimitVara);
  return (
    Number(row.hour_count) < config.socialXMaxPayoutsPerHour &&
    Number(row.day_count) < config.socialXMaxPayoutsPerDay &&
    BigInt(row.day_total_raw) + varaToPlanck(config.socialXRewardVara) <= dailyLimitRaw
  );
}

async function getClaimByWallet(wallet: string, client: Pool | PoolClient = pool): Promise<SocialXClaimRow | null> {
  const rows = await client.query<SocialXClaimRow>(
    `
      SELECT id, wallet, participant_handle, tweet_url, tweet_id, tweet_author,
             tweet_created_at, amount_raw::text, status, tx_hash, error,
             created_at, updated_at, sent_at
      FROM social_x_claims
      WHERE wallet = lower($1)
      LIMIT 1
    `,
    [wallet],
  );
  return rows.rows[0] ?? null;
}

async function markClaimSent(id: number, txHash: string): Promise<SocialXClaimRow> {
  const rows = await pool.query<SocialXClaimRow>(
    `
      UPDATE social_x_claims
      SET status = 'SENT', tx_hash = $2, error = NULL, updated_at = now(), sent_at = now()
      WHERE id = $1 AND status = 'PENDING'
      RETURNING id, wallet, participant_handle, tweet_url, tweet_id, tweet_author,
                tweet_created_at, amount_raw::text, status, tx_hash, error,
                created_at, updated_at, sent_at
    `,
    [id, txHash],
  );
  return rows.rows[0];
}

async function markClaimRetryable(id: number, error: string): Promise<void> {
  await pool.query(
    `
      UPDATE social_x_claims
      SET error = $2, updated_at = now()
      WHERE id = $1 AND status = 'PENDING'
    `,
    [id, error.slice(0, 1000)],
  );
}

async function recordAttempt(
  client: PoolClient | null,
  attempt: {
    wallet: string | null;
    parsed: ParsedTweetUrl;
    ipHash: string;
    ipSubnet: string;
    outcome: string;
    reason: string;
  },
): Promise<void> {
  await (client ?? pool).query(
    `
      INSERT INTO social_x_claim_attempts (
        wallet, tweet_id, tweet_author, ip_hash, ip_subnet, outcome, reason
      )
      VALUES (lower($1), $2, $3, $4, $5, $6, $7)
    `,
    [
      attempt.wallet,
      attempt.parsed.tweetId,
      attempt.parsed.author,
      attempt.ipHash,
      attempt.ipSubnet,
      attempt.outcome,
      attempt.reason,
    ],
  );
}

async function countAttempts(client: PoolClient, where: string, values: unknown[]): Promise<number> {
  const rows = await client.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM social_x_claim_attempts WHERE ${where}`,
    values,
  );
  return Number(rows.rows[0]?.count ?? 0);
}

async function countClaims(client: PoolClient, where: string, values: unknown[]): Promise<number> {
  const rows = await client.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM social_x_claims WHERE ${where}`,
    values,
  );
  return Number(rows.rows[0]?.count ?? 0);
}

function assertParticipantAge(participant: ParticipantRow): void {
  const joinedAtMs = Number(BigInt(participant.joined_at));
  const ageMs = Date.now() - joinedAtMs;
  const minAgeMs = config.socialXParticipantMinAgeSec * 1000;
  if (ageMs < minAgeMs) {
    const waitSec = Math.ceil((minAgeMs - ageMs) / 1000);
    throw new ClaimRequestError(`participant must be at least ${config.socialXParticipantMinAgeSec} seconds old; try again in ${waitSec}s`, 429);
  }
}

function ipFingerprint(ip: string): { hash: string; subnet: string } {
  const value = (ip || "unknown").split(",")[0].trim().replace(/^::ffff:/, "");
  return {
    hash: createHash("sha256").update(value).digest("hex"),
    subnet: ipSubnet(value),
  };
}

function ipSubnet(ip: string): string {
  if (/^\d+\.\d+\.\d+\.\d+$/.test(ip)) {
    return ip.split(".").slice(0, 3).join(".") + ".0/24";
  }
  if (ip.includes(":")) {
    return ip.split(":").slice(0, 4).join(":") + "::/64";
  }
  return "unknown";
}

function requireBodyString(body: object, field: string): string {
  const value = (body as Record<string, unknown>)[field];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new ClaimRequestError(`${field} must be a non-empty string`);
  }
  return value.trim();
}

function isPgUniqueViolation(error: unknown, constraint: string): boolean {
  return Boolean(
    error &&
    typeof error === "object" &&
    (error as { code?: string; constraint?: string }).code === "23505" &&
    (error as { code?: string; constraint?: string }).constraint === constraint,
  );
}
