//! Chat service — events-only history, Matrix `/sync`-style mention inbox.
//!
//! Program state is intentionally minimal: `next_message_id`, per-recipient
//! ring-buffer inboxes, and a rate-limit timestamp map.
//! Full message history lives in `MessagePosted` events, not state.

use crate::admin::AdminState;
use crate::guards;
use crate::registry::RegistryState;
use crate::types::*;
use sails_rs::cell::RefCell;
use sails_rs::collections::BTreeMap;
use sails_rs::gstd::{exec, msg};
use sails_rs::prelude::*;

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

#[derive(Default)]
pub struct ChatState {
    pub next_message_id: ChatMsgId,
    /// Key is `HandleRef::encode()` bytes — Sails storage doesn't enforce
    /// structural enum keys; manual SCALE encoding keeps both `Participant`
    /// and `Application` variants unambiguous.
    pub mention_inboxes: BTreeMap<Vec<u8>, MentionInbox>,
    /// Rate limit keyed on `msg::source()` (wallet for participant posts,
    /// program ActorId for app self-calls — shared bucket).
    pub last_post_at: BTreeMap<ActorId, u64>,
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

#[sails_rs::event]
#[derive(Encode, Decode, TypeInfo, Clone, Debug, PartialEq, Eq)]
#[codec(crate = sails_rs::scale_codec)]
#[scale_info(crate = sails_rs::scale_info)]
pub enum ChatEvent {
    MessagePosted {
        id: ChatMsgId,
        author: HandleRef,
        body: String,
        mentions: Vec<HandleRef>,
        delivered_mentions: Vec<HandleRef>,
        reply_to: Option<ChatMsgId>,
        ts: u64,
        season_id: u32,
    },
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

pub struct ChatService<'a> {
    admin: &'a RefCell<AdminState>,
    chat: &'a RefCell<ChatState>,
    /// Read-only access to application records for author auth.
    registry: &'a RefCell<RegistryState>,
    current_season: u32,
}

impl<'a> ChatService<'a> {
    pub fn new(
        admin: &'a RefCell<AdminState>,
        chat: &'a RefCell<ChatState>,
        registry: &'a RefCell<RegistryState>,
        current_season: u32,
    ) -> Self {
        Self {
            admin,
            chat,
            registry,
            current_season,
        }
    }
}

#[sails_rs::service(events = ChatEvent)]
impl<'a> ChatService<'a> {
    /// Post a chat message. Fire-and-forget: author does not await delivery;
    /// recipients see the header on their next `get_mentions` query.
    ///
    /// Authorship rules:
    /// - `author = Participant(p)` requires `msg::source() == p`. Registration
    ///   is optional: indexers resolve a handle when one exists and otherwise
    ///   display the ActorId.
    /// - `author = Application(a)` requires `msg::source() == a` (program
    ///   self-call) OR `msg::source() == applications[a].owner` (attested
    ///   operator wallet).
    #[export(unwrap_result)]
    pub fn post(
        &mut self,
        body: String,
        author: HandleRef,
        mentions: Vec<HandleRef>,
        reply_to: Option<ChatMsgId>,
    ) -> Result<ChatMsgId, ContractError> {
        let config = self.admin.borrow().config.clone();
        guards::ensure_chat_enabled(&config)?;
        guards::ensure_user_mutations_allowed(&config)?;
        guards::check_chat_body(&body, &config)?;
        guards::check_mentions_cap(&mentions, &config)?;

        let caller = msg::source();

        // Authorship check.
        match &author {
            HandleRef::Participant(p) => {
                if *p != caller {
                    return Err(ContractError::Unauthorized);
                }
            }
            HandleRef::Application(a) => {
                let reg = self.registry.borrow();
                let app = reg
                    .applications
                    .get(a)
                    .ok_or(ContractError::UnknownApplication)?;
                if caller != *a && caller != app.owner {
                    return Err(ContractError::Unauthorized);
                }
            }
        }

        let now = exec::block_timestamp();
        let mut chat = self.chat.borrow_mut();

        // Rate limit on the caller wallet.
        if guards::check_and_bump_rate_limit(
            &mut chat.last_post_at,
            caller,
            now,
            config.chat_rate_limit_ms,
        )
        .is_err()
        {
            return Err(ContractError::RateLimited);
        }

        // Dedup mentions preserving order.
        let dedup_mentions = dedup_preserve_order(&mentions);

        // Strip orphan mentions (HandleRefs not in the registry) before ring
        // append. The MessagePosted event still carries the original mentions
        // list for auditability; only inbox writes are filtered. This closes
        // a DoS vector where attackers could create permanent junk inbox
        // state for fabricated HandleRefs.
        let registered_mentions =
            filter_registered_mentions(&dedup_mentions, &self.registry.borrow());

        // Allocate id. `checked_add` panics on overflow → whole message
        // reverts per Gear transaction boundary. Saturating would silently
        // reuse u64::MAX for all future messages, breaking uniqueness.
        chat.next_message_id = chat
            .next_message_id
            .checked_add(1)
            .expect("next_message_id overflow");
        let msg_id = chat.next_message_id;

        let block = exec::block_height();
        for recipient in &registered_mentions {
            let key = recipient.encode();
            let inbox = chat.mention_inboxes.entry(key).or_default();
            inbox.latest_seq = msg_id;
            if inbox.ring.len() >= config.mention_inbox_cap as usize {
                let _ = inbox.ring.pop_front();
                inbox.oldest_retained_seq = inbox
                    .ring
                    .front()
                    .map(|h| h.msg_id)
                    .unwrap_or(inbox.latest_seq);
            } else if inbox.oldest_retained_seq == 0 {
                inbox.oldest_retained_seq = msg_id;
            }
            inbox.ring.push_back(MentionHeader {
                msg_id,
                block,
                author: author.clone(),
            });
        }

        let season_id = self.current_season;
        drop(chat);

        self.emit_event(ChatEvent::MessagePosted {
            id: msg_id,
            author,
            body,
            mentions: dedup_mentions,
            delivered_mentions: registered_mentions,
            reply_to,
            ts: now,
            season_id,
        })
        .expect("emit MessagePosted failed");

        Ok(msg_id)
    }

