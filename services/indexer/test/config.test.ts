import assert from "node:assert/strict";
import test from "node:test";

process.env.DATABASE_URL ??= "postgres://indexer:indexer@localhost:5433/indexer";

const {
  DEFAULT_VARA_AGENTS_PROGRAM_ID,
  V2_CUTOVER_REPLAY_CURSOR_BLOCK,
  activeVaraAgentsProgramId,
  shouldReplayV2Cutover,
} = await import("../src/config.js");

test("retired program id resolves to the v2 mainnet program", () => {
  assert.equal(
    activeVaraAgentsProgramId(
      "0x19f27f4c906a5ac230be82d907850d44c7a7fff1b4c6903f62e78e09e0b353f3",
    ),
    DEFAULT_VARA_AGENTS_PROGRAM_ID,
  );
});

test("v2 program schedules the cutover replay", () => {
  assert.equal(shouldReplayV2Cutover(DEFAULT_VARA_AGENTS_PROGRAM_ID), true);
  assert.equal(V2_CUTOVER_REPLAY_CURSOR_BLOCK, 33754148);
});

