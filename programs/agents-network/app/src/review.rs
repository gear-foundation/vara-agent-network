//! Gear Foundation review service.
//!
//! Full public review history is event-only and indexer-backed. Protocol state
//! stores only reviewer membership, per-app revision guards, active request state,
//! and latest summary data needed to validate future mutations.

use crate::admin::AdminState;
use crate::guards;
use crate::registry::{self, RegistryState};
use crate::types::*;
use sails_rs::cell::RefCell;
use sails_rs::collections::BTreeMap;
use sails_rs::gstd::{exec, msg};
use sails_rs::prelude::*;

#[derive(Default)]
pub struct ReviewState {
    pub reviewers: BTreeMap<(u32, ActorId), bool>,
    pub summaries: BTreeMap<ActorId, ReviewSummary>,
    pub decisions: BTreeMap<(ActorId, u32), bool>,
    pub last_review_at: BTreeMap<ActorId, u64>,
}

#[sails_rs::event]
#[derive(Encode, Decode, TypeInfo, Clone, Debug, PartialEq, Eq)]
#[codec(crate = sails_rs::scale_codec)]
#[scale_info(crate = sails_rs::scale_info)]
pub enum ReviewEvent {
    ReviewerAdded {
        admin: ActorId,
        reviewer: ActorId,
        season_id: u32,
        ts: u64,
    },
    ReviewerRemoved {
        admin: ActorId,
        reviewer: ActorId,
        season_id: u32,
        ts: u64,
    },
    ReviewRequested {
        program_id: ActorId,
        owner: ActorId,
        revision: u32,
        reason: String,
        requested_at: u64,
        season_id: u32,
    },
    ReviewCommentPosted {
        program_id: ActorId,
        revision: u32,
        author: ActorId,
        author_role: ReviewAuthorRole,
        body: String,
        ts: u64,
        season_id: u32,
    },
    ReviewDecisionRecorded {
        program_id: ActorId,
        revision: u32,
        reviewer: ActorId,
        verdict: ReviewVerdict,
        reason: String,
        criteria: ReviewCriteria,
        old_status: AppStatus,
        new_status: AppStatus,
        decided_at: u64,
        season_id: u32,
    },
}

pub struct ReviewService<'a> {
    admin: &'a RefCell<AdminState>,
    registry: &'a RefCell<RegistryState>,
    review: &'a RefCell<ReviewState>,
    current_season: u32,
}

impl<'a> ReviewService<'a> {
    pub fn new(
        admin: &'a RefCell<AdminState>,
        registry: &'a RefCell<RegistryState>,
        review: &'a RefCell<ReviewState>,
        current_season: u32,
    ) -> Self {
        Self {
            admin,
            registry,
            review,
            current_season,
        }
    }

    fn ensure_admin(&self) -> Result<ActorId, ContractError> {
        let admin = self.admin.borrow().admin;
        if msg::source() != admin {
            return Err(ContractError::NotAdmin);
        }
        Ok(admin)
    }
}

#[sails_rs::service(events = ReviewEvent)]
impl<'a> ReviewService<'a> {
    #[export(unwrap_result)]
    pub fn add_reviewer(&mut self, reviewer: ActorId) -> Result<(), ContractError> {
        let admin = self.ensure_admin()?;
        if reviewer == ActorId::zero() {
            return Err(ContractError::UnknownReviewer);
        }
        let season_id = self.current_season;
        {
            let mut review = self.review.borrow_mut();
            if review
                .reviewers
                .get(&(season_id, reviewer))
                .copied()
                .unwrap_or(false)
            {
                return Err(ContractError::AlreadyRegistered);
            }
            review.reviewers.insert((season_id, reviewer), true);
        }
        let ts = exec::block_timestamp();
        self.emit_event(ReviewEvent::ReviewerAdded {
            admin,
            reviewer,
            season_id,
            ts,
        })
        .expect("emit ReviewerAdded failed");
        Ok(())
    }

    #[export(unwrap_result)]
    pub fn remove_reviewer(&mut self, reviewer: ActorId) -> Result<(), ContractError> {
        let admin = self.ensure_admin()?;
        let season_id = self.current_season;
        {
            let mut review = self.review.borrow_mut();
            if !review
                .reviewers
                .get(&(season_id, reviewer))
                .copied()
                .unwrap_or(false)
            {
                return Err(ContractError::UnknownReviewer);
            }
            review.reviewers.insert((season_id, reviewer), false);
        }
        let ts = exec::block_timestamp();
        self.emit_event(ReviewEvent::ReviewerRemoved {
            admin,
            reviewer,
            season_id,
            ts,
        })
        .expect("emit ReviewerRemoved failed");
        Ok(())
    }

