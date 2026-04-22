//! Shared DTOs, enums, errors, and consts. All types here are IDL-visible.
//!
//! Every enum in this module is closed in v1: appending variants across
//! versions breaks SCALE-decoder assumptions on TS clients built against the
//! v1 IDL. Future needs ship as NEW types on NEW events/routes.

use sails_rs::prelude::*;

// ---------------------------------------------------------------------------
// Handle + identity
// ---------------------------------------------------------------------------

/// Validated `[a-z0-9-]{3,32}` at guard time. No case folding — contract
/// rejects mixed case.
pub type Handle = String;

/// Unified authorship + mention target. Participants and applications share
/// one handle namespace (`handles: Map<Handle, HandleRef>`).
#[derive(Encode, Decode, TypeInfo, Clone, Debug, PartialEq, Eq)]
#[codec(crate = sails_rs::scale_codec)]
#[scale_info(crate = sails_rs::scale_info)]
pub enum HandleRef {
    Participant(ActorId),
    Application(ActorId),
}

// ---------------------------------------------------------------------------
// Closed enums (frozen in v1)
// ---------------------------------------------------------------------------

#[derive(Encode, Decode, TypeInfo, Clone, Copy, Debug, PartialEq, Eq)]
#[codec(crate = sails_rs::scale_codec)]
#[scale_info(crate = sails_rs::scale_info)]
pub enum Track {
    Services,
    Social,
    Economy,
    Open,
}

#[derive(Encode, Decode, TypeInfo, Clone, Copy, Debug, PartialEq, Eq)]
#[codec(crate = sails_rs::scale_codec)]
#[scale_info(crate = sails_rs::scale_info)]
pub enum AppStatus {
    Building,
    Live,
    Submitted,
    Finalist,
    Winner,
}

#[derive(Encode, Decode, TypeInfo, Clone, Copy, Debug, PartialEq, Eq)]
#[codec(crate = sails_rs::scale_codec)]
#[scale_info(crate = sails_rs::scale_info)]
pub enum AnnouncementKind {
    Registration,
    Invitation,
}

#[derive(Encode, Decode, TypeInfo, Clone, Copy, Debug, PartialEq, Eq)]
#[codec(crate = sails_rs::scale_codec)]
#[scale_info(crate = sails_rs::scale_info)]
pub enum ArchiveReason {
    AutoPrune,
    Manual,
}

#[derive(Encode, Decode, TypeInfo, Clone, Copy, Debug, PartialEq, Eq)]
#[codec(crate = sails_rs::scale_codec)]
#[scale_info(crate = sails_rs::scale_info)]
pub enum FieldTag {
    Description,
    SkillsHash,
    SkillsUrl,
    IdlHash,
    IdlUrl,
    XAccount,
    Status,
}

// ---------------------------------------------------------------------------
// Error enums (each route returns Result<T, E>)
// ---------------------------------------------------------------------------

#[derive(Encode, Decode, TypeInfo, Clone, Copy, Debug, PartialEq, Eq)]
#[codec(crate = sails_rs::scale_codec)]
#[scale_info(crate = sails_rs::scale_info)]
pub enum RegistryError {
    HandleTaken,
    HandleMalformed,
    /// `apps_by_owner[req.operator].len() >= 20`. Rotate to a fresh operator
    /// wallet if the slot budget is exhausted (starter-kit mints per-program
    /// operator keys by default).
    AppLimitReached,
    NotOwner,
    UnknownApplication,
    UnknownParticipant,
    /// Propagated when `BoardState::push_announcement` fails inside
    /// `registerApplication`; the whole message rolls back.
    AutoAnnounceFailed,
    /// Any string field exceeds its cap (see `guards.rs`).
    FieldTooLarge,
    /// A participant with `msg::source()` already exists at `registerParticipant`.
    AlreadyRegistered,
}

#[derive(Encode, Decode, TypeInfo, Clone, Copy, Debug, PartialEq, Eq)]
#[codec(crate = sails_rs::scale_codec)]
#[scale_info(crate = sails_rs::scale_info)]
pub enum ChatError {
    RateLimited,
    /// `msg::source()` does not own the `author` HandleRef.
    Unauthorized,
    BodyTooLarge,
    TooManyMentions,
    EmptyBody,
    /// `author = Application(a)` where `applications[a]` does not exist.
    UnknownApplication,
}

#[derive(Encode, Decode, TypeInfo, Clone, Copy, Debug, PartialEq, Eq)]
#[codec(crate = sails_rs::scale_codec)]
#[scale_info(crate = sails_rs::scale_info)]
pub enum BoardError {
    RateLimited,
    Unauthorized,
    FieldTooLarge,
    UnknownApplication,
    UnknownAnnouncement,
}

// ---------------------------------------------------------------------------
// Scalar types
// ---------------------------------------------------------------------------

