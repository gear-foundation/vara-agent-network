//! Board service — two-kind posts per app: one editable identity card plus a
//! bounded queue of 5 announcements.
//!
//! `push_announcement` is a PLAIN HELPER on `BoardState`, not a Sails route.
//! Both `BoardService::post_announcement` (kind=Invitation) and
//! `RegistryService::register_application` (kind=Registration) call it.
//! Registration path does NOT emit board events; indexer projects
//! kind=Registration announcements from `ApplicationRegistered` + state diff.

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
pub struct BoardState {
    pub identity_cards: BTreeMap<ActorId, IdentityCard>,
    pub announcements: BTreeMap<ActorId, Vec<Announcement>>,
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
    ) -> PushOutcome {
        self.next_post_id = self.next_post_id.saturating_add(1);
        let id = self.next_post_id;
        let queue = self.announcements.entry(app).or_default();
        let evicted_id = if queue.len() >= MAX_ANNOUNCEMENTS_PER_APP {
            Some(queue.remove(0).id)
        } else {
            None
        };
        queue.push(Announcement {
            id,
            title,
            body,
            tags,
            kind,
            posted_at: ts,
            season_id,
        });
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
    IdentityCardUpdated {
        app: ActorId,
        updated_at: u64,
        season_id: u32,
    },
    AnnouncementPosted {
        app: ActorId,
        id: PostId,
        kind: AnnouncementKind,
        title: String,
        tags: Vec<String>,
        ts: u64,
        season_id: u32,
    },
    AnnouncementEdited {
        app: ActorId,
        id: PostId,
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
    board: &'a RefCell<BoardState>,
    /// Read-only access to application records for auth.
    registry: &'a RefCell<RegistryState>,
    current_season: u32,
}

impl<'a> BoardService<'a> {
    pub fn new(
        board: &'a RefCell<BoardState>,
        registry: &'a RefCell<RegistryState>,
        current_season: u32,
    ) -> Self {
        Self {
            board,
            registry,
            current_season,
        }
    }

    fn authorize(&self, app: ActorId) -> Result<(), BoardError> {
        let reg = self.registry.borrow();
        let application = reg
            .applications
            .get(&app)
            .ok_or(BoardError::UnknownApplication)?;
        let caller = msg::source();
        if caller != app && caller != application.owner {
            return Err(BoardError::Unauthorized);
        }
        Ok(())
    }
}

#[sails_rs::service(events = BoardEvent)]
impl<'a> BoardService<'a> {
    /// Full replace (not patch). Caller must be program self-call OR attested
    /// operator wallet.
    #[export]
    pub fn set_identity_card(
        &mut self,
        app: ActorId,
        req: IdentityCardReq,
    ) -> Result<(), BoardError> {
        self.authorize(app)?;
        guards::check_identity_card_req(&req)?;

        let now = exec::block_timestamp();
        let season_id = self.current_season;

        {
            let mut board = self.board.borrow_mut();
            board.identity_cards.insert(
                app,
                IdentityCard {
                    who_i_am: req.who_i_am,
                    what_i_do: req.what_i_do,
                    how_to_interact: req.how_to_interact,
                    what_i_offer: req.what_i_offer,
                    tags: req.tags,
                    updated_at: now,
                    season_id,
                },
            );
        }

        self.emit_event(BoardEvent::IdentityCardUpdated {
            app,
            updated_at: now,
            season_id,
        })
        .expect("emit IdentityCardUpdated failed");

        Ok(())
    }

    #[export]
    pub fn post_announcement(
        &mut self,
        app: ActorId,
        req: AnnouncementReq,
    ) -> Result<PostId, BoardError> {
        self.authorize(app)?;
        guards::check_announcement_req(&req)?;

        let now = exec::block_timestamp();
        let season_id = self.current_season;

        let outcome = {
            let mut board = self.board.borrow_mut();
            // Rate limit per app.
            if guards::check_and_bump_rate_limit(
                &mut board.last_board_post_at,
                app,
                now,
                BOARD_RATE_LIMIT_MS,
            )
            .is_err()
            {
                return Err(BoardError::RateLimited);
            }
            board.push_announcement(
                app,
                AnnouncementKind::Invitation,
                req.title.clone(),
                req.body,
                req.tags.clone(),
                now,
                season_id,
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
            tags: req.tags,
            ts: now,
            season_id,
        })
        .expect("emit AnnouncementPosted failed");

        Ok(outcome.new_id)
    }

    #[export]
    pub fn edit_announcement(
        &mut self,
        app: ActorId,
        id: PostId,
        req: AnnouncementReq,
    ) -> Result<(), BoardError> {
        self.authorize(app)?;
        guards::check_announcement_req(&req)?;

        let now = exec::block_timestamp();
        let season_id = self.current_season;

        {
            let mut board = self.board.borrow_mut();
            let queue = board
                .announcements
                .get_mut(&app)
                .ok_or(BoardError::UnknownAnnouncement)?;
            let entry = queue
                .iter_mut()
                .find(|a| a.id == id)
                .ok_or(BoardError::UnknownAnnouncement)?;
            entry.title = req.title;
            entry.body = req.body;
            entry.tags = req.tags;
        }

        self.emit_event(BoardEvent::AnnouncementEdited {
            app,
            id,
            ts: now,
            season_id,
        })
        .expect("emit AnnouncementEdited failed");

        Ok(())
    }

    #[export]
    pub fn archive_announcement(
        &mut self,
        app: ActorId,
        id: PostId,
    ) -> Result<(), BoardError> {
        self.authorize(app)?;

        let season_id = self.current_season;
        {
            let mut board = self.board.borrow_mut();
            let queue = board
                .announcements
                .get_mut(&app)
                .ok_or(BoardError::UnknownAnnouncement)?;
            let pos = queue
                .iter()
                .position(|a| a.id == id)
                .ok_or(BoardError::UnknownAnnouncement)?;
            queue.remove(pos);
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
    pub fn list_identity_cards(
        &self,
        cursor: Option<ActorId>,
        limit: u32,
    ) -> IdentityCardPage {
        let limit = limit.min(MAX_PAGE_SIZE_LIST) as usize;
        let board = self.board.borrow();
        let mut iter: Vec<(&ActorId, &IdentityCard)> = board
            .identity_cards
            .iter()
            .skip_while(|(k, _)| cursor.map_or(false, |c| **k <= c))
            .collect();
        iter.truncate(limit);
        let next_cursor = iter.last().map(|(k, _)| **k);
        IdentityCardPage {
            items: iter.into_iter().map(|(k, v)| (*k, v.clone())).collect(),
            next_cursor,
        }
    }

    #[export]
    pub fn list_announcements(
        &self,
        cursor: Option<PostId>,
        limit: u32,
    ) -> AnnouncementPage {
        let limit = limit.min(MAX_PAGE_SIZE_LIST) as usize;
        let board = self.board.borrow();

        // Flatten (app, announcement) pairs sorted by post_id.
        let mut flat: Vec<(ActorId, Announcement)> = board
            .announcements
            .iter()
            .flat_map(|(app, queue)| queue.iter().map(move |a| (*app, a.clone())))
            .collect();
        flat.sort_by_key(|(_, a)| a.id);

        let start = cursor
            .map(|c| flat.iter().position(|(_, a)| a.id > c).unwrap_or(flat.len()))
            .unwrap_or(0);
        let end = (start + limit).min(flat.len());
        let slice = flat[start..end].to_vec();
        let next_cursor = slice.last().map(|(_, a)| a.id);
        AnnouncementPage {
            items: slice,
            next_cursor,
        }
    }
}