    #[export]
    pub fn is_reviewer(&self, reviewer: ActorId) -> bool {
        is_active_reviewer(&self.review.borrow(), self.current_season, reviewer)
    }

    #[export]
    pub fn list_reviewers(&self) -> Vec<ActorId> {
        self.review
            .borrow()
            .reviewers
            .iter()
            .filter_map(|((season, reviewer), active)| {
                if *season == self.current_season && *active {
                    Some(*reviewer)
                } else {
                    None
                }
            })
            .collect()
    }

    #[export(unwrap_result)]
    pub fn request_review(
        &mut self,
        program_id: ActorId,
        reason: String,
    ) -> Result<(), ContractError> {
        let config = self.admin.borrow().config.clone();
        guards::ensure_user_mutations_allowed(&config)?;
        guards::ensure_review_enabled(&config)?;
        guards::check_review_body(&reason, &config)?;

        let caller = msg::source();
        let now = exec::block_timestamp();
        let season_id = self.current_season;
        let owner = {
            let reg = self.registry.borrow();
            registry::ensure_current_program_id(&reg, program_id)?;
            let app = reg
                .applications
                .get(&program_id)
                .ok_or(ContractError::UnknownApplication)?;
            if caller != app.owner {
                return Err(ContractError::NotOwner);
            }
            if app.status != AppStatus::Building {
                return Err(ContractError::ReviewNotAllowedForStatus);
            }
            app.owner
        };

        let revision = {
            let mut review = self.review.borrow_mut();
            ensure_rate_limit(&mut review, caller, now, config.review_rate_limit_ms)?;
            let summary = ensure_summary(&mut review, program_id);
            let revision = summary.pending_submission_revision.unwrap_or(1);
            if summary.active_request_revision == Some(revision) {
                return Err(ContractError::ReviewAlreadyRequested);
            }
            summary.active_request_revision = Some(revision);
            summary.active_request_acknowledged = false;
            summary.display_revision = Some(revision);
            summary.manual_override = false;
            revision
        };

        self.emit_event(ReviewEvent::ReviewRequested {
            program_id,
            owner,
            revision,
            reason,
            requested_at: now,
            season_id,
        })
        .expect("emit ReviewRequested failed");
        Ok(())
    }

    #[export(unwrap_result)]
    pub fn post_reviewer_comment(
        &mut self,
        program_id: ActorId,
        expected_revision: u32,
        body: String,
    ) -> Result<(), ContractError> {
        let (author, ts, season_id) = self.post_comment(
            program_id,
            expected_revision,
            &body,
            ReviewAuthorRole::Reviewer,
        )?;
        self.emit_event(ReviewEvent::ReviewCommentPosted {
            program_id,
            revision: expected_revision,
            author,
            author_role: ReviewAuthorRole::Reviewer,
            body,
            ts,
            season_id,
        })
        .expect("emit ReviewCommentPosted failed");
        Ok(())
    }

    #[export(unwrap_result)]
    pub fn owner_reply(
        &mut self,
        program_id: ActorId,
        expected_revision: u32,
        body: String,
    ) -> Result<(), ContractError> {
        let (author, ts, season_id) = self.post_comment(
            program_id,
            expected_revision,
            &body,
            ReviewAuthorRole::Owner,
        )?;
        self.emit_event(ReviewEvent::ReviewCommentPosted {
            program_id,
            revision: expected_revision,
            author,
            author_role: ReviewAuthorRole::Owner,
            body,
            ts,
            season_id,
        })
        .expect("emit ReviewCommentPosted failed");
        Ok(())
    }

    #[export(unwrap_result)]
    pub fn approve_for_listing(
        &mut self,
        program_id: ActorId,
        expected_revision: u32,
        reason: String,
        criteria: ReviewCriteria,
    ) -> Result<(), ContractError> {
        let (reviewer, old_status, new_status, decided_at, season_id) = self.decide(
            program_id,
            expected_revision,
            ReviewVerdict::ApprovedForListing,
            &reason,
            &criteria,
        )?;
        self.emit_event(ReviewEvent::ReviewDecisionRecorded {
            program_id,
            revision: expected_revision,
            reviewer,
            verdict: ReviewVerdict::ApprovedForListing,
            reason,
            criteria,
            old_status,
            new_status,
            decided_at,
            season_id,
        })
        .expect("emit ReviewDecisionRecorded failed");
        Ok(())
    }

