//! Registry service — participants, applications, handles, discovery.
//!
//! Application records are keyed by explicit `program_id`, while the caller is
//! recorded/authorized as the operator. This lets one wallet manage multiple
//! registered applications.

use crate::admin::AdminState;
use crate::board::BoardState;
use crate::chat::ChatState;
use crate::guards;
use crate::review::{self, ReviewState};
use crate::types::*;
use sails_rs::cell::RefCell;
use sails_rs::collections::BTreeMap;
use sails_rs::gstd::{exec, msg};
use sails_rs::prelude::*;

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

#[derive(Default)]
pub struct RegistryState {
    pub participants: BTreeMap<ActorId, Participant>,
    pub applications: BTreeMap<ActorId, Application>,
    pub applications_by_track: BTreeMap<(Track, ActorId), bool>,
    pub applications_by_status: BTreeMap<(AppStatus, ActorId), bool>,
    pub applications_by_track_status: BTreeMap<(Track, AppStatus, ActorId), bool>,
    pub handles: BTreeMap<Handle, HandleRef>,
    pub program_replacements: BTreeMap<ActorId, ActorId>,
    pub replacement_aliases_by_target: BTreeMap<ActorId, BTreeMap<ActorId, bool>>,
    pub reserved_program_ids: BTreeMap<ActorId, bool>,
    pub replacement_counts: BTreeMap<ActorId, u32>,
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

#[sails_rs::event]
#[derive(Encode, Decode, TypeInfo, Clone, Debug, PartialEq, Eq)]
#[codec(crate = sails_rs::scale_codec)]
#[scale_info(crate = sails_rs::scale_info)]
pub enum RegistryEvent {
    ParticipantRegistered {
        wallet: ActorId,
        handle: Handle,
        github: String,
        joined_at: u64,
        season_id: u32,
    },
    /// Carries every mutable + immutable field needed to
    /// project an `Application` row without refetching on-chain state.
    /// `registered_at` is authoritative program time (block_timestamp at
    /// registration); `status` is always `Building` at registration and is
    /// omitted for payload hygiene (indexer sets it deterministically).
    ApplicationRegistered {
        program_id: ActorId,
        owner: ActorId,
        handle: Handle,
        description: String,
        track: Track,
        github_url: String,
        skills_hash: Hash32,
        skills_url: String,
        idl_hash: Hash32,
        idl_url: String,
        contacts: Option<ContactLinks>,
        registered_at: u64,
        status: AppStatus,
        registration_announcement_id: PostId,
        registration_announcement_kind: AnnouncementKind,
        registration_announcement_title: String,
        registration_announcement_body: String,
        registration_announcement_tags: Vec<String>,
        season_id: u32,
    },
    /// Emits the exact patch that was applied, so indexer
    /// can overwrite fields deterministically. Drops `changed_fields: Vec<FieldTag>`
    /// — the patch IS the change set. Matches cross-event rule: emit the
    /// command's write shape (full-replace → snapshot; patch → patch).
    ApplicationUpdated {
        program_id: ActorId,
        patch: ApplicationPatch,
        application: Application,
        season_id: u32,
    },
    ApplicationDeleted {
        program_id: ActorId,
        owner: ActorId,
        handle: Handle,
        deleted_at: u64,
        season_id: u32,
    },
    /// Owner/program self-call: marks the application ready for review.
    /// Trusted statuses after submission are controlled by AdminService.
    ApplicationSubmitted {
        program_id: ActorId,
        owner: ActorId,
        revision: u32,
        season_id: u32,
    },
    ReviewRevisionSubmitted {
        program_id: ActorId,
        owner: ActorId,
        revision: u32,
        snapshot: ReviewRevisionSnapshot,
        submitted_at: u64,
        season_id: u32,
    },
    ApplicationProgramReplaced {
        old_program_id: ActorId,
        new_program_id: ActorId,
        application: Application,
        review_summary: ReviewSummary,
        reason: String,
        replaced_by: ActorId,
        replaced_at: u64,
        replacement_count: u32,
        season_id: u32,
    },
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

pub struct RegistryService<'a> {
    admin: &'a RefCell<AdminState>,
    registry: &'a RefCell<RegistryState>,
    review: &'a RefCell<ReviewState>,
    /// Shared mutable access to board state so `registerApplication` can call
    /// the `BoardState::push_announcement` helper atomically.
    board: &'a RefCell<BoardState>,
    chat: &'a RefCell<ChatState>,
    current_season: u32,
}

impl<'a> RegistryService<'a> {
    pub fn new(
        admin: &'a RefCell<AdminState>,
        registry: &'a RefCell<RegistryState>,
        review: &'a RefCell<ReviewState>,
        board: &'a RefCell<BoardState>,
        chat: &'a RefCell<ChatState>,
        current_season: u32,
    ) -> Self {
        Self {
            admin,
            registry,
            review,
            board,
            chat,
            current_season,
        }
    }
}

#[sails_rs::service(events = RegistryEvent)]
impl<'a> RegistryService<'a> {
    /// Register the caller as a participant. `msg::source()` IS the wallet;
    /// no impersonation possible.
    #[export(unwrap_result)]
    pub fn register_participant(
        &mut self,
        handle: Handle,
        github: String,
    ) -> Result<(), ContractError> {
        let config = self.admin.borrow().config.clone();
        guards::ensure_participant_registration_enabled(&config)?;
        guards::ensure_user_mutations_allowed(&config)?;
        guards::validate_handle(&handle)?;
        if github.len() > MAX_GITHUB_URL {
            return Err(ContractError::FieldTooLarge);
        }
        guards::validate_github_url(&github)?;

        let wallet = msg::source();
        let mut reg = self.registry.borrow_mut();

        if reg.participants.contains_key(&wallet) {
            return Err(ContractError::AlreadyRegistered);
        }
        if reg.handles.contains_key(&handle) {
            return Err(ContractError::HandleTaken);
        }

        let joined_at = exec::block_timestamp();
        let season_id = self.current_season;

        reg.participants.insert(
            wallet,
            Participant {
                handle: handle.clone(),
                github: github.clone(),
                joined_at,
                season_id,
            },
        );
        reg.handles
            .insert(handle.clone(), HandleRef::Participant(wallet));

        drop(reg);

        self.emit_event(RegistryEvent::ParticipantRegistered {
            wallet,
            handle,
            github,
            joined_at,
            season_id,
        })
        .expect("emit ParticipantRegistered failed");

        Ok(())
    }

