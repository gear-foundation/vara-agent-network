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
    ApplicationPruned {
        program_id: ActorId,
        owner: ActorId,
        handle: Handle,
        reason: String,
        pruned_at: u64,
        released_program_id: bool,
        season_id: u32,
    },
    ApplicationForceDeleted {
        program_id: ActorId,
        owner: ActorId,
        handle: Handle,
        reason: String,
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
    ApplicationPermitConsumed {
        approval_id: ApplicationPermitId,
        project_review_id: ProjectReviewId,
        purpose: ApplicationPermitPurpose,
        details_hash: Hash32,
        applicant: ActorId,
        coach: ActorId,
        evidence_message_id: ChatMsgId,
        consumed_program_id: ActorId,
        consumed_at: u64,
        season_id: u32,
    },
    ApplicationProjectReviewLinked {
        project_review_id: ProjectReviewId,
        owner: ActorId,
        program_id: ActorId,
        linked_at: u64,
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
    pub fn register_application(
        &mut self,
        req: RegisterApplicationWithApprovalReq,
    ) -> Result<(), ContractError> {
        let config = self.admin.borrow().config.clone();
        guards::ensure_application_registration_enabled(&config)?;
        guards::ensure_user_mutations_allowed(&config)?;
        guards::check_application_permit_details(&req.details)?;

        let caller = msg::source();
        let details = req.details;
        let program_id = details.program_id;
        let now = exec::block_timestamp();
        let season_id = self.current_season;

        let mut reg = self.registry.borrow_mut();
        let mut board = self.board.borrow_mut();
        let mut review = self.review.borrow_mut();

        if caller != details.operator && caller != program_id {
            return Err(ContractError::Unauthorized);
        }
        let permit = review
            .application_permits
            .get(&req.approval_id)
            .ok_or(ContractError::UnknownApplicationPermit)?;
        if permit.season_id != season_id || permit.purpose != ApplicationPermitPurpose::Register {
            return Err(ContractError::ApplicationPermitMismatch);
        }
        if permit.consumed_at.is_some() {
            return Err(ContractError::ApplicationPermitUsed);
        }
        let project_summary = review
            .project_summaries
            .get(&permit.project_review_id)
            .cloned()
            .ok_or(ContractError::UnknownProjectReview)?;
        review::validate_application_permit_request(
            &reg,
            &project_summary,
            ApplicationPermitPurpose::Register,
            &details,
        )?;
        let consumed = review::consume_application_permit(
            &mut review,
            req.approval_id,
            ApplicationPermitPurpose::Register,
            &details,
            program_id,
            now,
            season_id,
        )?;

        // Write registry state first; then push the kind=Registration
        // announcement into BoardState. Any panic below rolls back everything.
        let application = Application {
            program_id,
            owner: details.operator,
            handle: details.handle.clone(),
            description: details.description.clone(),
            track: details.track,
            github_url: details.github_url.clone(),
            skills_hash: details.skills_hash,
            skills_url: details.skills_url.clone(),
            idl_hash: details.idl_hash,
            idl_url: details.idl_url.clone(),
            contacts: details.contacts.clone(),
            registered_at: now,
            season_id,
            status: AppStatus::Building,
        };
        reg.applications.insert(program_id, application.clone());
        insert_application_indexes(&mut reg, &application);
        reg.handles
            .insert(details.handle.clone(), HandleRef::Application(program_id));
        reg.reserved_program_ids.insert(program_id, true);
        review::init_application(&mut review, program_id);
        review::link_project_review_after_registration(
            &mut review,
            consumed.project_review_id,
            details.operator,
            program_id,
            now,
        )?;

        // Shared helper — writes state, emits no events. RegistryService emits
        // the enriched `ApplicationRegistered`; indexer projects BOTH the
        // `Application` row AND the kind=Registration announcement from that
        // single event (body = description, title = "@{handle} registered").
        let registration_title = format!("@{} registered", details.handle);
        let registration_body = details.description.clone();
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
        drop(review);

        self.emit_event(RegistryEvent::ApplicationPermitConsumed {
            approval_id: consumed.approval_id,
            project_review_id: consumed.project_review_id,
            purpose: consumed.purpose,
            details_hash: consumed.details_hash,
            applicant: consumed.applicant,
            coach: consumed.coach,
            evidence_message_id: consumed.evidence_message_id,
            consumed_program_id: consumed.consumed_program_id,
            consumed_at: consumed.consumed_at,
            season_id: consumed.season_id,
        })
        .expect("emit ApplicationPermitConsumed failed");
        self.emit_event(RegistryEvent::ApplicationRegistered {
            program_id,
            owner: details.operator,
            handle: details.handle,
            description: details.description,
            track: details.track,
            github_url: details.github_url,
            skills_hash: details.skills_hash,
            skills_url: details.skills_url,
            idl_hash: details.idl_hash,
            idl_url: details.idl_url,
            contacts: details.contacts,
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
        self.emit_event(RegistryEvent::ApplicationProjectReviewLinked {
            project_review_id: consumed.project_review_id,
            owner: consumed.applicant,
            program_id,
            linked_at: now,
            season_id,
        })
        .expect("emit ApplicationProjectReviewLinked failed");

        Ok(())
    }

    #[export(unwrap_result)]
    pub fn update_application_contacts(
        &mut self,
        program_id: ActorId,
        contacts: Option<ContactLinks>,
    ) -> Result<(), ContractError> {
        let mut patch = ApplicationPatch::default();
        patch.contacts = Some(contacts);
        self.update_application_contacts_state(program_id, patch)
    }

    #[export(unwrap_result)]
    pub fn update_application_with_approval(
        &mut self,
        program_id: ActorId,
        approval_id: ApplicationPermitId,
        details: ApplicationPermitDetails,
    ) -> Result<(), ContractError> {
        self.apply_approved_metadata_update(
            program_id,
            approval_id,
            details,
            ApplicationPermitPurpose::UpdateMetadata,
        )
    }

    fn update_application_contacts_state(
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

    fn apply_approved_metadata_update(
        &mut self,
        program_id: ActorId,
        approval_id: ApplicationPermitId,
        details: ApplicationPermitDetails,
        purpose: ApplicationPermitPurpose,
    ) -> Result<(), ContractError> {
        let config = self.admin.borrow().config.clone();
        guards::ensure_user_mutations_allowed(&config)?;
        guards::check_application_permit_details(&details)?;

        let caller = msg::source();
        let now = exec::block_timestamp();
        let season_id = self.current_season;
        let mut reg = self.registry.borrow_mut();
        let mut review = self.review.borrow_mut();
        ensure_current_program_id(&reg, program_id)?;

        let permit = review
            .application_permits
            .get(&approval_id)
            .ok_or(ContractError::UnknownApplicationPermit)?;
        if permit.season_id != season_id || permit.purpose != purpose {
            return Err(ContractError::ApplicationPermitMismatch);
        }
        if permit.consumed_at.is_some() {
            return Err(ContractError::ApplicationPermitUsed);
        }
        let project_summary = review
            .project_summaries
            .get(&permit.project_review_id)
            .cloned()
            .ok_or(ContractError::UnknownProjectReview)?;
        review::validate_application_permit_request(&reg, &project_summary, purpose, &details)?;

        let (owner, current_handle, old_track, status) = {
            let app = reg
                .applications
                .get(&program_id)
                .ok_or(ContractError::UnknownApplication)?;
            (app.owner, app.handle.clone(), app.track, app.status)
        };
        if caller != owner {
            return Err(ContractError::NotOwner);
        }
        if details.operator != owner || details.program_id != program_id {
            return Err(ContractError::ApplicationPermitMismatch);
        }

        let consumed = review::consume_application_permit(
            &mut review,
            approval_id,
            purpose,
            &details,
            program_id,
            now,
            season_id,
        )?;
        let application = {
            let app = reg
                .applications
                .get_mut(&program_id)
                .ok_or(ContractError::UnknownApplication)?;
            app.handle = details.handle.clone();
            app.description = details.description.clone();
            app.track = details.track;
            app.github_url = details.github_url.clone();
            app.skills_hash = details.skills_hash;
            app.skills_url = details.skills_url.clone();
            app.idl_hash = details.idl_hash;
            app.idl_url = details.idl_url.clone();
            app.contacts = details.contacts.clone();
            app.clone()
        };
        if current_handle != details.handle {
            reg.handles.remove(&current_handle);
            reg.handles
                .insert(details.handle.clone(), HandleRef::Application(program_id));
        }
        if old_track != details.track {
            reindex_application_track(&mut reg, program_id, old_track, details.track, status);
        }
        drop(reg);
        drop(review);

        self.emit_event(RegistryEvent::ApplicationPermitConsumed {
            approval_id: consumed.approval_id,
            project_review_id: consumed.project_review_id,
            purpose: consumed.purpose,
            details_hash: consumed.details_hash,
            applicant: consumed.applicant,
            coach: consumed.coach,
            evidence_message_id: consumed.evidence_message_id,
            consumed_program_id: consumed.consumed_program_id,
            consumed_at: consumed.consumed_at,
            season_id: consumed.season_id,
        })
        .expect("emit ApplicationPermitConsumed failed");
        self.emit_event(RegistryEvent::ApplicationUpdated {
            program_id,
            patch: ApplicationPatch {
                handle: Some(application.handle.clone()),
                description: Some(application.description.clone()),
                track: Some(application.track),
                github_url: Some(application.github_url.clone()),
                skills_hash: Some(application.skills_hash),
                skills_url: Some(application.skills_url.clone()),
                idl_hash: Some(application.idl_hash),
                idl_url: Some(application.idl_url.clone()),
                contacts: Some(application.contacts.clone()),
            },
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

        if caller != app.owner {
            return Err(ContractError::NotOwner);
        }
        if !is_never_submitted_building(&self.review.borrow(), program_id, app.status) {
            return Err(ContractError::InvalidStatusTransition);
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
    pub fn admin_prune_application(
        &mut self,
        program_id: ActorId,
        reason: String,
    ) -> Result<(), ContractError> {
        self.ensure_admin()?;
        guards::check_replacement_reason(&reason, &self.admin.borrow().config)?;
        let (app, released_program_id, deleted_at, season_id) =
            self.delete_application_state(program_id, true)?;
        self.emit_event(RegistryEvent::ApplicationPruned {
            program_id,
            owner: app.owner,
            handle: app.handle,
            reason,
            pruned_at: deleted_at,
            released_program_id,
            season_id,
        })
        .expect("emit ApplicationPruned failed");
        Ok(())
    }

    #[export(unwrap_result)]
    pub fn admin_force_delete_application(
        &mut self,
        program_id: ActorId,
        reason: String,
    ) -> Result<(), ContractError> {
        self.ensure_admin()?;
        guards::check_replacement_reason(&reason, &self.admin.borrow().config)?;
        let (app, _, deleted_at, season_id) = self.delete_application_state(program_id, false)?;
        self.emit_event(RegistryEvent::ApplicationForceDeleted {
            program_id,
            owner: app.owner,
            handle: app.handle,
            reason,
            deleted_at,
            season_id,
        })
        .expect("emit ApplicationForceDeleted failed");
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
    pub fn apply_approved_application_transition(
        &mut self,
        current_program_id: ActorId,
        approval_id: ApplicationPermitId,
        details: ApplicationPermitDetails,
        reason: String,
    ) -> Result<(), ContractError> {
        let config = self.admin.borrow().config.clone();
        guards::ensure_user_mutations_allowed(&config)?;
        guards::check_application_permit_details(&details)?;
        guards::check_replacement_reason(&reason, &config)?;

        let old_program_id = current_program_id;
        let new_program_id = details.program_id;
        if old_program_id == new_program_id {
            return Err(ContractError::ProgramIdUnchanged);
        }

        let caller = msg::source();
        let now = exec::block_timestamp();
        let season_id = self.current_season;
        let (application, review_summary, replacement_count, consumed) = {
            let mut reg = self.registry.borrow_mut();
            let mut review = self.review.borrow_mut();
            ensure_current_program_id(&reg, old_program_id)?;

            let permit = review
                .application_permits
                .get(&approval_id)
                .ok_or(ContractError::UnknownApplicationPermit)?;
            if permit.season_id != season_id
                || permit.purpose != ApplicationPermitPurpose::ReplaceProgram
            {
                return Err(ContractError::ApplicationPermitMismatch);
            }
            if permit.consumed_at.is_some() {
                return Err(ContractError::ApplicationPermitUsed);
            }
            let project_summary = review
                .project_summaries
                .get(&permit.project_review_id)
                .cloned()
                .ok_or(ContractError::UnknownProjectReview)?;
            if project_summary.linked_program_id != Some(old_program_id) {
                return Err(ContractError::ProjectReviewRequired);
            }
            review::validate_application_permit_request(
                &reg,
                &project_summary,
                ApplicationPermitPurpose::ReplaceProgram,
                &details,
            )?;

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
            if details.operator != app.owner {
                reg.applications.insert(old_program_id, app);
                return Err(ContractError::ApplicationPermitMismatch);
            }

            let prior_count = reg.replacement_counts.remove(&old_program_id).unwrap_or(0);
            if prior_count >= MAX_PROGRAM_REPLACEMENTS {
                reg.replacement_counts.insert(old_program_id, prior_count);
                reg.applications.insert(old_program_id, app);
                return Err(ContractError::ProgramReplacementLimitReached);
            }
            let replacement_count = prior_count.saturating_add(1);

            remove_application_indexes(&mut reg, old_program_id, app.track, app.status);
            let old_handle = app.handle.clone();
            app.program_id = new_program_id;
            app.handle = details.handle.clone();
            app.description = details.description.clone();
            app.track = details.track;
            app.github_url = details.github_url.clone();
            app.skills_hash = details.skills_hash;
            app.skills_url = details.skills_url.clone();
            app.idl_hash = details.idl_hash;
            app.idl_url = details.idl_url.clone();
            app.contacts = details.contacts.clone();
            reg.applications.insert(new_program_id, app.clone());
            insert_application_indexes(&mut reg, &app);
            reg.reserved_program_ids.insert(new_program_id, true);
            reg.replacement_counts
                .insert(new_program_id, replacement_count);
            rewrite_replacement_aliases(&mut reg, old_program_id, new_program_id);

            if reg.handles.get(&old_handle) == Some(&HandleRef::Application(old_program_id)) {
                reg.handles.remove(&old_handle);
            }
            reg.handles
                .insert(app.handle.clone(), HandleRef::Application(new_program_id));

            let review_summary =
                review::replace_application_program(&mut review, old_program_id, new_program_id);
            let consumed = review::consume_application_permit(
                &mut review,
                approval_id,
                ApplicationPermitPurpose::ReplaceProgram,
                &details,
                new_program_id,
                now,
                season_id,
            )?;
            self.board
                .borrow_mut()
                .replace_application_program(old_program_id, new_program_id);
            self.chat
                .borrow_mut()
                .replace_application_program(old_program_id, new_program_id);

            (app, review_summary, replacement_count, consumed)
        };

        self.emit_event(RegistryEvent::ApplicationPermitConsumed {
            approval_id: consumed.approval_id,
            project_review_id: consumed.project_review_id,
            purpose: consumed.purpose,
            details_hash: consumed.details_hash,
            applicant: consumed.applicant,
            coach: consumed.coach,
            evidence_message_id: consumed.evidence_message_id,
            consumed_program_id: consumed.consumed_program_id,
            consumed_at: consumed.consumed_at,
            season_id: consumed.season_id,
        })
        .expect("emit ApplicationPermitConsumed failed");
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

    fn ensure_admin(&self) -> Result<(), ContractError> {
        if msg::source() != self.admin.borrow().admin {
            return Err(ContractError::NotAdmin);
        }
        Ok(())
    }

    fn delete_application_state(
        &mut self,
        program_id: ActorId,
        release_if_prunable: bool,
    ) -> Result<(Application, bool, u64, u32), ContractError> {
        let mut reg = self.registry.borrow_mut();
        ensure_current_program_id(&reg, program_id)?;
        let app = reg
            .applications
            .get(&program_id)
            .ok_or(ContractError::UnknownApplication)?
            .clone();
        let releasable = is_never_submitted_building(&self.review.borrow(), program_id, app.status);
        if release_if_prunable && !releasable {
            return Err(ContractError::InvalidStatusTransition);
        }
        reg.applications.remove(&program_id);
        remove_application_indexes(&mut reg, program_id, app.track, app.status);
        review::delete_application(&mut self.review.borrow_mut(), program_id);
        if reg.handles.get(&app.handle) == Some(&HandleRef::Application(program_id)) {
            reg.handles.remove(&app.handle);
        }
        let released_program_id = release_if_prunable && releasable;
        if released_program_id {
            reg.reserved_program_ids.remove(&program_id);
        }
        drop(reg);

        self.board.borrow_mut().remove_application(program_id);
        Ok((
            app,
            released_program_id,
            exec::block_timestamp(),
            self.current_season,
        ))
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

fn insert_application_indexes(_reg: &mut RegistryState, _app: &Application) {}

fn remove_application_indexes(
    _reg: &mut RegistryState,
    _program_id: ActorId,
    _track: Track,
    _status: AppStatus,
) {
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
    let _ = (reg, program_id, old_track, new_track, status);
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
    let _ = (reg, program_id, track, old_status, new_status);
}

pub(crate) fn import_participants(
    reg: &mut RegistryState,
    current_season: u32,
    entries: &[ParticipantMigrationEntry],
) -> Result<(), ContractError> {
    let mut seen_wallets = BTreeMap::new();
    let mut seen_handles = BTreeMap::new();
    for entry in entries {
        guards::validate_handle(&entry.participant.handle)?;
        if entry.participant.season_id != current_season
            || entry.wallet == ActorId::zero()
            || reg.participants.contains_key(&entry.wallet)
            || reg.handles.contains_key(&entry.participant.handle)
            || seen_wallets.insert(entry.wallet, ()).is_some()
            || seen_handles
                .insert(entry.participant.handle.clone(), ())
                .is_some()
        {
            return Err(ContractError::MigrationEntityConflict);
        }
    }

    for entry in entries {
        reg.participants
            .insert(entry.wallet, entry.participant.clone());
        reg.handles.insert(
            entry.participant.handle.clone(),
            HandleRef::Participant(entry.wallet),
        );
    }

    Ok(())
}

pub(crate) fn import_applications(
    reg: &mut RegistryState,
    review: &mut ReviewState,
    current_season: u32,
    entries: &[ApplicationMigrationEntry],
) -> Result<(), ContractError> {
    let mut seen_program_ids = BTreeMap::new();
    let mut seen_handles = BTreeMap::new();
    for entry in entries {
        let app = &entry.application;
        validate_migrated_application(app)?;
        if app.season_id != current_season
            || reg.applications.contains_key(&app.program_id)
            || reg.handles.contains_key(&app.handle)
            || reg.reserved_program_ids.contains_key(&app.program_id)
            || seen_program_ids.insert(app.program_id, ()).is_some()
            || seen_handles.insert(app.handle.clone(), ()).is_some()
        {
            return Err(ContractError::MigrationEntityConflict);
        }
    }

    for entry in entries {
        let app = entry.application.clone();
        reg.handles
            .insert(app.handle.clone(), HandleRef::Application(app.program_id));
        reg.reserved_program_ids.insert(app.program_id, true);
        insert_application_indexes(reg, &app);
        review::init_application(review, app.program_id);
        reg.applications.insert(app.program_id, app);
    }

    Ok(())
}

pub(crate) fn import_program_replacements(
    reg: &mut RegistryState,
    entries: &[ProgramReplacementMigrationEntry],
) -> Result<(), ContractError> {
    let mut seen_old_program_ids = BTreeMap::new();
    for entry in entries {
        if entry.old_program_id == ActorId::zero()
            || entry.new_program_id == ActorId::zero()
            || entry.old_program_id == entry.new_program_id
            || entry.replacement_count == 0
            || reg.applications.contains_key(&entry.old_program_id)
            || !reg.applications.contains_key(&entry.new_program_id)
            || reg.program_replacements.contains_key(&entry.old_program_id)
            || seen_old_program_ids
                .insert(entry.old_program_id, ())
                .is_some()
        {
            return Err(ContractError::MigrationEntityConflict);
        }
    }

    for entry in entries {
        reg.program_replacements
            .insert(entry.old_program_id, entry.new_program_id);
        insert_replacement_alias(reg, entry.new_program_id, entry.old_program_id);
        reg.reserved_program_ids.insert(entry.old_program_id, true);
        reg.reserved_program_ids.insert(entry.new_program_id, true);
        let replacement_count = reg
            .replacement_counts
            .get(&entry.new_program_id)
            .copied()
            .unwrap_or(0)
            .max(entry.replacement_count);
        reg.replacement_counts
            .insert(entry.new_program_id, replacement_count);
    }

    Ok(())
}

fn validate_migrated_application(app: &Application) -> Result<(), ContractError> {
    if app.program_id == ActorId::zero() || app.owner == ActorId::zero() {
        return Err(ContractError::MigrationEntityConflict);
    }
    guards::validate_handle(&app.handle)?;
    guards::validate_hash(&app.skills_hash)?;
    guards::validate_hash(&app.idl_hash)?;
    if app.github_url.len() > MAX_GITHUB_URL
        || app.skills_url.len() > MAX_SKILLS_URL
        || app.idl_url.len() > MAX_IDL_URL
        || app.description.len() > MAX_DESCRIPTION
    {
        return Err(ContractError::FieldTooLarge);
    }
    guards::validate_github_url(&app.github_url)?;
    guards::validate_idl_url(&app.idl_url)?;
    Ok(())
}

fn insert_replacement_alias(reg: &mut RegistryState, current: ActorId, alias: ActorId) {
    reg.replacement_aliases_by_target
        .entry(current)
        .or_default()
        .insert(alias, true);
}

fn is_never_submitted_building(
    review: &ReviewState,
    program_id: ActorId,
    status: AppStatus,
) -> bool {
    if status != AppStatus::Building {
        return false;
    }
    review.summaries.get(&program_id).is_none_or(|summary| {
        summary.submission_revision.is_none() && summary.latest_verdict.is_none()
    })
}
