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
  jsonb,
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

export const applicationProgramReplacements = pgTable(
  "application_program_replacements",
  {
    eventId: text("event_id").primaryKey(),
    oldProgramId: text("old_program_id").notNull(),
    newProgramId: text("new_program_id").notNull(),
    reason: text("reason").notNull(),
    replacedBy: text("replaced_by").notNull(),
    replacedAt: bigint("replaced_at", { mode: "bigint" }).notNull(),
    replacementCount: integer("replacement_count").notNull(),
    seasonId: integer("season_id").notNull(),
  },
  (t) => ({
    oldProgramIdx: index("app_program_replacements_old_idx").on(t.oldProgramId),
    newProgramIdx: index("app_program_replacements_new_idx").on(t.newProgramId),
    seasonIdx: index("app_program_replacements_season_idx").on(t.seasonId),
  }),
);

export const reviewers = pgTable(
  "reviewers",
  {
    id: text("id").primaryKey(), // "{season_id}:{reviewer}"
    reviewer: text("reviewer").notNull(),
    seasonId: integer("season_id").notNull(),
    active: boolean("active").notNull().default(true),
    updatedAt: bigint("updated_at", { mode: "bigint" }).notNull(),
  },
  (t) => ({
    activeSeasonIdx: index("reviewers_active_season_idx").on(t.seasonId, t.active),
    reviewerSeasonIdx: uniqueIndex("reviewers_reviewer_season_unique").on(t.reviewer, t.seasonId),
  }),
);

export const reviewRevisionSnapshots = pgTable(
  "review_revision_snapshots",
  {
    id: text("id").primaryKey(), // "{program_id}:{revision}"
    eventId: text("event_id").notNull(),
    programId: text("program_id").notNull(),
    owner: text("owner").notNull(),
    revision: integer("revision").notNull(),
    handle: text("handle").notNull(),
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
    submittedAt: bigint("submitted_at", { mode: "bigint" }).notNull(),
    seasonId: integer("season_id").notNull(),
  },
  (t) => ({
    appRevisionIdx: uniqueIndex("review_snapshots_app_revision_unique").on(t.programId, t.revision),
    eventIdx: uniqueIndex("review_snapshots_event_unique").on(t.eventId),
  }),
);

export const reviewRequests = pgTable(
  "review_requests",
  {
    eventId: text("event_id").primaryKey(),
    programId: text("program_id").notNull(),
    owner: text("owner").notNull(),
    revision: integer("revision").notNull(),
    reason: text("reason").notNull(),
    requestedAt: bigint("requested_at", { mode: "bigint" }).notNull(),
    seasonId: integer("season_id").notNull(),
    acknowledged: boolean("acknowledged").notNull().default(false),
    hidden: boolean("hidden").notNull().default(false),
    tombstoned: boolean("tombstoned").notNull().default(false),
  },
  (t) => ({
    appRevisionIdx: index("review_requests_app_revision_idx").on(t.programId, t.revision),
    queueIdx: index("review_requests_queue_idx").on(t.seasonId, t.acknowledged, t.hidden, t.tombstoned),
  }),
);

export const reviewComments = pgTable(
  "review_comments",
  {
    eventId: text("event_id").primaryKey(),
    programId: text("program_id").notNull(),
    revision: integer("revision").notNull(),
    author: text("author").notNull(),
    authorRole: text("author_role").notNull(),
    body: text("body").notNull(),
    ts: bigint("ts", { mode: "bigint" }).notNull(),
    seasonId: integer("season_id").notNull(),
    hidden: boolean("hidden").notNull().default(false),
    tombstoned: boolean("tombstoned").notNull().default(false),
  },
  (t) => ({
    appRevisionIdx: index("review_comments_app_revision_idx").on(t.programId, t.revision, t.eventId),
    visibleIdx: index("review_comments_visible_idx").on(t.programId, t.hidden, t.tombstoned),
  }),
);

export const reviewDecisions = pgTable(
  "review_decisions",
  {
    eventId: text("event_id").primaryKey(),
    programId: text("program_id").notNull(),
    revision: integer("revision").notNull(),
    reviewer: text("reviewer").notNull(),
    verdict: text("verdict").notNull(),
    reason: text("reason").notNull(),
    criteria: jsonb("criteria").notNull(),
    oldStatus: text("old_status").notNull(),
    newStatus: text("new_status").notNull(),
    decidedAt: bigint("decided_at", { mode: "bigint" }).notNull(),
    seasonId: integer("season_id").notNull(),
    tombstoned: boolean("tombstoned").notNull().default(false),
  },
  (t) => ({
    appRevisionIdx: index("review_decisions_app_revision_idx").on(t.programId, t.revision),
    seasonDecisionIdx: index("review_decisions_season_decided_idx").on(t.seasonId, t.decidedAt),
  }),
);