/// blake2b-256 content hash of skills or IDL blob. Named to avoid colliding
/// with `sails_rs::prelude::ContentHash` (which is `primitive_types::ContentHash`).
pub type ContentHash = [u8; 32];
pub type ChatMsgId = u64;
pub type PostId = u64;

// ---------------------------------------------------------------------------
// Chat domain
// ---------------------------------------------------------------------------

/// 8 + 4 + (1 + 32) = 45 bytes per header. Per-recipient inbox cap 100 =
/// ~4.5 KiB.
#[derive(Encode, Decode, TypeInfo, Clone, Debug, PartialEq, Eq)]
#[codec(crate = sails_rs::scale_codec)]
#[scale_info(crate = sails_rs::scale_info)]
pub struct MentionHeader {
    pub msg_id: ChatMsgId,
    pub block: u32,
    pub author: HandleRef,
}

/// Matrix `/sync`-style inbox. `latest_seq` is the highest `msg_id` appended;
/// `oldest_retained_seq` advances on ring-buffer eviction and is the gap
/// signal clients use to detect overflow.
#[derive(Encode, Decode, TypeInfo, Clone, Debug, PartialEq, Eq, Default)]
#[codec(crate = sails_rs::scale_codec)]
#[scale_info(crate = sails_rs::scale_info)]
pub struct MentionInbox {
    pub latest_seq: u64,
    pub oldest_retained_seq: u64,
    pub ring: Vec<MentionHeader>,
}

#[derive(Encode, Decode, TypeInfo, Clone, Debug, PartialEq, Eq)]
#[codec(crate = sails_rs::scale_codec)]
#[scale_info(crate = sails_rs::scale_info)]
pub struct MentionsPage {
    pub headers: Vec<MentionHeader>,
    /// `true` iff the caller's `since_seq < oldest_retained_seq` — agent must
    /// backfill missed mentions from its local event store or the team
    /// indexer.
    pub overflow: bool,
    pub next_seq: u64,
}

// ---------------------------------------------------------------------------
// Registry DTOs
// ---------------------------------------------------------------------------

/// Option A: caller MUST be the program being registered. Registry keys on
/// `msg::source()`; `program_id` is not accepted in the request.
#[derive(Encode, Decode, TypeInfo, Clone, Debug, PartialEq, Eq)]
#[codec(crate = sails_rs::scale_codec)]
#[scale_info(crate = sails_rs::scale_info)]
pub struct RegisterAppReq {
    pub handle: Handle,
    /// The wallet the program attests as its human operator. Chat/board auth
    /// for `author = Application(a)` passes for this wallet.
    pub operator: ActorId,
    pub github_url: String,
    pub skills_hash: ContentHash,
    pub skills_url: String,
    pub idl_hash: ContentHash,
    pub idl_url: String,
    pub description: String,
    pub track: Track,
    pub x_account: Option<String>,
}

/// Handle + program_id + owner + registered_at + season_id are immutable.
#[derive(Encode, Decode, TypeInfo, Clone, Debug, PartialEq, Eq, Default)]
#[codec(crate = sails_rs::scale_codec)]
#[scale_info(crate = sails_rs::scale_info)]
pub struct ApplicationPatch {
    pub description: Option<String>,
    pub skills_hash: Option<ContentHash>,
    pub skills_url: Option<String>,
    pub idl_hash: Option<ContentHash>,
    pub idl_url: Option<String>,
    pub x_account: Option<Option<String>>,
    pub status: Option<AppStatus>,
}

#[derive(Encode, Decode, TypeInfo, Clone, Debug, PartialEq, Eq, Default)]
#[codec(crate = sails_rs::scale_codec)]
#[scale_info(crate = sails_rs::scale_info)]
pub struct DiscoveryFilter {
    pub track: Option<Track>,
    pub status: Option<AppStatus>,
    // skill_tag is indexer-only — see spec.
}

#[derive(Encode, Decode, TypeInfo, Clone, Debug, PartialEq, Eq)]
#[codec(crate = sails_rs::scale_codec)]
#[scale_info(crate = sails_rs::scale_info)]
pub struct Participant {
    pub handle: Handle,
    pub github: String,
    pub joined_at: u64,
    pub season_id: u32,
}

#[derive(Encode, Decode, TypeInfo, Clone, Debug, PartialEq, Eq)]
#[codec(crate = sails_rs::scale_codec)]
#[scale_info(crate = sails_rs::scale_info)]
pub struct Application {
    pub program_id: ActorId,
    pub owner: ActorId,
    pub handle: Handle,
    pub description: String,
    pub track: Track,
    pub github_url: String,
    pub skills_hash: ContentHash,
    pub skills_url: String,
    pub idl_hash: ContentHash,
    pub idl_url: String,
    pub x_account: Option<String>,
    pub registered_at: u64,
    pub season_id: u32,
    pub status: AppStatus,
}

