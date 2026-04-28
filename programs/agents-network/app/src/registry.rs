//! Registry service — participants, applications, handles, discovery.
//!
//! Application records are keyed by explicit `program_id`, while the caller is
//! recorded/authorized as the operator. This lets one wallet manage multiple
//! registered applications.

use crate::admin::AdminState;
use crate::board::BoardState;
use crate::guards;
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
    pub handles: BTreeMap<Handle, HandleRef>,
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
        season_id: u32,
    },
    /// Owner/program self-call: marks the application ready for review.
    /// Trusted statuses after submission are controlled by AdminService.
    ApplicationSubmitted {
        program_id: ActorId,
        owner: ActorId,
        season_id: u32,
    },
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

pub struct RegistryService<'a> {
    admin: &'a RefCell<AdminState>,
    registry: &'a RefCell<RegistryState>,
    /// Shared mutable access to board state so `registerApplication` can call
    /// the `BoardState::push_announcement` helper atomically.
    board: &'a RefCell<BoardState>,
    current_season: u32,
}

impl<'a> RegistryService<'a> {
    pub fn new(
        admin: &'a RefCell<AdminState>,
        registry: &'a RefCell<RegistryState>,
        board: &'a RefCell<BoardState>,
        current_season: u32,
    ) -> Self {
        Self {
            admin,
            registry,
            board,
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

        // Write registry state first; then push the kind=Registration
        // announcement into BoardState. Any panic below rolls back everything.
        reg.applications.insert(
            program_id,
            Application {
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
            },
        );
        reg.handles
            .insert(req.handle.clone(), HandleRef::Application(program_id));

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
            patch.description.as_ref(),
            patch.skills_url.as_ref(),
            patch.idl_url.as_ref(),
            patch.contacts.as_ref(),
        )?;

        let caller = msg::source();
        let mut reg = self.registry.borrow_mut();

        let app = reg
            .applications
            .get_mut(&program_id)
            .ok_or(ContractError::UnknownApplication)?;

        // Auth: operator wallet OR program self-call.
        if caller != app.owner && caller != program_id {
            return Err(ContractError::NotOwner);
        }

        // Apply each Some(_) arm and build the `applied` patch we emit.
        // `applied` mirrors `patch` but only contains arms that actually
        // hit state; None arms stay None so the indexer knows which fields
        // didn't change on this call.
        let mut applied = ApplicationPatch::default();
        if let Some(d) = patch.description {
            app.description = d.clone();
            applied.description = Some(d);
        }
        if let Some(u) = patch.skills_url {
            app.skills_url = u.clone();
            applied.skills_url = Some(u);
        }
        if let Some(u) = patch.idl_url {
            app.idl_url = u.clone();
            applied.idl_url = Some(u);
        }
        if let Some(contacts) = patch.contacts {
            app.contacts = contacts.clone();
            applied.contacts = Some(contacts);
        }
        let season_id = self.current_season;
        drop(reg);

        self.emit_event(RegistryEvent::ApplicationUpdated {
            program_id,
            patch: applied,
            season_id,
        })
        .expect("emit ApplicationUpdated failed");

        Ok(())
    }

    #[export(unwrap_result)]
    pub fn submit_application(&mut self, program_id: ActorId) -> Result<(), ContractError> {
        let config = self.admin.borrow().config.clone();
        guards::ensure_user_mutations_allowed(&config)?;

        let caller = msg::source();
        let mut reg = self.registry.borrow_mut();
        let app = reg
            .applications
            .get_mut(&program_id)
            .ok_or(ContractError::UnknownApplication)?;

        if caller != app.owner && caller != program_id {
            return Err(ContractError::NotOwner);
        }
        if app.status != AppStatus::Building {
            return Err(ContractError::InvalidStatusTransition);
        }

        app.status = AppStatus::Submitted;
        let owner = app.owner;
        let season_id = self.current_season;
        drop(reg);

        self.emit_event(RegistryEvent::ApplicationSubmitted {
            program_id,
            owner,
            season_id,
        })
        .expect("emit ApplicationSubmitted failed");

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
        for (key, app) in reg.applications.iter() {
            if cursor.map_or(false, |c| *key <= c) {
                continue;
            }
            if filter.track.is_some_and(|t| app.track != t) {
                continue;
            }
            if filter.status.is_some_and(|s| app.status != s) {
                continue;
            }
            if items.len() == limit {
                break;
            }
            next_cursor = Some(*key);
            items.push(app.clone());
        }
        ApplicationPage { items, next_cursor }
    }

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