    #[export(unwrap_result)]
    pub fn request_revision(
        &mut self,
        program_id: ActorId,
        expected_revision: u32,
        reason: String,
        criteria: ReviewCriteria,
    ) -> Result<(), ContractError> {
        let (reviewer, old_status, new_status, decided_at, season_id) = self.decide(
            program_id,
            expected_revision,
            ReviewVerdict::RevisionRequested,
            &reason,
            &criteria,
        )?;
        self.emit_event(ReviewEvent::ReviewDecisionRecorded {
            program_id,
            revision: expected_revision,
            reviewer,
            verdict: ReviewVerdict::RevisionRequested,
            reason,
            criteria,
            old_status,
            new_status,
            decided_at,
            season_id,
        })
        .expect("emit ReviewDecisionRecorded failed");
        Ok(())
    }

    #[export]
    pub fn get_review_summary(&self, program_id: ActorId) -> Option<ReviewSummary> {
        self.review.borrow().summaries.get(&program_id).cloned()
    }
}

impl<'a> ReviewService<'a> {
    fn post_comment(
        &mut self,
        program_id: ActorId,
        expected_revision: u32,
        body: &str,
        role: ReviewAuthorRole,
    ) -> Result<(ActorId, u64, u32), ContractError> {
        let config = self.admin.borrow().config.clone();
        guards::ensure_user_mutations_allowed(&config)?;
        guards::ensure_review_enabled(&config)?;
        guards::check_review_body(body, &config)?;

        let caller = msg::source();
        let season_id = self.current_season;
        {
            let reg = self.registry.borrow();
            registry::ensure_current_program_id(&reg, program_id)?;
            let app = reg
                .applications
                .get(&program_id)
                .ok_or(ContractError::UnknownApplication)?;
            ensure_reviewable_status(app.status)?;
            match role {
                ReviewAuthorRole::Reviewer => {
                    let review = self.review.borrow();
                    if !is_active_reviewer(&review, season_id, caller) {
                        return Err(ContractError::NotReviewer);
                    }
                    ensure_not_self_review(caller, app)?;
                }
                ReviewAuthorRole::Owner => {
                    if caller != app.owner {
                        return Err(ContractError::NotOwner);
                    }
                }
            }
        }

        let now = exec::block_timestamp();
        {
            let mut review = self.review.borrow_mut();
            ensure_rate_limit(&mut review, caller, now, config.review_rate_limit_ms)?;
            let summary = review
                .summaries
                .get_mut(&program_id)
                .ok_or(ContractError::ReviewRevisionMismatch)?;
            if summary.display_revision != Some(expected_revision) {
                return Err(ContractError::ReviewRevisionMismatch);
            }
            if role == ReviewAuthorRole::Reviewer
                && summary.active_request_revision == Some(expected_revision)
            {
                summary.active_request_acknowledged = true;
            }
            summary.total_comment_count = summary.total_comment_count.saturating_add(1);
            summary.current_revision_comment_count =
                summary.current_revision_comment_count.saturating_add(1);
        }

        Ok((caller, now, season_id))
    }

    fn decide(
        &mut self,
        program_id: ActorId,
        expected_revision: u32,
        verdict: ReviewVerdict,
        reason: &str,
        criteria: &ReviewCriteria,
    ) -> Result<(ActorId, AppStatus, AppStatus, u64, u32), ContractError> {
        let config = self.admin.borrow().config.clone();
        guards::ensure_user_mutations_allowed(&config)?;
        guards::ensure_review_enabled(&config)?;
        guards::check_review_body(reason, &config)?;
        guards::check_review_criteria(criteria)?;

        let caller = msg::source();
        let now = exec::block_timestamp();
        let season_id = self.current_season;
        let (old_status, new_status) = {
            let mut reg = self.registry.borrow_mut();
            registry::ensure_current_program_id(&reg, program_id)?;
            let mut review = self.review.borrow_mut();
            ensure_rate_limit(&mut review, caller, now, config.review_rate_limit_ms)?;
            if !is_active_reviewer(&review, season_id, caller) {
                return Err(ContractError::NotReviewer);
            }
            decide_application(
                &mut reg,
                &mut review,
                program_id,
                caller,
                expected_revision,
                verdict,
                reason.to_string(),
            )?
        };

        Ok((caller, old_status, new_status, now, season_id))
    }
}

