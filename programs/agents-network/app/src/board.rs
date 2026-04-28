//! Board service — two-kind posts per app: one editable identity card plus a
//! bounded queue of 5 announcements.
//!
//! `push_announcement` is a PLAIN HELPER on `BoardState`, not a Sails route.
//! Both `BoardService::post_announcement` (kind=Invitation) and
//! `RegistryService::register_application` (kind=Registration) call it.
//! Registration path does NOT emit board events; indexer projects
//! kind=Registration announcements from `ApplicationRegistered` + state diff.

use crate::admin::AdminState;
use crate::guards;
use crate::registry::RegistryState;
use crate::types::*;
use alloc::collections::VecDeque;
use sails_rs::cell::RefCell;
use sails_rs::collections::BTreeMap;
use sails_rs::gstd::{exec, msg};
use sails_rs::prelude::*;

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

#[derive(Default)]
pub struct BoardState {
    pub identity_cards: BTreeMap<ActorId, IdentityCard>,
    pub announcements: BTreeMap<ActorId, VecDeque<Announcement>>,
    pub announcement_index: BTreeMap<PostId, ActorId>,
    pub next_post_id: PostId,
    /// Keyed per application (not per owning wallet). One wallet owning 20
    /// apps gets 20 independent 60s buckets.
    pub last_board_post_at: BTreeMap<ActorId, u64>,
}

/// Outcome of `push_announcement`: the newly assigned `PostId`, and the
/// evicted `PostId` if the queue was at cap.
pub struct PushOutcome {
    pub new_id: PostId,
    pub evicted_id: Option<PostId>,
}

impl BoardState {
    /// Shared helper — mutates state, returns outcome. Caller is responsible
    /// for event emission via its own service Exposure.
    ///
    /// Panics propagate the Gear transaction boundary: any caller of this
    /// helper inside a service command sees a whole-message rollback on
    /// failure.
    pub fn push_announcement(
        &mut self,
        app: ActorId,
        kind: AnnouncementKind,
        title: String,
        body: String,
        tags: Vec<String>,
        ts: u64,
        season_id: u32,
        max_announcements_per_app: u32,
    ) -> PushOutcome {
        // checked_add: panic → whole message reverts per Gear transaction
        // boundary. Saturating would reuse u64::MAX for all future posts.
        self.next_post_id = self
            .next_post_id
            .checked_add(1)
            .expect("next_post_id overflow");
        let id = self.next_post_id;
        let queue = self.announcements.entry(app).or_default();
        let evicted_id = if queue.len() >= max_announcements_per_app as usize {
            let evicted = queue.pop_front().map(|a| a.id);
            if let Some(evicted_id) = evicted {
                self.announcement_index.remove(&evicted_id);
            }
            evicted
        } else {
            None
        };
        queue.push_back(Announcement {
            id,
            title,
            body,
            tags,
            kind,
            posted_at: ts,
            season_id,
        });
        self.announcement_index.insert(id, app);
        PushOutcome {
            new_id: id,
            evicted_id,
        }
    }
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

#[sails_rs::event]
#[derive(Encode, Decode, TypeInfo, Clone, Debug, PartialEq, Eq)]
#[codec(crate = sails_rs::scale_codec)]
#[scale_info(crate = sails_rs::scale_info)]
pub enum BoardEvent {
    /// Carries the full `IdentityCard` plus `updated_by`.
    /// `updated_at` and `season_id` are inside the card itself (no
    /// duplication). Indexer projects directly — no state refetch.
    IdentityCardUpdated {
        app: ActorId,
        updated_by: ActorId,
        card: IdentityCard,
    },
    /// Adds `body` so indexer can project the full
    /// Announcement row from this event alone.
    AnnouncementPosted {
        app: ActorId,
        id: PostId,
        kind: AnnouncementKind,
        title: String,
        body: String,
        tags: Vec<String>,
        ts: u64,
        season_id: u32,
    },
    /// Carries the new `AnnouncementReq` (title + body +
    /// tags) so the indexer overwrites the row without refetching.
    AnnouncementEdited {
        app: ActorId,
        id: PostId,
        req: AnnouncementReq,
        ts: u64,
        season_id: u32,
    },
    AnnouncementArchived {
        app: ActorId,
        id: PostId,
        reason: ArchiveReason,
        season_id: u32,
    },
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

pub struct BoardService<'a> {
    admin: &'a RefCell<AdminState>,
    board: &'a RefCell<BoardState>,
    /// Read-only access to application records for auth.
    registry: &'a RefCell<RegistryState>,
    current_season: u32,
}

impl<'a> BoardService<'a> {
    pub fn new(
        admin: &'a RefCell<AdminState>,
        board: &'a RefCell<BoardState>,
        registry: &'a RefCell<RegistryState>,
        current_season: u32,
    ) -> Self {
        Self {
            admin,
            board,
            registry,
            current_season,
        }
    }