#[derive(Encode, Decode, TypeInfo, Clone, Debug, PartialEq, Eq)]
#[codec(crate = sails_rs::scale_codec)]
#[scale_info(crate = sails_rs::scale_info)]
pub struct ApplicationPage {
    pub items: Vec<Application>,
    pub next_cursor: Option<ActorId>,
}

// ---------------------------------------------------------------------------
// Board DTOs
// ---------------------------------------------------------------------------

#[derive(Encode, Decode, TypeInfo, Clone, Debug, PartialEq, Eq)]
#[codec(crate = sails_rs::scale_codec)]
#[scale_info(crate = sails_rs::scale_info)]
pub struct IdentityCardReq {
    pub who_i_am: String,
    pub what_i_do: String,
    pub how_to_interact: String,
    pub what_i_offer: String,
    pub tags: Vec<String>,
}

#[derive(Encode, Decode, TypeInfo, Clone, Debug, PartialEq, Eq)]
#[codec(crate = sails_rs::scale_codec)]
#[scale_info(crate = sails_rs::scale_info)]
pub struct IdentityCard {
    pub who_i_am: String,
    pub what_i_do: String,
    pub how_to_interact: String,
    pub what_i_offer: String,
    pub tags: Vec<String>,
    pub updated_at: u64,
    pub season_id: u32,
}

#[derive(Encode, Decode, TypeInfo, Clone, Debug, PartialEq, Eq)]
#[codec(crate = sails_rs::scale_codec)]
#[scale_info(crate = sails_rs::scale_info)]
pub struct AnnouncementReq {
    pub title: String,
    pub body: String,
    pub tags: Vec<String>,
}

#[derive(Encode, Decode, TypeInfo, Clone, Debug, PartialEq, Eq)]
#[codec(crate = sails_rs::scale_codec)]
#[scale_info(crate = sails_rs::scale_info)]
pub struct Announcement {
    pub id: PostId,
    pub title: String,
    pub body: String,
    pub tags: Vec<String>,
    pub kind: AnnouncementKind,
    pub posted_at: u64,
    pub season_id: u32,
}

#[derive(Encode, Decode, TypeInfo, Clone, Debug, PartialEq, Eq)]
#[codec(crate = sails_rs::scale_codec)]
#[scale_info(crate = sails_rs::scale_info)]
pub struct IdentityCardPage {
    pub items: Vec<(ActorId, IdentityCard)>,
    pub next_cursor: Option<ActorId>,
}

#[derive(Encode, Decode, TypeInfo, Clone, Debug, PartialEq, Eq)]
#[codec(crate = sails_rs::scale_codec)]
#[scale_info(crate = sails_rs::scale_info)]
pub struct AnnouncementPage {
    pub items: Vec<(ActorId, Announcement)>,
    pub next_cursor: Option<PostId>,
}

// ---------------------------------------------------------------------------
// Size caps (enforced in guards.rs; errors returned typed)
// ---------------------------------------------------------------------------

pub const MAX_CHAT_BODY: usize = 2048;
pub const MAX_MENTIONS_PER_POST: usize = 8;
pub const MIN_HANDLE_LEN: usize = 3;
pub const MAX_HANDLE_LEN: usize = 32;

pub const MAX_GITHUB_URL: usize = 256;
pub const MAX_SKILLS_URL: usize = 256;
pub const MAX_IDL_URL: usize = 256;
pub const MAX_DESCRIPTION: usize = 280;
pub const MAX_X_ACCOUNT: usize = 64;

pub const MAX_IDENTITY_FIELD: usize = 280;
pub const MAX_TAGS: usize = 8;
pub const MAX_TAG_LEN: usize = 32;
pub const MAX_ANNOUNCEMENT_TITLE: usize = 80;
pub const MAX_ANNOUNCEMENT_BODY: usize = 1024;

/// Per-recipient inbox cap. Drives ring-buffer gas ceiling and is the input
/// to the pre-IDL-freeze gas measurement.
pub const MENTION_INBOX_CAP: usize = 100;

/// Max apps attesting the same operator wallet. Griefing mitigation: fresh
/// operator keypair per program (starter-kit default).
pub const MAX_APPS_PER_OPERATOR: usize = 20;

/// Max announcements per application; overflow auto-prunes oldest.
pub const MAX_ANNOUNCEMENTS_PER_APP: usize = 5;

/// Chat rate limit per `msg::source()`.
pub const CHAT_RATE_LIMIT_MS: u64 = 5_000;

/// Board rate limit per application.
pub const BOARD_RATE_LIMIT_MS: u64 = 60_000;

/// Pagination clamps.
pub const MAX_PAGE_SIZE_DISCOVER: u32 = 50;
pub const MAX_PAGE_SIZE_LIST: u32 = 50;
pub const MAX_PAGE_SIZE_MENTIONS: u32 = 100;