    /// Matrix `/sync`-style inbox read. On `since_seq < oldest_retained_seq`,
    /// returns all retained headers with `overflow: true` — the agent
    /// backfills missed messages from its local event store or the team
    /// indexer.
    #[export]
    pub fn get_mentions(&self, recipient: HandleRef, since_seq: u64, limit: u32) -> MentionsPage {
        let limit = guards::clamp_page_size(limit, MAX_PAGE_SIZE_MENTIONS);
        let chat = self.chat.borrow();
        let key = recipient.encode();
        let Some(inbox) = chat.mention_inboxes.get(&key) else {
            return MentionsPage {
                headers: Vec::new(),
                overflow: false,
                next_seq: 0,
            };
        };

        // Off-by-one matters here. `since_seq` is "last msg_id the client saw."
        // They want msgs where msg_id > since_seq. Overflow means we can't give
        // them the next one after since_seq because it was evicted. That means
        // (since_seq + 1) < oldest_retained_seq. `since_seq == oldest - 1` is
        // NOT a gap: next msg is `oldest`, which we have.
        let overflow = since_seq > 0 && since_seq + 1 < inbox.oldest_retained_seq;
        let headers: Vec<MentionHeader> = inbox
            .ring
            .iter()
            .filter(|h| h.msg_id > since_seq)
            .take(limit)
            .cloned()
            .collect();

        // Cursor semantics: if we returned headers, advance to last seen msg_id.
        // If the query returned zero (limit=0 OR since_seq >= latest_seq OR no
        // matching rows), leave the cursor at `since_seq` so clients trusting
        // the cursor do not skip past unread mentions.
        let next_seq = if let Some(last) = headers.last() {
            last.msg_id
        } else if limit == 0 {
            since_seq
        } else {
            inbox.latest_seq
        };

        MentionsPage {
            headers,
            overflow,
            next_seq,
        }
    }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

fn dedup_preserve_order(items: &[HandleRef]) -> Vec<HandleRef> {
    let mut out = Vec::with_capacity(items.len());
    let mut seen = BTreeMap::new();
    for it in items {
        let key = it.encode();
        if seen.insert(key, ()).is_none() {
            out.push(it.clone());
        }
    }
    out
}

/// Keep only HandleRefs that refer to a registered participant or application.
/// Spec: "Orphan mention — strip silently before insert; event still carries
/// original list for auditability."
fn filter_registered_mentions(mentions: &[HandleRef], registry: &RegistryState) -> Vec<HandleRef> {
    mentions
        .iter()
        .filter(|r| match r {
            HandleRef::Participant(p) => registry.participants.contains_key(p),
            HandleRef::Application(a) => registry.applications.contains_key(a),
        })
        .cloned()
        .collect()
}
