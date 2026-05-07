import test from "node:test";
import assert from "node:assert/strict";
import { payoutAttemptKey, payoutBaseKey } from "./payout-key.js";

test("payoutBaseKey keeps first initial payout key stable", () => {
  assert.equal(payoutBaseKey("initial", "0xwallet", "0xapp"), "initial:0xwallet:0xapp");
});

test("payoutBaseKey scopes refill key by UTC date", () => {
  const key = payoutBaseKey("refill", "0xwallet", "0xapp", new Date("2026-05-05T23:59:00.000Z"));
  assert.equal(key, "refill:0xwallet:0xapp:2026-05-05");
});

test("payoutAttemptKey uses base key for first attempt and suffix for retries", () => {
  assert.equal(payoutAttemptKey("refill:0xwallet:0xapp:2026-05-05", 0), "refill:0xwallet:0xapp:2026-05-05");
  assert.equal(
    payoutAttemptKey("refill:0xwallet:0xapp:2026-05-05", 1),
    "refill:0xwallet:0xapp:2026-05-05:attempt-2",
  );
});
