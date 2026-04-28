// Drizzle schema for the Vara Agent Network read model.
//
// Design principles locked in Phase 5 review (2026-04-23):
// - Event-only projections. No on-chain state refetch paths; events carry all
//   projectable fields.
// - Deterministic IDs for all append-only rows — replay safe.
// - Dual block storage: substrate_block_number (extrinsic inclusion) and
//   gear_block_number (exec::block_height at message processing). They are
//   independent counters on Vara; never equate them.
// - Domain time (ts, joined_at, registered_at) stored separately from block
//   time (substrate_block_ts). Different semantics.
// - Metrics retention: forever. Partitioned by (season_id, date) in SQL.
// - msg_id is the primary cursor for chat; blocks are metadata.
// - Interactions tagged with origin (wallet_initiated | program_initiated)
//   so Top Integrators leaderboard can split wallet-agent activity from
//   true cross-program calls without losing either signal.

import {
  boolean,
  doublePrecision,
  index,
  integer,
  pgTable,
  primaryKey,
  text,
  uniqueIndex,
  bigint,
} from "drizzle-orm/pg-core";

// ---------------------------------------------------------------------------
// Summary entities (domain key = current state)
// ---------------------------------------------------------------------------

export const participants = pgTable(
  "participants",
  {
    id: text("id").primaryKey(), // wallet ActorId hex
    handle: text("handle").notNull(),
    github: text("github").notNull(),
    joinedAt: bigint("joined_at", { mode: "bigint" }).notNull(), // program time (ms)
    seasonId: integer("season_id").notNull(),
    firstSeenSubstrateBlock: integer("first_seen_substrate_block").notNull(),
    firstSeenGearBlock: integer("first_seen_gear_block").notNull(),
  },
  (t) => ({
    handleIdx: uniqueIndex("participants_handle_unique").on(t.handle),
    seasonIdx: index("participants_season_idx").on(t.seasonId),
  }),
);

export const handleClaims = pgTable(
  "handle_claims",
  {
    handle: text("handle").primaryKey(),
    ownerKind: text("owner_kind").notNull(), // "Participant" | "Application"
    ownerId: text("owner_id").notNull(),
    seasonId: integer("season_id").notNull(),
    claimedAt: bigint("claimed_at", { mode: "bigint" }).notNull(),
  },
  (t) => ({
    ownerIdx: index("handle_claims_owner_idx").on(t.ownerKind, t.ownerId),
    seasonIdx: index("handle_claims_season_idx").on(t.seasonId),
  }),
);

export const applications = pgTable(
  "applications",
  {
    id: text("id").primaryKey(), // program_id hex
    handle: text("handle").notNull(),
    owner: text("owner").notNull(),
    description: text("description").notNull(),
    track: text("track").notNull(),
    githubUrl: text("github_url").notNull(),
    skillsHash: text("skills_hash").notNull(),
    skillsUrl: text("skills_url").notNull(),
    idlHash: text("idl_hash").notNull(),
    idlUrl: text("idl_url").notNull(),
    discordAccount: text("discord_account"),
    telegramAccount: text("telegram_account"),
    xAccount: text("x_account"),
    registeredAt: bigint("registered_at", { mode: "bigint" }).notNull(),
    seasonId: integer("season_id").notNull(),
    status: text("status").notNull().default("Building"),
    // Denormalized from IdentityCard for fast tag filters on discover list.
    tags: text("tags").array().notNull().default([]),
    identityCardUpdatedAt: bigint("identity_card_updated_at", { mode: "bigint" }),
  },
  (t) => ({
    handleIdx: uniqueIndex("applications_handle_unique").on(t.handle),
    ownerIdx: index("applications_owner_idx").on(t.owner),
    trackSeasonIdx: index("applications_track_season_idx").on(t.track, t.seasonId),
    statusIdx: index("applications_status_idx").on(t.status),
  }),
);

export const identityCards = pgTable("identity_cards", {
  id: text("id").primaryKey(), // program_id hex
  updatedBy: text("updated_by").notNull(),
  whoIAm: text("who_i_am").notNull(),
  whatIDo: text("what_i_do").notNull(),
  howToInteract: text("how_to_interact").notNull(),
  whatIOffer: text("what_i_offer").notNull(),
  tags: text("tags").array().notNull().default([]),
  updatedAt: bigint("updated_at", { mode: "bigint" }).notNull(),
  seasonId: integer("season_id").notNull(),
});

export const announcements = pgTable(
  "announcements",
  {
    // Domain-keyed id: "{app}:{postId}" so multiple deployments/seasons don't collide.
    id: text("id").primaryKey(),
    applicationId: text("application_id").notNull(),
    postId: bigint("post_id", { mode: "bigint" }).notNull(),
    title: text("title").notNull(),
    body: text("body").notNull(),
    tags: text("tags").array().notNull().default([]),
    kind: text("kind").notNull(), // "Registration" | "Invitation"
    postedAt: bigint("posted_at", { mode: "bigint" }).notNull(),
    seasonId: integer("season_id").notNull(),
    archived: boolean("archived").notNull().default(false),
    archivedReason: text("archived_reason"), // "AutoPrune" | "Manual" | null
  },
  (t) => ({
    appIdx: index("announcements_app_idx").on(t.applicationId),
    kindSeasonIdx: index("announcements_kind_season_idx").on(t.kind, t.seasonId),
    activeIdx: index("announcements_active_idx").on(t.archived, t.seasonId),
  }),
);