    /// Register an application by explicit `program_id`. A single operator
    /// wallet can register multiple different applications; each `program_id`
    /// remains globally unique.
    ///
    /// Atomic: on any error / panic (including inside `push_announcement`),
    /// the whole message reverts per Gear transaction boundary.
    #[export(unwrap_result)]
    pub fn register_application(&mut self, req: RegisterAppReq) -> Result<(), ContractError> {
        let config = self.admin.borrow().config.clone();
        guards::ensure_application_registration_enabled(&config)?;
        guards::ensure_user_mutations_allowed(&config)?;
        guards::check_register_app_req(&req)?;

        let caller = msg::source();
        let program_id = req.program_id;
        let now = exec::block_timestamp();
        let season_id = self.current_season;

        let mut reg = self.registry.borrow_mut();
        let mut board = self.board.borrow_mut();

        if caller != req.operator && caller != program_id {
            return Err(ContractError::Unauthorized);
        }
        if reg.handles.contains_key(&req.handle) {
            return Err(ContractError::HandleTaken);
        }
        if reg.applications.contains_key(&program_id) {
            return Err(ContractError::AlreadyRegistered);
        }
        if reg.reserved_program_ids.contains_key(&program_id) {
            return Err(ContractError::ProgramIdReserved);
        }

        // Write registry state first; then push the kind=Registration
        // announcement into BoardState. Any panic below rolls back everything.
        let application = Application {
            program_id,
            owner: req.operator,
            handle: req.handle.clone(),
            description: req.description.clone(),
            track: req.track,
            github_url: req.github_url.clone(),
            skills_hash: req.skills_hash,
            skills_url: req.skills_url.clone(),
            idl_hash: req.idl_hash,
            idl_url: req.idl_url.clone(),
            contacts: req.contacts.clone(),
            registered_at: now,
            season_id,
            status: AppStatus::Building,
        };
        reg.applications.insert(program_id, application.clone());
        insert_application_indexes(&mut reg, &application);
        reg.handles
            .insert(req.handle.clone(), HandleRef::Application(program_id));
        reg.reserved_program_ids.insert(program_id, true);
        review::init_application(&mut self.review.borrow_mut(), program_id);

        // Shared helper — writes state, emits no events. RegistryService emits
        // the enriched `ApplicationRegistered`; indexer projects BOTH the
        // `Application` row AND the kind=Registration announcement from that
        // single event (body = description, title = "@{handle} registered").
        let registration_title = default_registration_title(&req.handle);
        let registration_body = default_registration_body(&req);
        let registration_tags = Vec::new();
        let registration_outcome = board.push_announcement(
            program_id,
            AnnouncementKind::Registration,
            registration_title.clone(),
            registration_body.clone(),
            registration_tags.clone(),
            now,
            season_id,
            config.max_announcements_per_app,
        );

        drop(reg);
        drop(board);

        self.emit_event(RegistryEvent::ApplicationRegistered {
            program_id,
            owner: req.operator,
            handle: req.handle,
            description: req.description,
            track: req.track,
            github_url: req.github_url,
            skills_hash: req.skills_hash,
            skills_url: req.skills_url,
            idl_hash: req.idl_hash,
            idl_url: req.idl_url,
            contacts: req.contacts,
            registered_at: now,
            status: AppStatus::Building,
            registration_announcement_id: registration_outcome.new_id,
            registration_announcement_kind: AnnouncementKind::Registration,
            registration_announcement_title: registration_title,
            registration_announcement_body: registration_body,
            registration_announcement_tags: registration_tags,
            season_id,
        })
        .expect("emit ApplicationRegistered failed");

        Ok(())
    }

