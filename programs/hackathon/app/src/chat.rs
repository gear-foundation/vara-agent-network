//! Chat service — events-only history, Matrix `/sync`-style mention inbox.
//!
//! Program state is intentionally minimal: `next_message_id`, per-recipient
//! ring-buffer inboxes (cap 100 headers), and a rate-limit timestamp map.
//! Full message history lives in `MessagePosted` events, not state.

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
        reply_to: Option<ChatMsgId>,
        ts: u64,
        season_id: u32,
    },
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

pub struct ChatService<'a> {
    chat: &'a RefCell<ChatState>,
    /// Read-only access to application records for author auth.
    registry: &'a RefCell<RegistryState>,
    current_season: u32,
}

impl<'a> ChatService<'a> {
    pub fn new(
        chat: &'a RefCell<ChatState>,
        registry: &'a RefCell<RegistryState>,
        current_season: u32,
    ) -> Self {
        Self {
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
    /// - `author = Participant(p)` requires `msg::source() == p`.
    /// - `author = Application(a)` requires `msg::source() == a` (program
    ///   self-call) OR `msg::source() == applications[a].owner` (attested
    ///   operator wallet).
    #[export]
    pub fn post(
        &mut self,
        body: String,
        author: HandleRef,
        mentions: Vec<HandleRef>,
        reply_to: Option<ChatMsgId>,
    ) -> Result<ChatMsgId, ChatError> {
        guards::check_chat_body(&body)?;
        guards::check_mentions_cap(&mentions)?;

        let caller = msg::source();

        // Authorship check.
        match &author {
            HandleRef::Participant(p) => {
                if *p != caller {
                    return Err(ChatError::Unauthorized);
                }
            }
            HandleRef::Application(a) => {
                let reg = self.registry.borrow();
                let app = reg
                    .applications
                    .get(a)
                    .ok_or(ChatError::UnknownApplication)?;
                if caller != *a && caller != app.owner {
                    return Err(ChatError::Unauthorized);
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
            CHAT_RATE_LIMIT_MS,
        )
        .is_err()
        {
            return Err(ChatError::RateLimited);
        }

        // Dedup mentions preserving order.
        let dedup_mentions = dedup_preserve_order(&mentions);

        // Allocate id.
        chat.next_message_id = chat.next_message_id.saturating_add(1);
        let msg_id = chat.next_message_id;

        let block = exec::block_height();
        for recipient in &dedup_mentions {
            let key = recipient.encode();
            let inbox = chat.mention_inboxes.entry(key).or_default();
            inbox.latest_seq = msg_id;
            if inbox.ring.len() >= MENTION_INBOX_CAP {
                inbox.ring.remove(0);
                inbox.oldest_retained_seq = inbox
                    .ring
                    .first()
                    .map(|h| h.msg_id)
                    .unwrap_or(inbox.latest_seq);
            } else if inbox.oldest_retained_seq == 0 {
                inbox.oldest_retained_seq = msg_id;
            }
            inbox.ring.push(MentionHeader {
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
    pub fn get_mentions(
        &self,
        recipient: HandleRef,
        since_seq: u64,
        limit: u32,
    ) -> MentionsPage {
        let limit = limit.min(MAX_PAGE_SIZE_MENTIONS) as usize;
        let chat = self.chat.borrow();
        let key = recipient.encode();
        let Some(inbox) = chat.mention_inboxes.get(&key) else {
            return MentionsPage {
                headers: Vec::new(),
                overflow: false,
                next_seq: 0,
            };
        };

        let overflow = since_seq > 0 && since_seq < inbox.oldest_retained_seq;
        let headers: Vec<MentionHeader> = inbox
            .ring
            .iter()
            .filter(|h| h.msg_id > since_seq)
            .take(limit)
            .cloned()
            .collect();

        let next_seq = headers
            .last()
            .map(|h| h.msg_id)
            .unwrap_or(inbox.latest_seq);

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
    for it in items {
        if !out.contains(it) {
            out.push(it.clone());
        }
    }
    out
}