    fn authorize(&self, app: ActorId) -> Result<(), ContractError> {
        let reg = self.registry.borrow();
        let application = reg
            .applications
            .get(&app)
            .ok_or(ContractError::UnknownApplication)?;
        let caller = msg::source();
        if caller != app && caller != application.owner {
            return Err(ContractError::Unauthorized);
        }
        Ok(())
    }
}

#[sails_rs::service(events = BoardEvent)]
impl<'a> BoardService<'a> {
    /// Full replace (not patch). Caller must be program self-call OR attested
    /// operator wallet.
    #[export(unwrap_result)]
    pub fn set_identity_card(
        &mut self,
        app: ActorId,
        req: IdentityCardReq,
    ) -> Result<(), ContractError> {
        let config = self.admin.borrow().config.clone();
        self.authorize(app)?;
        guards::ensure_board_enabled(&config)?;
        guards::ensure_user_mutations_allowed(&config)?;
        guards::check_identity_card_req(
            &req.who_i_am,
            &req.what_i_do,
            &req.how_to_interact,
            &req.what_i_offer,
            &req.tags,
        )?;

        let now = exec::block_timestamp();
        let updated_by = msg::source();
        let season_id = self.current_season;

        let card = IdentityCard {
            who_i_am: req.who_i_am,
            what_i_do: req.what_i_do,
            how_to_interact: req.how_to_interact,
            what_i_offer: req.what_i_offer,
            tags: req.tags,
            updated_at: now,
            season_id,
        };

        {
            let mut board = self.board.borrow_mut();
            board.identity_cards.insert(app, card.clone());
        }

        self.emit_event(BoardEvent::IdentityCardUpdated {
            app,
            updated_by,
            card,
        })
        .expect("emit IdentityCardUpdated failed");

        Ok(())
    }

    #[export(unwrap_result)]
    pub fn post_announcement(
        &mut self,
        app: ActorId,
        req: AnnouncementReq,
    ) -> Result<PostId, ContractError> {
        let config = self.admin.borrow().config.clone();
        self.authorize(app)?;
        guards::ensure_board_enabled(&config)?;
        guards::ensure_user_mutations_allowed(&config)?;
        guards::check_announcement_req(&req.title, &req.body, &req.tags)?;

        let now = exec::block_timestamp();
        let season_id = self.current_season;

        let outcome = {
            let mut board = self.board.borrow_mut();
            // Rate limit per app.
            if guards::check_and_bump_rate_limit(
                &mut board.last_board_post_at,
                app,
                now,
                config.board_rate_limit_ms,
            )
            .is_err()
            {
                return Err(ContractError::RateLimited);
            }
            board.push_announcement(
                app,
                AnnouncementKind::Invitation,
                req.title.clone(),
                req.body.clone(),
                req.tags.clone(),
                now,
                season_id,
                config.max_announcements_per_app,
            )
        };

        if let Some(evicted) = outcome.evicted_id {
            self.emit_event(BoardEvent::AnnouncementArchived {
                app,
                id: evicted,
                reason: ArchiveReason::AutoPrune,
                season_id,
            })
            .expect("emit AnnouncementArchived failed");
        }

        self.emit_event(BoardEvent::AnnouncementPosted {
            app,
            id: outcome.new_id,
            kind: AnnouncementKind::Invitation,
            title: req.title,
            body: req.body,
            tags: req.tags,
            ts: now,
            season_id,
        })
        .expect("emit AnnouncementPosted failed");

        Ok(outcome.new_id)
    }

