import test from "node:test";
import assert from "node:assert/strict";

process.env.DATABASE_URL ??= "postgres://localhost/test";
process.env.SOCIAL_X_CAMPAIGN_START_ISO = "2026-05-10T00:00:00.000Z";

const { buildSocialXClaimMessage, parseTweetUrl } = await import("./social-x.js");

const TWITTER_EPOCH_MS = 1_288_834_974_657n;

function tweetIdFor(date: string): string {
  return ((BigInt(Date.parse(date)) - TWITTER_EPOCH_MS) << 22n).toString();
}

test("parseTweetUrl normalizes X status URLs", () => {
  const tweetId = tweetIdFor("2026-05-11T12:00:00.000Z");
  const parsed = parseTweetUrl(`https://twitter.com/Some_User/status/${tweetId}?s=20`, new Date("2026-05-11T12:05:00.000Z"));

  assert.equal(parsed.author, "some_user");
  assert.equal(parsed.tweetId, tweetId);
  assert.equal(parsed.normalizedUrl, `https://x.com/some_user/status/${tweetId}`);
});

test("parseTweetUrl rejects old campaign tweets", () => {
  const tweetId = tweetIdFor("2026-05-09T12:00:00.000Z");

  assert.throws(
    () => parseTweetUrl(`https://x.com/user/status/${tweetId}`, new Date("2026-05-11T12:05:00.000Z")),
    /older than the current hackathon campaign/,
  );
});

test("buildSocialXClaimMessage is stable", () => {
  assert.equal(
    buildSocialXClaimMessage(" wallet ", " https://x.com/u/status/1 "),
    [
      "Vara Agent Network social reward claim",
      "Wallet: wallet",
      "Tweet: https://x.com/u/status/1",
      "Reward: 100 VARA",
    ].join("\n"),
  );
});