pub fn init_application(review: &mut ReviewState, program_id: ActorId) {
    review
        .summaries
        .insert(program_id, initial_summary(program_id));
}

pub fn delete_application(review: &mut ReviewState, program_id: ActorId) {
    if let Some(summary) = review.summaries.get_mut(&program_id) {
        summary.active_request_revision = None;
        summary.active_request_acknowledged = false;
        summary.deleted = true;
    }
    review
        .decisions
        .retain(|(decision_program_id, _), _| *decision_program_id != program_id);
}

pub fn replace_application_program(
    review: &mut ReviewState,
    old_program_id: ActorId,
    new_program_id: ActorId,
) -> ReviewSummary {
    let mut summary = review
        .summaries
        .remove(&old_program_id)
        .unwrap_or_else(|| initial_summary(old_program_id));
    summary.program_id = new_program_id;
    review.summaries.insert(new_program_id, summary.clone());

    let decisions: Vec<((ActorId, u32), bool)> = review
        .decisions
        .iter()
        .filter_map(|((program_id, revision), decided)| {
            if *program_id == old_program_id {
                Some(((new_program_id, *revision), *decided))
            } else {
                None
            }
        })
        .collect();
    review
        .decisions
        .retain(|(program_id, _), _| *program_id != old_program_id);
    for (key, value) in decisions {
        review.decisions.insert(key, value);
    }

    summary
}

fn initial_summary(program_id: ActorId) -> ReviewSummary {
    ReviewSummary {
        program_id,
        pending_submission_revision: Some(1),
        submission_revision: None,
        display_revision: Some(1),
        active_request_revision: None,
        active_request_acknowledged: false,
        latest_verdict: None,
        latest_reviewer: None,
        latest_reason: None,
        current_revision_comment_count: 0,
        total_comment_count: 0,
        manual_override: false,
        deleted: false,
    }
}

pub fn manual_status_override(
    review: &mut ReviewState,
    program_id: ActorId,
    new_status: AppStatus,
) {
    if let Some(summary) = review.summaries.get_mut(&program_id) {
        if new_status == AppStatus::Building && summary.pending_submission_revision.is_none() {
            let next_revision = summary
                .display_revision
                .unwrap_or(0)
                .max(summary.submission_revision.unwrap_or(0))
                .saturating_add(1);
            summary.pending_submission_revision = Some(next_revision);
            summary.display_revision = Some(next_revision);
            summary.current_revision_comment_count = 0;
        }
        summary.active_request_revision = None;
        summary.active_request_acknowledged = false;
        summary.manual_override = true;
    }
}

pub fn submit_application(
    reg: &mut RegistryState,
    review: &mut ReviewState,
    program_id: ActorId,
    caller: ActorId,
    submitted_at: u64,
) -> Result<(ActorId, u32, ReviewRevisionSnapshot), ContractError> {
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

    let summary = ensure_summary(review, program_id);
    let revision = summary.pending_submission_revision.unwrap_or(1);
    let previous_display_revision = summary.display_revision;
    app.status = AppStatus::Submitted;
    summary.pending_submission_revision = None;
    summary.submission_revision = Some(revision);
    summary.display_revision = Some(revision);
    summary.active_request_revision = None;
    summary.active_request_acknowledged = false;
    if previous_display_revision != Some(revision) {
        summary.current_revision_comment_count = 0;
    }
    summary.manual_override = false;

    let snapshot = ReviewRevisionSnapshot {
        program_id,
        owner: app.owner,
        revision,
        handle: app.handle.clone(),
        description: app.description.clone(),
        track: app.track,
        github_url: app.github_url.clone(),
        skills_hash: app.skills_hash,
        skills_url: app.skills_url.clone(),
        idl_hash: app.idl_hash,
        idl_url: app.idl_url.clone(),
        contacts: app.contacts.clone(),
        submitted_at,
        season_id: app.season_id,
    };
    Ok((app.owner, revision, snapshot))
}