    #[export(unwrap_result)]
    pub fn update_application(
        &mut self,
        program_id: ActorId,
        patch: ApplicationPatch,
    ) -> Result<(), ContractError> {
        let config = self.admin.borrow().config.clone();
        guards::ensure_user_mutations_allowed(&config)?;
        guards::check_application_patch(
            patch.handle.as_ref(),
            patch.description.as_ref(),
            patch.github_url.as_ref(),
            patch.skills_hash.as_ref(),
            patch.skills_url.as_ref(),
            patch.idl_hash.as_ref(),
            patch.idl_url.as_ref(),
            patch.contacts.as_ref(),
        )?;

        let caller = msg::source();
        let mut reg = self.registry.borrow_mut();
        ensure_current_program_id(&reg, program_id)?;

        let (owner, current_handle, track, status) = {
            let app = reg
                .applications
                .get(&program_id)
                .ok_or(ContractError::UnknownApplication)?;
            (app.owner, app.handle.clone(), app.track, app.status)
        };

        // Auth: only the registered owner/operator wallet may edit draft metadata.
        if caller != owner {
            return Err(ContractError::NotOwner);
        }
        if status != AppStatus::Building {
            return Err(ContractError::InvalidStatusTransition);
        }
        if let Some(new_handle) = patch.handle.as_ref() {
            if new_handle != &current_handle && reg.handles.contains_key(new_handle) {
                return Err(ContractError::HandleTaken);
            }
        }

        // Apply each Some(_) arm and build the `applied` patch we emit.
        // `applied` mirrors `patch` but only contains arms that actually
        // hit state; None arms stay None so the indexer knows which fields
        // didn't change on this call.
        let mut applied = ApplicationPatch::default();
        let mut new_handle = None;
        if let Some(h) = patch.handle {
            if h != current_handle {
                new_handle = Some(h.clone());
                applied.handle = Some(h);
            }
        }
        let application = {
            let app = reg
                .applications
                .get_mut(&program_id)
                .ok_or(ContractError::UnknownApplication)?;
            if let Some(h) = new_handle.as_ref() {
                app.handle = h.clone();
            }
            if let Some(d) = patch.description {
                app.description = d.clone();
                applied.description = Some(d);
            }
            if let Some(t) = patch.track {
                app.track = t;
                applied.track = Some(t);
            }
            if let Some(u) = patch.github_url {
                app.github_url = u.clone();
                applied.github_url = Some(u);
            }
            if let Some(hash) = patch.skills_hash {
                app.skills_hash = hash;
                applied.skills_hash = Some(hash);
            }
            if let Some(u) = patch.skills_url {
                app.skills_url = u.clone();
                applied.skills_url = Some(u);
            }
            if let Some(hash) = patch.idl_hash {
                app.idl_hash = hash;
                applied.idl_hash = Some(hash);
            }
            if let Some(u) = patch.idl_url {
                app.idl_url = u.clone();
                applied.idl_url = Some(u);
            }
            if let Some(contacts) = patch.contacts {
                app.contacts = contacts.clone();
                applied.contacts = Some(contacts);
            }
            app.clone()
        };
        if let Some(h) = new_handle {
            reg.handles.remove(&current_handle);
            reg.handles.insert(h, HandleRef::Application(program_id));
        }
        if application.track != track {
            reindex_application_track(&mut reg, program_id, track, application.track, status);
        }
        let season_id = self.current_season;
        drop(reg);

        self.emit_event(RegistryEvent::ApplicationUpdated {
            program_id,
            patch: applied,
            application,
            season_id,
        })
        .expect("emit ApplicationUpdated failed");

        Ok(())
    }