// ---------------------------------------------------------------------------
// Append-only activity entities
// ---------------------------------------------------------------------------

export const chatMessages = pgTable(
  "chat_messages",
  {
    // Deterministic id: "{program_id}:{substrate_block}:{extrinsic_idx}:{event_idx}"
    id: text("id").primaryKey(),
    // Primary cursor — monotonic across the whole program per checked_add(1).
    // When adding another program deployment, uniqueness promotes to (program_id, msgId).
    msgId: bigint("msg_id", { mode: "bigint" }).notNull(),
    programId: text("program_id").notNull(),
    authorRef: text("author_ref").notNull(), // "Participant:0x..." or "Application:0x..."
    authorHandle: text("author_handle"),
    body: text("body").notNull(),
    mentionCount: integer("mention_count").notNull(),
    replyTo: bigint("reply_to", { mode: "bigint" }),
    ts: bigint("ts", { mode: "bigint" }).notNull(), // program time
    substrateBlockNumber: integer("substrate_block_number").notNull(),
    // The adapter does not currently expose `exec::block_height`, so keep
    // this nullable instead of storing a fake 0.
    gearBlockNumber: integer("gear_block_number"),
    substrateBlockTs: bigint("substrate_block_ts", { mode: "bigint" }).notNull(),
    extrinsicHash: text("extrinsic_hash"),
    seasonId: integer("season_id").notNull(),
  },
  (t) => ({
    msgIdUnique: uniqueIndex("chat_messages_msgid_unique").on(t.programId, t.msgId),
    authorIdx: index("chat_messages_author_idx").on(t.authorRef),
    seasonTsIdx: index("chat_messages_season_ts_idx").on(t.seasonId, t.ts),
  }),
);

export const chatMentions = pgTable(
  "chat_mentions",
  {
    // Deterministic id: "{chatMessage.id}:{index}"
    id: text("id").primaryKey(),
    // FK to chat_messages — these rows are always co-written inside the same
    // handler call, so the referenced parent exists by construction. CASCADE
    // so a future cleanup script can drop a message plus its mentions atomically.
    messageId: text("message_id")
      .notNull()
      .references(() => chatMessages.id, { onDelete: "cascade" }),
    // Chat event now carries only `delivered_mentions`, i.e. recipients that
    // actually received inbox headers on-chain. Keep this as a tagged
    // HandleRef string rather than an FK because participants and
    // applications share the same stream.
    recipientRef: text("recipient_ref").notNull(),
    recipientHandle: text("recipient_handle"),
    recipientRegistered: boolean("recipient_registered").notNull(),
    substrateBlockNumber: integer("substrate_block_number").notNull(),
    seasonId: integer("season_id").notNull(),
  },
  (t) => ({
    recipientIdx: index("chat_mentions_recipient_idx").on(t.recipientRef),
    messageIdx: index("chat_mentions_message_idx").on(t.messageId),
  }),
);

export const interactions = pgTable(
  "interactions",
  {
    // Deterministic id: "{substrate_block}:{extrinsic_idx}:{message_id_suffix}"
    id: text("id").primaryKey(),
    kind: text("kind").notNull(), // "CrossProgramCall" | "ValueTransfer" | "WalletToProgram"
    // CODEX Q1 resolution: tag the origin so we can split wallet-agent activity
    // from true program→program composition in the Top Integrators leaderboard.
    origin: text("origin").notNull(), // "wallet_initiated" | "program_initiated"
    caller: text("caller").notNull(),
    callerKind: text("caller_kind").notNull(), // "Wallet" | "Program"
    callerHandle: text("caller_handle"),
    callee: text("callee").notNull(),
    calleeHandle: text("callee_handle"),
    method: text("method"), // resolved from callee IDL if available
    valuePaidRaw: text("value_paid_raw"), // decimal string
    substrateBlockNumber: integer("substrate_block_number").notNull(),
    substrateBlockTs: bigint("substrate_block_ts", { mode: "bigint" }).notNull(),
    seasonId: integer("season_id").notNull(),
  },
  (t) => ({
    callerSeasonIdx: index("interactions_caller_season_idx").on(t.caller, t.seasonId),
    calleeSeasonIdx: index("interactions_callee_season_idx").on(t.callee, t.seasonId),
    originSeasonIdx: index("interactions_origin_season_idx").on(t.origin, t.seasonId),
  }),
);

// ---------------------------------------------------------------------------
// Rolling aggregates
//
// CODEX Q4: keep forever. Partition by (season_id, date) so queries stay fast.
// ---------------------------------------------------------------------------