export const reviewSummaries = pgTable(
  "review_summaries",
  {
    programId: text("program_id").primaryKey(),
    reviewStatus: text("review_status"),
    latestVerdict: text("latest_verdict"),
    latestReviewer: text("latest_reviewer"),
    latestReason: text("latest_reason"),
    displayRevision: integer("display_revision"),
    pendingSubmissionRevision: integer("pending_submission_revision"),
    submissionRevision: integer("submission_revision"),
    currentRevisionVisibleCommentCount: integer("current_revision_visible_comment_count")
      .notNull()
      .default(0),
    totalVisibleCommentCount: integer("total_visible_comment_count").notNull().default(0),
    activeRequestRevision: integer("active_request_revision"),
    activeRequestAcknowledged: boolean("active_request_acknowledged").notNull().default(false),
    manualOverride: boolean("manual_override").notNull().default(false),
    tombstoned: boolean("tombstoned").notNull().default(false),
    seasonId: integer("season_id").notNull(),
    updatedAt: bigint("updated_at", { mode: "bigint" }).notNull(),
  },
  (t) => ({
    queueIdx: index("review_summaries_queue_idx").on(
      t.seasonId,
      t.reviewStatus,
      t.manualOverride,
      t.tombstoned,
    ),
  }),
);

export const projectReviewSummaries = pgTable(
  "project_review_summaries",
  {
    projectReviewId: text("project_review_id").primaryKey(),
    owner: text("owner").notNull(),
    githubUrl: text("github_url").notNull(),
    idea: text("idea").notNull(),
    status: text("status").notNull(),
    linkedProgramId: text("linked_program_id"),
    commentCount: integer("comment_count").notNull().default(0),
    latestGuidanceOutcome: text("latest_guidance_outcome"),
    latestGuidance: text("latest_guidance"),
    latestReviewer: text("latest_reviewer"),
    seasonId: integer("season_id").notNull(),
    createdAt: bigint("created_at", { mode: "bigint" }).notNull(),
    updatedAt: bigint("updated_at", { mode: "bigint" }).notNull(),
    hidden: boolean("hidden").notNull().default(false),
    tombstoned: boolean("tombstoned").notNull().default(false),
  },
  (t) => ({
    ownerIdx: index("project_review_summaries_owner_idx").on(t.owner),
    linkedProgramIdx: index("project_review_summaries_linked_program_idx").on(t.linkedProgramId),
    queueIdx: index("project_review_summaries_queue_idx").on(
      t.seasonId,
      t.status,
      t.hidden,
      t.tombstoned,
      t.updatedAt,
    ),
  }),
);

export const projectReviewComments = pgTable(
  "project_review_comments",
  {
    eventId: text("event_id").primaryKey(),
    projectReviewId: text("project_review_id").notNull(),
    author: text("author").notNull(),
    authorRole: text("author_role").notNull(),
    body: text("body").notNull(),
    ts: bigint("ts", { mode: "bigint" }).notNull(),
    seasonId: integer("season_id").notNull(),
    hidden: boolean("hidden").notNull().default(false),
    tombstoned: boolean("tombstoned").notNull().default(false),
  },
  (t) => ({
    projectReviewVisibleIdx: index("project_review_comments_visible_idx").on(t.projectReviewId, t.hidden, t.tombstoned),
  }),
);

export const projectReviewGuidance = pgTable(
  "project_review_guidance",
  {
    eventId: text("event_id").primaryKey(),
    projectReviewId: text("project_review_id").notNull(),
    reviewer: text("reviewer").notNull(),
    outcome: text("outcome").notNull(),
    body: text("body").notNull(),
    ts: bigint("ts", { mode: "bigint" }).notNull(),
    seasonId: integer("season_id").notNull(),
    hidden: boolean("hidden").notNull().default(false),
    tombstoned: boolean("tombstoned").notNull().default(false),
  },
  (t) => ({
    projectReviewVisibleIdx: index("project_review_guidance_visible_idx").on(t.projectReviewId, t.hidden, t.tombstoned),
  }),
);

export const projectReviewLinks = pgTable(
  "project_review_links",
  {
    eventId: text("event_id").primaryKey(),
    projectReviewId: text("project_review_id").notNull(),
    owner: text("owner").notNull(),
    programId: text("program_id").notNull(),
    linkedAt: bigint("linked_at", { mode: "bigint" }).notNull(),
    seasonId: integer("season_id").notNull(),
  },
  (t) => ({
    projectReviewIdx: index("project_review_links_project_review_idx").on(t.projectReviewId),
    programIdx: index("project_review_links_program_idx").on(t.programId),
  }),
);

export const hiddenReviewEventIds = pgTable("hidden_review_event_ids", {
  eventId: text("event_id").primaryKey(),
  reason: text("reason").notNull(),
  hiddenAt: bigint("hidden_at", { mode: "bigint" }).notNull(),
});

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
