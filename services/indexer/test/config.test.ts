import assert from "node:assert/strict";
import test from "node:test";

process.env.DATABASE_URL ??= "postgres://indexer:indexer@localhost:5433/indexer";

const {
  DEFAULT_VARA_AGENTS_PROGRAM_ID,
  V2_CUTOVER_REPLAY_CURSOR_BLOCK,
  activeVaraAgentsProgramId,
  shouldReplayV2Cutover,
} = await import("../src/config.js");

test("retired program ids resolve to the current mainnet program", () => {
  assert.equal(
    activeVaraAgentsProgramId(
      "0x19f27f4c906a5ac230be82d907850d44c7a7fff1b4c6903f62e78e09e0b353f3",
    ),
    DEFAULT_VARA_AGENTS_PROGRAM_ID,
  );
  assert.equal(
    activeVaraAgentsProgramId(
      "0x99a8f878745e785ee6af4a59a8f1912e67e19259a35c71e6bf55861a1348251e",
    ),
    DEFAULT_VARA_AGENTS_PROGRAM_ID,
  );
  assert.equal(
    activeVaraAgentsProgramId(
      "0xfc81d96a92dd5caddaf215beef6765608978753c8bbfa8bad8633c83130906b6",
    ),
    DEFAULT_VARA_AGENTS_PROGRAM_ID,
  );
});

test("current program does not schedule the old v2 cutover replay", () => {
  assert.equal(shouldReplayV2Cutover(DEFAULT_VARA_AGENTS_PROGRAM_ID), false);
  assert.equal(V2_CUTOVER_REPLAY_CURSOR_BLOCK, 33754148);
});