fn decide_application(
    reg: &mut RegistryState,
    review: &mut ReviewState,
    program_id: ActorId,
    reviewer: ActorId,
    expected_revision: u32,
    verdict: ReviewVerdict,
    reason: String,
) -> Result<(AppStatus, AppStatus), ContractError> {
    let app = reg
        .applications
        .get_mut(&program_id)
        .ok_or(ContractError::UnknownApplication)?;
    ensure_not_self_review(reviewer, app)?;
    if app.status != AppStatus::Submitted {
        return Err(ContractError::ReviewNotAllowedForStatus);
    }

    let summary = review
        .summaries
        .get_mut(&program_id)
        .ok_or(ContractError::ReviewRevisionMismatch)?;
    if summary.submission_revision != Some(expected_revision) {
        return Err(ContractError::ReviewRevisionMismatch);
    }
    if review
        .decisions
        .get(&(program_id, expected_revision))
        .copied()
        .unwrap_or(false)
    {
        return Err(ContractError::DecisionAlreadyRecorded);
    }

    let old_status = app.status;
    let new_status = match verdict {
        ReviewVerdict::ApprovedForListing => AppStatus::Live,
        ReviewVerdict::RevisionRequested => AppStatus::Building,
    };
    app.status = new_status;
    review
        .decisions
        .insert((program_id, expected_revision), true);

    summary.latest_verdict = Some(verdict);
    summary.latest_reviewer = Some(reviewer);
    summary.latest_reason = Some(reason);
    summary.active_request_revision = None;
    summary.active_request_acknowledged = false;
    summary.current_revision_comment_count = 0;
    summary.manual_override = false;
    if verdict == ReviewVerdict::RevisionRequested {
        let next_revision = expected_revision.saturating_add(1);
        summary.pending_submission_revision = Some(next_revision);
        summary.submission_revision = Some(expected_revision);
        summary.display_revision = Some(next_revision);
    } else {
        summary.pending_submission_revision = None;
        summary.submission_revision = Some(expected_revision);
        summary.display_revision = Some(expected_revision);
    }
    Ok((old_status, new_status))
}

fn ensure_rate_limit(
    review: &mut ReviewState,
    caller: ActorId,
    now: u64,
    min_gap_ms: u64,
) -> Result<(), ContractError> {
    guards::check_and_bump_rate_limit(&mut review.last_review_at, caller, now, min_gap_ms)
        .map_err(|()| ContractError::RateLimited)
}

fn is_active_reviewer(review: &ReviewState, season_id: u32, reviewer: ActorId) -> bool {
    review
        .reviewers
        .get(&(season_id, reviewer))
        .copied()
        .unwrap_or(false)
}

fn ensure_summary(review: &mut ReviewState, program_id: ActorId) -> &mut ReviewSummary {
    if !review.summaries.contains_key(&program_id) {
        init_application(review, program_id);
    }
    review
        .summaries
        .get_mut(&program_id)
        .expect("summary just initialized")
}

fn ensure_not_self_review(reviewer: ActorId, app: &Application) -> Result<(), ContractError> {
    if reviewer == app.owner || reviewer == app.program_id {
        return Err(ContractError::SelfReviewForbidden);
    }
    Ok(())
}

fn ensure_reviewable_status(status: AppStatus) -> Result<(), ContractError> {
    match status {
        AppStatus::Building | AppStatus::Submitted => Ok(()),
        _ => Err(ContractError::ReviewNotAllowedForStatus),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn app(program_id: ActorId, owner: ActorId) -> Application {
        Application {
            program_id,
            owner,
            handle: "legacy-app".to_string(),
            description: "legacy app".to_string(),
            track: Track::Services,
            github_url: "https://github.com/legacy-app".to_string(),
            skills_hash: [1; 32],
            skills_url: "https://example.com/legacy/skills.json".to_string(),
            idl_hash: [2; 32],
            idl_url: "https://example.com/legacy/agent.idl".to_string(),
            contacts: None,
            registered_at: 1,
            season_id: 1,
            status: AppStatus::Building,
        }
    }

    #[test]
    fn submit_legacy_application_initializes_missing_review_summary() {
        let program_id = ActorId::from(200u64);
        let owner = ActorId::from(101u64);
        let mut registry = RegistryState::default();
        registry
            .applications
            .insert(program_id, app(program_id, owner));
        let mut review = ReviewState::default();

        let (submitted_owner, revision, snapshot) =
            submit_application(&mut registry, &mut review, program_id, owner, 99).unwrap();

        assert_eq!(submitted_owner, owner);
        assert_eq!(revision, 1);
        assert_eq!(snapshot.revision, 1);
        assert_eq!(
            registry.applications.get(&program_id).unwrap().status,
            AppStatus::Submitted
        );

        let summary = review.summaries.get(&program_id).unwrap();
        assert_eq!(summary.submission_revision, Some(1));
        assert_eq!(summary.display_revision, Some(1));
        assert_eq!(summary.pending_submission_revision, None);
    }
}