    #[export(unwrap_result)]
    pub fn delete_application(&mut self, program_id: ActorId) -> Result<(), ContractError> {
        let config = self.admin.borrow().config.clone();
        guards::ensure_user_mutations_allowed(&config)?;

        let caller = msg::source();
        let mut reg = self.registry.borrow_mut();
        ensure_current_program_id(&reg, program_id)?;
        let app = reg
            .applications
            .get(&program_id)
            .ok_or(ContractError::UnknownApplication)?
            .clone();

        let admin = self.admin.borrow().admin;
        if caller != app.owner && caller != admin {
            return Err(ContractError::NotOwner);
        }

        reg.applications.remove(&program_id);
        remove_application_indexes(&mut reg, program_id, app.track, app.status);
        review::delete_application(&mut self.review.borrow_mut(), program_id);
        if reg.handles.get(&app.handle) == Some(&HandleRef::Application(program_id)) {
            reg.handles.remove(&app.handle);
        }
        drop(reg);

        self.board.borrow_mut().remove_application(program_id);

        let deleted_at = exec::block_timestamp();
        let season_id = self.current_season;
        self.emit_event(RegistryEvent::ApplicationDeleted {
            program_id,
            owner: app.owner,
            handle: app.handle,
            deleted_at,
            season_id,
        })
        .expect("emit ApplicationDeleted failed");

        Ok(())
    }

