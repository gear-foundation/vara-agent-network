import assert from "node:assert/strict";
import test from "node:test";
import { indexerHealth, rpcHttpUrl } from "../src/api/health.js";

test("indexer health rejects stale cursors", () => {
  assert.equal(rpcHttpUrl("wss://rpc.vara.network"), "https://rpc.vara.network/");
  assert.equal(indexerHealth(1_000, 1_100).ok, true);
  assert.equal(indexerHealth(1_101, 1_100).ok, false);
  assert.deepEqual(indexerHealth(1_000, 1_101), {
    ok: false,
    chainHead: 1_101,
    lastProcessedBlock: 1_000,
    lag: 101,
    maxLag: 100,
  });
});
