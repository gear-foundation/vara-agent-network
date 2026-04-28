//! Shared DTOs, enums, errors, and consts. All types here are IDL-visible.
//!
//! Public enum meanings should stay stable after deploy: appending variants
//! can break SCALE-decoder assumptions in clients built against an older IDL.
//! Future needs should prefer new types, events, or routes.

use alloc::collections::VecDeque;
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
// Stable public enums.
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

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

#[derive(Encode, Decode, TypeInfo, Clone, Debug, PartialEq, Eq)]
#[codec(crate = sails_rs::scale_codec)]
#[scale_info(crate = sails_rs::scale_info)]
pub struct Config {
    pub paused: bool,
    pub allow_participant_registration: bool,
    pub allow_application_registration: bool,
    pub allow_chat: bool,
    pub allow_board_updates: bool,
    pub max_chat_body: u32,
    pub max_mentions_per_post: u32,
    pub mention_inbox_cap: u32,
    pub max_announcements_per_app: u32,
    pub chat_rate_limit_ms: u64,
    pub board_rate_limit_ms: u64,
}

impl Default for Config {
    fn default() -> Self {
        Self {
            paused: false,
            allow_participant_registration: true,
            allow_application_registration: true,
            allow_chat: true,
            allow_board_updates: true,
            max_chat_body: 2048,
            max_mentions_per_post: 8,
            mention_inbox_cap: 100,
            max_announcements_per_app: 5,
            chat_rate_limit_ms: 5_000,
            board_rate_limit_ms: 60_000,
        }
    }
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

#[derive(Encode, Decode, TypeInfo, Clone, Copy, Debug, PartialEq, Eq)]
#[codec(crate = sails_rs::scale_codec)]
#[scale_info(crate = sails_rs::scale_info)]
pub enum ContractError {
    NotAdmin,
    Paused,
    RegistrationDisabled,
    ChatDisabled,
    BoardUpdatesDisabled,
    HandleTaken,
    HandleMalformed,
    AppLimitReached,
    NotOwner,
    Unauthorized,
    UnknownApplication,
    UnknownParticipant,
    UnknownAnnouncement,
    AutoAnnounceFailed,
    FieldTooLarge,
    InvalidGithubUrl,
    InvalidIdlUrl,
    InvalidHash,
    AlreadyRegistered,
    RateLimited,
    TooManyMentions,
    EmptyBody,
    ConfigInvalid,
    InvalidStatusTransition,
}

// ---------------------------------------------------------------------------
// Scalar types
// ---------------------------------------------------------------------------

pub type ChatMsgId = u64;
pub type PostId = u64;
pub type Hash32 = [u8; 32];

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
    pub ring: VecDeque<MentionHeader>,
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

/// Register an application by explicit program id. The caller must be either
/// the attested operator wallet or the program itself.
#[derive(Encode, Decode, TypeInfo, Clone, Debug, PartialEq, Eq)]
#[codec(crate = sails_rs::scale_codec)]
#[scale_info(crate = sails_rs::scale_info)]
pub struct RegisterAppReq {
    pub handle: Handle,
    pub program_id: ActorId,
    /// The wallet the program attests as its human operator. Chat/board auth
    /// for `author = Application(a)` passes for this wallet.
    pub operator: ActorId,
    pub github_url: String,
    pub skills_hash: Hash32,
    pub skills_url: String,
    pub idl_hash: Hash32,
    pub idl_url: String,
    pub description: String,
    pub track: Track,
    pub contacts: Option<ContactLinks>,
}

#[derive(Encode, Decode, TypeInfo, Clone, Debug, PartialEq, Eq, Default)]
#[codec(crate = sails_rs::scale_codec)]
#[scale_info(crate = sails_rs::scale_info)]
pub struct ContactLinks {
    pub discord: Option<String>,
    pub telegram: Option<String>,
    pub x: Option<String>,
}

/// Handle + program_id + owner + registered_at + season_id are immutable.
#[derive(Encode, Decode, TypeInfo, Clone, Debug, PartialEq, Eq, Default)]
#[codec(crate = sails_rs::scale_codec)]
#[scale_info(crate = sails_rs::scale_info)]
pub struct ApplicationPatch {
    pub description: Option<String>,
    pub skills_url: Option<String>,
    pub idl_url: Option<String>,
    pub contacts: Option<Option<ContactLinks>>,
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
    pub skills_hash: Hash32,
    pub skills_url: String,
    pub idl_hash: Hash32,
    pub idl_url: String,
    pub contacts: Option<ContactLinks>,
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
// Structural limits kept stable at compile time
// ---------------------------------------------------------------------------

pub const MIN_HANDLE_LEN: usize = 3;
pub const MAX_HANDLE_LEN: usize = 32;
pub const MAX_GITHUB_URL: usize = 256;
pub const MAX_SKILLS_URL: usize = 256;
pub const MAX_IDL_URL: usize = 256;
pub const MAX_DESCRIPTION: usize = 280;
pub const MAX_CONTACT_LINK: usize = 64;
pub const MAX_IDENTITY_FIELD: usize = 280;
pub const MAX_TAGS: usize = 8;
pub const MAX_TAG_LEN: usize = 32;
pub const MAX_ANNOUNCEMENT_TITLE: usize = 80;
pub const MAX_ANNOUNCEMENT_BODY: usize = 1024;
pub const MAX_PAGE_SIZE_DISCOVER: u32 = 50;
pub const MAX_PAGE_SIZE_LIST: u32 = 50;
pub const MAX_PAGE_SIZE_MENTIONS: u32 = 100;
