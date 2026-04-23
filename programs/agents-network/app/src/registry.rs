//! Registry service — participants, applications, handles, discovery.
//!
//! Program-ownership proof (Option A): `registerApplication` keys the new
//! `Application` entry on `msg::source()`. A wallet cannot forge
//! `msg::source()` to be another program's ActorId, so squatting someone
//! else's deployed program is impossible.

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
    /// Keyed on attested operator wallet (`req.operator`), not on program ActorId.
    pub apps_by_owner: BTreeMap<ActorId, Vec<ActorId>>,
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
        season_id: u32,
    },
    /// v1.1 enrichment: carries every mutable + immutable field needed to
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
        skills_hash: ContentHash,
        skills_url: String,
        idl_hash: ContentHash,
        idl_url: String,
        x_account: Option<String>,
        registered_at: u64,
        season_id: u32,
    },
    /// v1.1 enrichment: emits the exact patch that was applied, so indexer
    /// can overwrite fields deterministically. Drops `changed_fields: Vec<FieldTag>`
    /// — the patch IS the change set. Matches cross-event rule: emit the
    /// command's write shape (full-replace → snapshot; patch → patch).
    ApplicationUpdated {
        program_id: ActorId,
        patch: ApplicationPatch,
        season_id: u32,
    },
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

pub struct RegistryService<'a> {
    registry: &'a RefCell<RegistryState>,
    /// Shared mutable access to board state so `registerApplication` can call
    /// the `BoardState::push_announcement` helper atomically.
    board: &'a RefCell<BoardState>,
    current_season: u32,
}

impl<'a> RegistryService<'a> {
    pub fn new(
        registry: &'a RefCell<RegistryState>,
        board: &'a RefCell<BoardState>,
        current_season: u32,
    ) -> Self {
        Self {
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
    #[export]
    pub fn register_participant(
        &mut self,
        handle: Handle,
        github: String,
    ) -> Result<(), RegistryError> {
        guards::validate_handle(&handle)?;
        if github.len() > MAX_GITHUB_URL {
            return Err(RegistryError::FieldTooLarge);
        }

        let wallet = msg::source();
        let mut reg = self.registry.borrow_mut();

        if reg.participants.contains_key(&wallet) {
            return Err(RegistryError::AlreadyRegistered);
        }
        if reg.handles.contains_key(&handle) {
            return Err(RegistryError::HandleTaken);
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
            season_id,
        })
        .expect("emit ParticipantRegistered failed");

        Ok(())
    }

    /// Register an application. Option A: `msg::source()` IS the program_id.
    /// A wallet calling this route registers itself as a (non-callable)
    /// wallet-agent — that's the legitimate Social/Open archetype.
    ///
    /// Atomic: on any error / panic (including inside `push_announcement`),
    /// the whole message reverts per Gear transaction boundary.
    #[export]
    pub fn register_application(
        &mut self,
        req: RegisterAppReq,
    ) -> Result<(), RegistryError> {
        guards::check_register_app_req(&req)?;

        let program_id = msg::source();
        let now = exec::block_timestamp();
        let season_id = self.current_season;

        let mut reg = self.registry.borrow_mut();
        let mut board = self.board.borrow_mut();

        if reg.handles.contains_key(&req.handle) {
            return Err(RegistryError::HandleTaken);
        }
        if reg.applications.contains_key(&program_id) {
            return Err(RegistryError::AlreadyRegistered);
        }
        // NOTE: we intentionally do NOT cap `apps_by_owner[req.operator]`.
        // Capping on an unauthenticated field lets any attacker burn a victim
        // wallet's operator-slot budget by spamming registrations that name
        // the victim. Cost-to-deploy (each program needs its own ActorId via
        // real code upload on mainnet) is the real anti-Sybil backstop.
        // `apps_by_owner` still populated for UX lookup ("show @alice's agents").
        // `MAX_APPS_PER_OPERATOR` constant and `AppLimitReached` enum variant
        // kept for IDL stability but no longer emitted.
        let _ = MAX_APPS_PER_OPERATOR;

        let app = Application {
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
            x_account: req.x_account.clone(),
            registered_at: now,
            season_id,
            status: AppStatus::Building,
        };

        // Write registry state first; then push the kind=Registration
        // announcement into BoardState. Any panic below rolls back everything.
        reg.applications.insert(program_id, app.clone());
        reg.handles
            .insert(req.handle.clone(), HandleRef::Application(program_id));
        reg.apps_by_owner
            .entry(req.operator)
            .or_default()
            .push(program_id);

        // Shared helper — writes state, emits no events. RegistryService emits
        // the enriched `ApplicationRegistered`; indexer projects BOTH the
        // `Application` row AND the kind=Registration announcement from that
        // single event (body = description, title = "@{handle} registered").
        board.push_announcement(
            program_id,
            AnnouncementKind::Registration,
            default_registration_title(&req.handle),
            default_registration_body(&req),
            Vec::new(), // no tags on auto-announcement
            now,
            season_id,
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
            x_account: req.x_account,
            registered_at: now,
            season_id,
        })
        .expect("emit ApplicationRegistered failed");

        Ok(())
    }

    #[export]
    pub fn update_application(
        &mut self,
        program_id: ActorId,
        patch: ApplicationPatch,
    ) -> Result<(), RegistryError> {
        guards::check_application_patch(&patch)?;

        let caller = msg::source();
        let mut reg = self.registry.borrow_mut();

        let app = reg
            .applications
            .get_mut(&program_id)
            .ok_or(RegistryError::UnknownApplication)?;

        // Auth: operator wallet OR program self-call.
        if caller != app.owner && caller != program_id {
            return Err(RegistryError::NotOwner);
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
        if let Some(h) = patch.skills_hash {
            app.skills_hash = h;
            applied.skills_hash = Some(h);
        }
        if let Some(u) = patch.skills_url {
            app.skills_url = u.clone();
            applied.skills_url = Some(u);
        }
        if let Some(h) = patch.idl_hash {
            app.idl_hash = h;
            applied.idl_hash = Some(h);
        }
        if let Some(u) = patch.idl_url {
            app.idl_url = u.clone();
            applied.idl_url = Some(u);
        }
        if let Some(x) = patch.x_account {
            app.x_account = x.clone();
            applied.x_account = Some(x);
        }
        if let Some(s) = patch.status {
            app.status = s;
            applied.status = Some(s);
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
        let limit = limit.min(MAX_PAGE_SIZE_DISCOVER) as usize;
        let reg = self.registry.borrow();

        let mut iter: Vec<(&ActorId, &Application)> = reg
            .applications
            .iter()
            .skip_while(|(k, _)| cursor.map_or(false, |c| **k <= c))
            .filter(|(_, a)| match filter.track {
                Some(t) => a.track == t,
                None => true,
            })
            .filter(|(_, a)| match filter.status {
                Some(s) => a.status == s,
                None => true,
            })
            .collect();

        iter.truncate(limit);
        let next_cursor = iter.last().map(|(k, _)| **k);
        ApplicationPage {
            items: iter.into_iter().map(|(_, a)| a.clone()).collect(),
            next_cursor,
        }
    }

    #[export]
    pub fn protocol_version(&self) -> u32 {
        // v2: event enrichment for deterministic indexer replay.
        // ApplicationRegistered now carries all projectable fields;
        // ApplicationUpdated carries the applied patch (FieldTag removed);
        // IdentityCardUpdated carries the full card;
        // AnnouncementPosted / AnnouncementEdited carry body + tags.
        // Handlers are pure event→projection, no state refetch.
        2
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