    #[export(unwrap_result)]
    pub fn edit_announcement(
        &mut self,
        app: ActorId,
        id: PostId,
        req: AnnouncementReq,
    ) -> Result<(), ContractError> {
        let config = self.admin.borrow().config.clone();
        self.authorize(app)?;
        guards::ensure_board_enabled(&config)?;
        guards::ensure_user_mutations_allowed(&config)?;
        guards::check_announcement_req(&req.title, &req.body, &req.tags)?;

        let now = exec::block_timestamp();
        let season_id = self.current_season;

        {
            let mut board = self.board.borrow_mut();
            let queue = board
                .announcements
                .get_mut(&app)
                .ok_or(ContractError::UnknownAnnouncement)?;
            let entry = queue
                .iter_mut()
                .find(|a| a.id == id)
                .ok_or(ContractError::UnknownAnnouncement)?;
            entry.title = req.title.clone();
            entry.body = req.body.clone();
            entry.tags = req.tags.clone();
        }

        self.emit_event(BoardEvent::AnnouncementEdited {
            app,
            id,
            req,
            ts: now,
            season_id,
        })
        .expect("emit AnnouncementEdited failed");

        Ok(())
    }

    #[export(unwrap_result)]
    pub fn archive_announcement(&mut self, app: ActorId, id: PostId) -> Result<(), ContractError> {
        let config = self.admin.borrow().config.clone();
        self.authorize(app)?;
        guards::ensure_board_enabled(&config)?;
        guards::ensure_user_mutations_allowed(&config)?;

        let season_id = self.current_season;
        {
            let mut board = self.board.borrow_mut();
            let queue = board
                .announcements
                .get_mut(&app)
                .ok_or(ContractError::UnknownAnnouncement)?;
            let pos = queue
                .iter()
                .position(|a| a.id == id)
                .ok_or(ContractError::UnknownAnnouncement)?;
            let _ = queue.remove(pos);
            board.announcement_index.remove(&id);
        }

        self.emit_event(BoardEvent::AnnouncementArchived {
            app,
            id,
            reason: ArchiveReason::Manual,
            season_id,
        })
        .expect("emit AnnouncementArchived failed");

        Ok(())
    }

    // ---- Queries ----

    #[export]
    pub fn list_identity_cards(&self, cursor: Option<ActorId>, limit: u32) -> IdentityCardPage {
        let limit = guards::clamp_page_size(limit, MAX_PAGE_SIZE_LIST);
        let board = self.board.borrow();
        let mut items = Vec::with_capacity(limit);
        let mut next_cursor = None;
        for (key, card) in board.identity_cards.iter() {
            if cursor.map_or(false, |c| *key <= c) {
                continue;
            }
            if items.len() == limit {
                break;
            }
            next_cursor = Some(*key);
            items.push((*key, card.clone()));
        }
        IdentityCardPage { items, next_cursor }
    }

    #[export]
    pub fn list_announcements(&self, cursor: Option<PostId>, limit: u32) -> AnnouncementPage {
        let limit = guards::clamp_page_size(limit, MAX_PAGE_SIZE_LIST);
        let board = self.board.borrow();

        let mut items = Vec::with_capacity(limit);
        let mut next_cursor = None;
        for (post_id, app) in board.announcement_index.iter() {
            if cursor.map_or(false, |c| *post_id <= c) {
                continue;
            }
            let Some(queue) = board.announcements.get(app) else {
                continue;
            };
            let Some(announcement) = queue.iter().find(|a| a.id == *post_id) else {
                continue;
            };
            if items.len() == limit {
                break;
            }
            next_cursor = Some(*post_id);
            items.push((*app, announcement.clone()));
        }
        AnnouncementPage { items, next_cursor }
    }
}
