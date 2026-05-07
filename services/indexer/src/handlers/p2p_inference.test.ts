// Unit tests for the event-only inference handlers.
//
// We mock `./common.js` so the tests don't need a real Postgres or Drizzle
// instance. The mocks implement the same observable contracts the handlers
// rely on:
//
//   - isFirstTimeEvent: first call with a given key returns true, every
//     subsequent call with the same key returns false (the same gate
//     semantics as the real `event_processed` ON CONFLICT DO NOTHING insert).
//   - bumpMetric: records each (appId, season, column) bump into a Map.
//   - resolveActor: looks up the seeded application set; unregistered ids
//     return isApplication: false.
//
// pg-mem was tried first but its node-pg adapter doesn't expose
// `getTypeParser`, which newer drizzle versions call. Helper-level mocks
// give us the same behavioral coverage at lower complexity.

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Hex } from "../helpers/types.js";

const SEASON = 1;

const PROG_REGISTERED: Hex = "0x1111111111111111111111111111111111111111111111111111111111111111";
const PROG_UNREGISTERED: Hex = "0x2222222222222222222222222222222222222222222222222222222222222222";
const PROG_OTHER: Hex = "0x3333333333333333333333333333333333333333333333333333333333333333";
const WALLET: Hex = "0xaaaa000000000000000000000000000000000000000000000000000000000000";

const MSG_WALLET_INITIATED: Hex = "0xdead000000000000000000000000000000000000000000000000000000000001";
const MSG_HIDDEN_PROGRAM: Hex = "0xdead000000000000000000000000000000000000000000000000000000000002";
const MSG_RESPONDER_REPLY: Hex = "0xdead000000000000000000000000000000000000000000000000000000000003";

// ---------------------------------------------------------------------------
// Mocked helpers — installed before the SUT loads.
// ---------------------------------------------------------------------------

interface BumpRecord {
  appId: string;
  seasonId: number;
  column: string;
  count: number;
}

const seenKeys = new Set<string>();
const bumpsByKey = new Map<string, BumpRecord>();
const registeredApps = new Map<string, { handle: string; seasonId: number }>();

vi.mock("./common.js", () => ({
  isFirstTimeEvent: vi.fn(async (_db: unknown, key: string) => {
    if (seenKeys.has(key)) return false;
    seenKeys.add(key);
    return true;
  }),
  bumpMetric: vi.fn(
    async (_db: unknown, appId: string, seasonId: number, column: string) => {
      const k = `${appId}:${seasonId}:${column}`;
      const existing = bumpsByKey.get(k);
      if (existing) existing.count += 1;
      else bumpsByKey.set(k, { appId, seasonId, column, count: 1 });
    },
  ),
  resolveActor: vi.fn(async (_db: unknown, id: string) => {
    const app = registeredApps.get(id);
    return {
      id,
      handle: app?.handle ?? null,
      seasonId: app?.seasonId ?? null,
      isApplication: !!app,
      isParticipant: false,
      application: app ?? null,
      participant: null,
    };
  }),
}));

// SUT loaded AFTER vi.mock so the mocks bind correctly.
const {
  buildKnownMQDestinations,
  buildKnownMessageIds,
  buildProgramsWithCrossBlockEdge,
  handleParticipationInference,
  handleUserMessageSentBacktrack,
} = await import("./p2p_inference.js");

const fakeDb = {} as never;

beforeEach(() => {
  seenKeys.clear();
  bumpsByKey.clear();
  registeredApps.clear();
  registeredApps.set(PROG_REGISTERED, { handle: "registered-app", seasonId: SEASON });
});

function blockCtx(): import("../helpers/types.js").BlockContext {
  return {
    substrateBlockNumber: 100,
    substrateBlockHash: "0xblock" as Hex,
    substrateBlockTs: 1_700_000_000_000n,
    events: [],
  };
}

function dispatched(stateChanges: Hex[]): import("../helpers/types.js").MessagesDispatchedEvent {
  return {
    kind: "MessagesDispatched",
    total: stateChanges.length + 1,
    stateChanges,
    indexInBlock: 0,
  };
}

function bumpCount(appId: string, column: string): number {
  return bumpsByKey.get(`${appId}:${SEASON}:${column}`)?.count ?? 0;
}

// ---------------------------------------------------------------------------
// Strategy A — handleParticipationInference
// ---------------------------------------------------------------------------