    #[export(unwrap_result)]
    pub fn submit_application(&mut self, program_id: ActorId) -> Result<(), ContractError> {
        let config = self.admin.borrow().config.clone();
        guards::ensure_user_mutations_allowed(&config)?;

        let caller = msg::source();
        let mut reg = self.registry.borrow_mut();
        ensure_current_program_id(&reg, program_id)?;
        let mut review = self.review.borrow_mut();
        let submitted_at = exec::block_timestamp();
        let old_status = reg
            .applications
            .get(&program_id)
            .ok_or(ContractError::UnknownApplication)?
            .status;
        let (owner, revision, snapshot) =
            review::submit_application(&mut reg, &mut review, program_id, caller, submitted_at)?;
        let (track, new_status) = {
            let app = reg
                .applications
                .get(&program_id)
                .ok_or(ContractError::UnknownApplication)?;
            (app.track, app.status)
        };
        reindex_application_status(&mut reg, program_id, track, old_status, new_status);
        let season_id = self.current_season;
        drop(reg);
        drop(review);

        self.emit_event(RegistryEvent::ApplicationSubmitted {
            program_id,
            owner,
            revision,
            season_id,
        })
        .expect("emit ApplicationSubmitted failed");
        self.emit_event(RegistryEvent::ReviewRevisionSubmitted {
            program_id,
            owner,
            revision,
            snapshot,
            submitted_at,
            season_id,
        })
        .expect("emit ReviewRevisionSubmitted failed");

        Ok(())
    }

    #[export(unwrap_result)]
    pub fn replace_application_program(
        &mut self,
        old_program_id: ActorId,
        new_program_id: ActorId,
        reason: String,
    ) -> Result<(), ContractError> {
        let config = self.admin.borrow().config.clone();
        guards::ensure_user_mutations_allowed(&config)?;
        guards::check_replacement_reason(&reason, &config)?;

        if old_program_id == new_program_id {
            return Err(ContractError::ProgramIdUnchanged);
        }
        if new_program_id == ActorId::zero() {
            return Err(ContractError::UnknownApplication);
        }

        let caller = msg::source();
        let now = exec::block_timestamp();
        let season_id = self.current_season;
        let (application, review_summary, replacement_count) = {
            let mut reg = self.registry.borrow_mut();
            ensure_current_program_id(&reg, old_program_id)?;

            if reg.applications.contains_key(&new_program_id) {
                return Err(ContractError::ProgramIdAlreadyRegistered);
            }
            if reg.reserved_program_ids.contains_key(&new_program_id) {
                return Err(ContractError::ProgramIdReserved);
            }

            let mut app = reg
                .applications
                .remove(&old_program_id)
                .ok_or(ContractError::UnknownApplication)?;

            if caller != app.owner {
                reg.applications.insert(old_program_id, app);
                return Err(ContractError::NotOwner);
            }
            if app.status != AppStatus::Building {
                reg.applications.insert(old_program_id, app);
                return Err(ContractError::InvalidStatusTransition);
            }

            let prior_count = reg.replacement_counts.remove(&old_program_id).unwrap_or(0);
            if prior_count >= MAX_PROGRAM_REPLACEMENTS {
                reg.replacement_counts.insert(old_program_id, prior_count);
                reg.applications.insert(old_program_id, app);
                return Err(ContractError::ProgramReplacementLimitReached);
            }
            let replacement_count = prior_count.saturating_add(1);

            remove_application_indexes(&mut reg, old_program_id, app.track, app.status);
            app.program_id = new_program_id;
            reg.applications.insert(new_program_id, app.clone());
            insert_application_indexes(&mut reg, &app);
            reg.reserved_program_ids.insert(new_program_id, true);
            reg.replacement_counts
                .insert(new_program_id, replacement_count);
            rewrite_replacement_aliases(&mut reg, old_program_id, new_program_id);

            if reg.handles.get(&app.handle) == Some(&HandleRef::Application(old_program_id)) {
                reg.handles
                    .insert(app.handle.clone(), HandleRef::Application(new_program_id));
            }

            let mut review = self.review.borrow_mut();
            let review_summary =
                review::replace_application_program(&mut review, old_program_id, new_program_id);
            self.board
                .borrow_mut()
                .replace_application_program(old_program_id, new_program_id);
            self.chat
                .borrow_mut()
                .replace_application_program(old_program_id, new_program_id);

            (app, review_summary, replacement_count)
        };

        self.emit_event(RegistryEvent::ApplicationProgramReplaced {
            old_program_id,
            new_program_id,
            application,
            review_summary,
            reason,
            replaced_by: caller,
            replaced_at: now,
            replacement_count,
            season_id,
        })
        .expect("emit ApplicationProgramReplaced failed");

        Ok(())
    }

