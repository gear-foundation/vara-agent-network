import test from "node:test";
import assert from "node:assert/strict";
import { normalizeAddress } from "./address.js";

test("normalizeAddress accepts codec-like objects with toString", () => {
  const codecLike = {
    toString() {
      return "0xABCDEF";
    },
  };

  assert.equal(normalizeAddress(codecLike), "0xabcdef");
});

test("normalizeAddress still rejects plain objects without a useful string value", () => {
  assert.equal(normalizeAddress({}), null);
});