describe("handleParticipationInference (Strategy A)", () => {
  it("bumps p2pActiveBlocks for a state-changed program with no MQ and no cross-block edge", async () => {
    const ev = dispatched([PROG_REGISTERED]);
    await handleParticipationInference(fakeDb, blockCtx(), ev, new Set(), new Set());
    expect(bumpCount(PROG_REGISTERED, "p2pActiveBlocks")).toBe(1);
  });

  it("does NOT bump when the program is in this block's MessageQueued destinations", async () => {
    const ev = dispatched([PROG_REGISTERED]);
    const knownMQ = new Set<string>([PROG_REGISTERED]);
    await handleParticipationInference(fakeDb, blockCtx(), ev, knownMQ, new Set());
    expect(bumpCount(PROG_REGISTERED, "p2pActiveBlocks")).toBe(0);
  });

  it("does NOT bump when the program is in this block's cross-block edges", async () => {
    const ev = dispatched([PROG_REGISTERED]);
    const xBlock = new Set<string>([PROG_REGISTERED]);
    await handleParticipationInference(fakeDb, blockCtx(), ev, new Set(), xBlock);
    expect(bumpCount(PROG_REGISTERED, "p2pActiveBlocks")).toBe(0);
  });

  it("silently skips unregistered programs", async () => {
    const ev = dispatched([PROG_UNREGISTERED]);
    await handleParticipationInference(fakeDb, blockCtx(), ev, new Set(), new Set());
    expect(bumpCount(PROG_UNREGISTERED, "p2pActiveBlocks")).toBe(0);
  });

  it("REGRESSION: re-processing the same block does not double-bump", async () => {
    const ev = dispatched([PROG_REGISTERED]);
    const ctx = blockCtx();
    await handleParticipationInference(fakeDb, ctx, ev, new Set(), new Set());
    await handleParticipationInference(fakeDb, ctx, ev, new Set(), new Set());
    expect(bumpCount(PROG_REGISTERED, "p2pActiveBlocks")).toBe(1);
  });

  it("processes multiple programs in stateChanges independently", async () => {
    const ev = dispatched([PROG_REGISTERED, PROG_OTHER]);
    await handleParticipationInference(fakeDb, blockCtx(), ev, new Set(), new Set());
    expect(bumpCount(PROG_REGISTERED, "p2pActiveBlocks")).toBe(1);
    expect(bumpCount(PROG_OTHER, "p2pActiveBlocks")).toBe(0);
  });

  it("returns early when stateChanges is empty", async () => {
    const ev = dispatched([]);
    await handleParticipationInference(fakeDb, blockCtx(), ev, new Set(), new Set());
    expect(bumpsByKey.size).toBe(0);
  });

  it("uses a different gate key per (program, season, block)", async () => {
    const ev = dispatched([PROG_REGISTERED]);
    await handleParticipationInference(fakeDb, blockCtx(), ev, new Set(), new Set());
    // Same program, different block ⇒ should bump again.
    const ctx2 = { ...blockCtx(), substrateBlockNumber: 101 };
    await handleParticipationInference(fakeDb, ctx2, ev, new Set(), new Set());
    expect(bumpCount(PROG_REGISTERED, "p2pActiveBlocks")).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Strategy C — handleUserMessageSentBacktrack
// ---------------------------------------------------------------------------

function ums(opts: {
  hasReply?: boolean;
  replyTo?: Hex | null;
  source?: Hex;
  messageId?: Hex;
}): import("../helpers/types.js").UserMessageSentEvent {
  return {
    kind: "UserMessageSent",
    messageId: opts.messageId ?? MSG_RESPONDER_REPLY,
    source: opts.source ?? PROG_REGISTERED,
    destination: WALLET,
    payload: "0x" as Hex,
    value: "0",
    hasReplyDetails: opts.hasReply ?? true,
    replyToMessageId: opts.replyTo ?? null,
    indexInBlock: 0,
  };
}

describe("handleUserMessageSentBacktrack (Strategy C)", () => {
  it("bumps p2pRepliesOrigin when details.to is unknown to this block's MQ set", async () => {
    const ev = ums({ replyTo: MSG_HIDDEN_PROGRAM });
    await handleUserMessageSentBacktrack(fakeDb, blockCtx(), ev, new Set());
    expect(bumpCount(PROG_REGISTERED, "p2pRepliesOrigin")).toBe(1);
  });

  it("does NOT bump when details.to IS in the block's known MQ set", async () => {
    const ev = ums({ replyTo: MSG_WALLET_INITIATED });
    const known = new Set<string>([MSG_WALLET_INITIATED]);
    await handleUserMessageSentBacktrack(fakeDb, blockCtx(), ev, known);
    expect(bumpCount(PROG_REGISTERED, "p2pRepliesOrigin")).toBe(0);
  });

  it("does NOT bump when the source is not a registered Application", async () => {
    const ev = ums({ source: PROG_UNREGISTERED, replyTo: MSG_HIDDEN_PROGRAM });
    await handleUserMessageSentBacktrack(fakeDb, blockCtx(), ev, new Set());
    expect(bumpCount(PROG_UNREGISTERED, "p2pRepliesOrigin")).toBe(0);
  });

  it("does NOT bump when the event has no reply details", async () => {
    const ev = ums({ hasReply: false, replyTo: null });
    await handleUserMessageSentBacktrack(fakeDb, blockCtx(), ev, new Set());
    expect(bumpCount(PROG_REGISTERED, "p2pRepliesOrigin")).toBe(0);
  });

  it("does NOT bump when replyToMessageId is undefined (older-event-shape compat)", async () => {
    const ev = ums({ hasReply: true, replyTo: null });
    // Simulate older shape: hasReplyDetails true but replyToMessageId not populated.
    delete (ev as { replyToMessageId?: unknown }).replyToMessageId;
    await handleUserMessageSentBacktrack(fakeDb, blockCtx(), ev, new Set());
    expect(bumpCount(PROG_REGISTERED, "p2pRepliesOrigin")).toBe(0);
  });

  it("REGRESSION: re-processing the same UserMessageSent does not double-bump", async () => {
    const ev = ums({ replyTo: MSG_HIDDEN_PROGRAM });
    await handleUserMessageSentBacktrack(fakeDb, blockCtx(), ev, new Set());
    await handleUserMessageSentBacktrack(fakeDb, blockCtx(), ev, new Set());
    expect(bumpCount(PROG_REGISTERED, "p2pRepliesOrigin")).toBe(1);
  });

  it("different message ids bump independently", async () => {
    const ev1 = ums({ replyTo: MSG_HIDDEN_PROGRAM, messageId: MSG_RESPONDER_REPLY });
    const otherMsg: Hex = "0xdead000000000000000000000000000000000000000000000000000000000099";
    const ev2 = ums({ replyTo: MSG_HIDDEN_PROGRAM, messageId: otherMsg });
    await handleUserMessageSentBacktrack(fakeDb, blockCtx(), ev1, new Set());
    await handleUserMessageSentBacktrack(fakeDb, blockCtx(), ev2, new Set());
    expect(bumpCount(PROG_REGISTERED, "p2pRepliesOrigin")).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Set builders
// ---------------------------------------------------------------------------

describe("set builders", () => {
  it("buildKnownMQDestinations collects MessageQueued.destination", () => {
    const set = buildKnownMQDestinations([
      {
        kind: "MessageQueued",
        messageId: MSG_WALLET_INITIATED,
        source: WALLET,
        destination: PROG_REGISTERED,
        indexInBlock: 0,
      },
    ]);
    expect(set.has(PROG_REGISTERED)).toBe(true);
    expect(set.size).toBe(1);
  });

  it("buildKnownMessageIds collects MessageQueued.messageId", () => {
    const set = buildKnownMessageIds([
      {
        kind: "MessageQueued",
        messageId: MSG_WALLET_INITIATED,
        source: WALLET,
        destination: PROG_REGISTERED,
        indexInBlock: 0,
      },
    ]);
    expect(set.has(MSG_WALLET_INITIATED)).toBe(true);
  });

  it("buildProgramsWithCrossBlockEdge collects both source and destination from ProgramMessage", () => {
    const set = buildProgramsWithCrossBlockEdge([
      {
        kind: "ProgramMessage",
        messageId: MSG_HIDDEN_PROGRAM,
        source: PROG_REGISTERED,
        destination: PROG_OTHER,
        parent: null,
        replyTo: null,
        detectedVia: "dispatches_storage",
        indexInBlock: 0,
      },
    ]);
    expect(set.has(PROG_REGISTERED)).toBe(true);
    expect(set.has(PROG_OTHER)).toBe(true);
  });

  it("set builders ignore non-matching event kinds", () => {
    const events: import("../helpers/types.js").BlockContext["events"] = [
      {
        kind: "UserMessageSent",
        messageId: MSG_RESPONDER_REPLY,
        source: PROG_REGISTERED,
        destination: WALLET,
        payload: "0x",
        value: "0",
        hasReplyDetails: true,
        replyToMessageId: MSG_HIDDEN_PROGRAM,
        indexInBlock: 0,
      },
    ];
    expect(buildKnownMQDestinations(events).size).toBe(0);
    expect(buildProgramsWithCrossBlockEdge(events).size).toBe(0);
  });
});