    // ---- Queries ----

    #[export]
    pub fn get_participant(&self, wallet: ActorId) -> Option<Participant> {
        self.registry.borrow().participants.get(&wallet).cloned()
    }

    #[export]
    pub fn get_application(&self, id: ActorId) -> Option<Application> {
        self.registry.borrow().applications.get(&id).cloned()
    }

    #[export]
    pub fn resolve_current_program_id(&self, program_id: ActorId) -> ActorId {
        resolve_current_program_id(&self.registry.borrow(), program_id)
    }

    #[export]
    pub fn resolve_handle(&self, handle: Handle) -> Option<HandleRef> {
        self.registry.borrow().handles.get(&handle).cloned()
    }

    #[export]
    pub fn discover(
        &self,
        filter: DiscoveryFilter,
        cursor: Option<ActorId>,
        limit: u32,
    ) -> ApplicationPage {
        let limit = guards::clamp_page_size(limit, MAX_PAGE_SIZE_DISCOVER);
        let reg = self.registry.borrow();

        let mut items = Vec::with_capacity(limit);
        let mut next_cursor = None;
        discover_from_index(&reg, filter, cursor, limit, &mut items, &mut next_cursor);
        ApplicationPage { items, next_cursor }
    }
}

pub fn resolve_current_program_id(reg: &RegistryState, program_id: ActorId) -> ActorId {
    reg.program_replacements
        .get(&program_id)
        .copied()
        .unwrap_or(program_id)
}

pub fn ensure_current_program_id(
    reg: &RegistryState,
    program_id: ActorId,
) -> Result<(), ContractError> {
    if reg.program_replacements.contains_key(&program_id) {
        return Err(ContractError::StaleProgramId);
    }
    Ok(())
}

fn rewrite_replacement_aliases(
    reg: &mut RegistryState,
    old_program_id: ActorId,
    new_program_id: ActorId,
) {
    if let Some(aliases) = reg.replacement_aliases_by_target.remove(&old_program_id) {
        for alias in aliases.keys().copied().collect::<Vec<_>>() {
            reg.program_replacements.insert(alias, new_program_id);
            insert_replacement_alias(reg, new_program_id, alias);
        }
    }
    reg.program_replacements
        .insert(old_program_id, new_program_id);
    insert_replacement_alias(reg, new_program_id, old_program_id);
}

fn insert_application_indexes(reg: &mut RegistryState, app: &Application) {
    reg.applications_by_track
        .insert((app.track, app.program_id), true);
    reg.applications_by_status
        .insert((app.status, app.program_id), true);
    reg.applications_by_track_status
        .insert((app.track, app.status, app.program_id), true);
}

fn remove_application_indexes(
    reg: &mut RegistryState,
    program_id: ActorId,
    track: Track,
    status: AppStatus,
) {
    reg.applications_by_track.remove(&(track, program_id));
    reg.applications_by_status.remove(&(status, program_id));
    reg.applications_by_track_status
        .remove(&(track, status, program_id));
}

fn reindex_application_track(
    reg: &mut RegistryState,
    program_id: ActorId,
    old_track: Track,
    new_track: Track,
    status: AppStatus,
) {
    if old_track == new_track {
        return;
    }
    remove_application_indexes(reg, program_id, old_track, status);
    reg.applications_by_track
        .insert((new_track, program_id), true);
    reg.applications_by_status
        .insert((status, program_id), true);
    reg.applications_by_track_status
        .insert((new_track, status, program_id), true);
}

pub fn reindex_application_status(
    reg: &mut RegistryState,
    program_id: ActorId,
    track: Track,
    old_status: AppStatus,
    new_status: AppStatus,
) {
    if old_status == new_status {
        return;
    }
    remove_application_indexes(reg, program_id, track, old_status);
    reg.applications_by_track.insert((track, program_id), true);
    reg.applications_by_status
        .insert((new_status, program_id), true);
    reg.applications_by_track_status
        .insert((track, new_status, program_id), true);
}

fn discover_from_index(
    reg: &RegistryState,
    filter: DiscoveryFilter,
    cursor: Option<ActorId>,
    limit: usize,
    items: &mut Vec<Application>,
    next_cursor: &mut Option<ActorId>,
) {
    match (filter.track, filter.status) {
        (Some(track), Some(status)) => {
            for ((indexed_track, indexed_status, program_id), _) in
                reg.applications_by_track_status.iter()
            {
                if (*indexed_track, *indexed_status) < (track, status) {
                    continue;
                }
                if (*indexed_track, *indexed_status) > (track, status) {
                    break;
                }
                if push_discovered_application(
                    reg,
                    *program_id,
                    &filter,
                    cursor,
                    limit,
                    items,
                    next_cursor,
                ) {
                    break;
                }
            }
        }
        (Some(track), None) => {
            for ((indexed_track, program_id), _) in reg.applications_by_track.iter() {
                if *indexed_track < track {
                    continue;
                }
                if *indexed_track > track {
                    break;
                }
                if push_discovered_application(
                    reg,
                    *program_id,
                    &filter,
                    cursor,
                    limit,
                    items,
                    next_cursor,
                ) {
                    break;
                }
            }
        }
        (None, Some(status)) => {
            for ((indexed_status, program_id), _) in reg.applications_by_status.iter() {
                if *indexed_status < status {
                    continue;
                }
                if *indexed_status > status {
                    break;
                }
                if push_discovered_application(
                    reg,
                    *program_id,
                    &filter,
                    cursor,
                    limit,
                    items,
                    next_cursor,
                ) {
                    break;
                }
            }
        }
        (None, None) => {
            for (program_id, app) in reg.applications.iter() {
                if cursor.map_or(false, |c| *program_id <= c) {
                    continue;
                }
                if items.len() == limit {
                    break;
                }
                *next_cursor = Some(*program_id);
                items.push(app.clone());
            }
        }
    }
}

fn push_discovered_application(
    reg: &RegistryState,
    program_id: ActorId,
    filter: &DiscoveryFilter,
    cursor: Option<ActorId>,
    limit: usize,
    items: &mut Vec<Application>,
    next_cursor: &mut Option<ActorId>,
) -> bool {
    if cursor.map_or(false, |c| program_id <= c) {
        return false;
    }
    let Some(app) = reg.applications.get(&program_id) else {
        return false;
    };
    if filter.track.is_some_and(|track| app.track != track)
        || filter.status.is_some_and(|status| app.status != status)
    {
        return false;
    }
    if items.len() == limit {
        return true;
    }
    *next_cursor = Some(program_id);
    items.push(app.clone());
    items.len() == limit
}

fn insert_replacement_alias(reg: &mut RegistryState, current: ActorId, alias: ActorId) {
    reg.replacement_aliases_by_target
        .entry(current)
        .or_default()
        .insert(alias, true);
}

// ---------------------------------------------------------------------------
// Helpers for default auto-announce payload
// ---------------------------------------------------------------------------

fn default_registration_title(handle: &str) -> String {
    let mut s = String::from("@");
    s.push_str(handle);
    s.push_str(" registered");
    s
}

fn default_registration_body(req: &RegisterAppReq) -> String {
    // Clip to MAX_ANNOUNCEMENT_BODY. Description is already ≤ 280 per guards.
    req.description.clone()
}