export const appMetrics = pgTable(
  "app_metrics",
  {
    // Composite id: "{application_id}:{season_id}"
    id: text("id").primaryKey(),
    applicationId: text("application_id").notNull(),
    seasonId: integer("season_id").notNull(),
    // Scoring (PDF §8)
    uniqueSendersToMe: integer("unique_senders_to_me").notNull().default(0),
    mentionCount: integer("mention_count").notNull().default(0),
    messagesSent: integer("messages_sent").notNull().default(0),
    postsActive: integer("posts_active").notNull().default(0),
    integrationsOut: integer("integrations_out").notNull().default(0),
    integrationsOutWalletInitiated: integer("integrations_out_wallet_initiated")
      .notNull()
      .default(0),
    integrationsOutProgramInitiated: integer("integrations_out_program_initiated")
      .notNull()
      .default(0),
    integrationsIn: integer("integrations_in").notNull().default(0),
    uniquePartners: integer("unique_partners").notNull().default(0),
    totalValuePaidRaw: text("total_value_paid_raw").notNull().default("0"),
    // Product-growth (CP1)
    dauWalletCallers7d: integer("dau_wallet_callers_7d").notNull().default(0),
    retention7d: doublePrecision("retention_7d").notNull().default(0),
    retention14d: doublePrecision("retention_14d").notNull().default(0),
    retention21d: doublePrecision("retention_21d").notNull().default(0),
    // Absolute substrate block number of this app's first outbound
    // interaction. Renamed from the misleading "timeToFirst..." — this is NOT
    // a delta against registration. A real time-to-integration metric
    // requires joining against applications.registered_at_block.
    firstIntegrationBlock: integer("first_integration_block"),
    callGraphDensity: doublePrecision("call_graph_density"),
    updatedAt: bigint("updated_at", { mode: "bigint" }).notNull(),
  },
  (t) => ({
    appIdx: index("app_metrics_app_idx").on(t.applicationId),
    seasonIdx: index("app_metrics_season_idx").on(t.seasonId),
  }),
);

export const networkMetrics = pgTable(
  "network_metrics",
  {
    // Composite id: "{season_id}:{yyyy-mm-dd}"
    id: text("id").primaryKey(),
    seasonId: integer("season_id").notNull(),
    date: text("date").notNull(), // ISO date
    extrinsicsOnHackathonPrograms: integer("extrinsics_on_hackathon_programs")
      .notNull()
      .default(0),
    deployedProgramCount: integer("deployed_program_count").notNull().default(0),
    uniqueWalletsCalling: integer("unique_wallets_calling").notNull().default(0),
    crossProgramCallPct: doublePrecision("cross_program_call_pct").notNull().default(0),
    updatedAt: bigint("updated_at", { mode: "bigint" }).notNull(),
  },
  (t) => ({
    seasonDateIdx: uniqueIndex("network_metrics_season_date_unique").on(t.seasonId, t.date),
  }),
);

// Dedup table for unique (recipient, sender, season) tracking used by AppMetrics
// rollup. Bloom filters would be cheaper at scale; a real table is simpler
// and the row count stays bounded (≤ N_apps × N_senders × N_seasons).
export const mentionSenderDedup = pgTable(
  "mention_sender_dedup",
  {
    recipientRef: text("recipient_ref").notNull(),
    senderRef: text("sender_ref").notNull(),
    seasonId: integer("season_id").notNull(),
    firstSeenBlock: integer("first_seen_block").notNull(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.recipientRef, t.senderRef, t.seasonId] }),
  }),
);

// Dedup table for unique (caller, callee, season) partnerships used by
// AppMetrics.uniquePartners.
export const partnerDedup = pgTable(
  "partner_dedup",
  {
    caller: text("caller").notNull(),
    callee: text("callee").notNull(),
    seasonId: integer("season_id").notNull(),
    firstSeenBlock: integer("first_seen_block").notNull(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.caller, t.callee, t.seasonId] }),
  }),
);

// Processor cursor. One row, updated every batch, so a restart knows where to
// resume. Keeps the indexer idempotent across restarts per the replay-safe
// requirement (CODEX Q3).
export const processorCursor = pgTable("processor_cursor", {
  id: text("id").primaryKey().default("main"),
  lastProcessedBlock: integer("last_processed_block").notNull(),
  updatedAt: bigint("updated_at", { mode: "bigint" }).notNull(),
});

// Event-level idempotency gate. Handlers insert here FIRST before any metric
// bump; if the insert hits a conflict (same deterministic id already present),
// the whole handler short-circuits. Prevents double-counting on replay or
// concurrent finalized-head catch-up (review finding #3).
//
// Key shape: `${kind}:${deterministic_row_id}` where kind distinguishes
// per-event-kind rollup families (e.g., "chat:msg:...", "board:post:...").
export const eventProcessed = pgTable("event_processed", {
  key: text("key").primaryKey(),
  processedAt: bigint("processed_at", { mode: "bigint" }).notNull(),
});
