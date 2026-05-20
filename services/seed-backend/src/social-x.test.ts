import test from "node:test";
import assert from "node:assert/strict";

process.env.DATABASE_URL ??= "postgres://localhost/test";
process.env.SOCIAL_X_CAMPAIGN_START_ISO = "2026-05-10T00:00:00.000Z";
process.env.SOCIAL_X_BEARER_TOKEN = "test-token";
process.env.SOCIAL_X_REQUIRED_REPOST_TWEET_ID = "2054693150292144616";
process.env.SOCIAL_X_API_BASE_URL = "https://api.twitter.test/2";

const { assertRequiredRepost, parseTweetUrl } = await import("./social-x.js");

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

test("assertRequiredRepost accepts an account that reposted the campaign tweet", async () => {
  const originalFetch = globalThis.fetch;
  const calls: string[] = [];
  globalThis.fetch = async (input) => {
    const url = input.toString();
    calls.push(url);
    if (url.includes("/users/by/username/some_user")) {
      return jsonResponse({ data: { id: "user-1", username: "some_user" } });
    }
    if (url.includes("/users/user-1/retweeted_tweets")) {
      return jsonResponse({ data: [{ id: "2054693150292144616" }] });
    }
    return jsonResponse({}, 404);
  };

  try {
    const parsed = parseTweetUrl(
      `https://x.com/some_user/status/${tweetIdFor("2026-05-11T12:00:00.000Z")}`,
      new Date("2026-05-11T12:05:00.000Z"),
    );

    await assertRequiredRepost(parsed);

    assert.equal(calls.length, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("assertRequiredRepost rejects an account that did not repost the campaign tweet", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = input.toString();
    if (url.includes("/users/by/username/some_user")) {
      return jsonResponse({ data: { id: "user-1", username: "some_user" } });
    }
    if (url.includes("/users/user-1/retweeted_tweets")) {
      return jsonResponse({ data: [{ id: "2054000000000000000" }] });
    }
    return jsonResponse({}, 404);
  };

  try {
    const parsed = parseTweetUrl(
      `https://x.com/some_user/status/${tweetIdFor("2026-05-11T12:00:00.000Z")}`,
      new Date("2026-05-11T12:05:00.000Z"),
    );

    await assert.rejects(
      () => assertRequiredRepost(parsed),
      /has not reposted the required campaign post/,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}
