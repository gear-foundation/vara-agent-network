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
    pub next_idea_id: IdeaReviewId,
    pub idea_summaries: BTreeMap<IdeaReviewId, IdeaReviewSummary>,
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
    IdeaReviewSubmitted {
        idea_id: IdeaReviewId,
        owner: ActorId,
        github_url: String,
        idea: String,
        submitted_at: u64,
        season_id: u32,
    },
    IdeaReviewCommentPosted {
        idea_id: IdeaReviewId,
        author: ActorId,
        author_role: ReviewAuthorRole,
        body: String,
        ts: u64,
        season_id: u32,
    },
    IdeaReviewGuidanceRecorded {
        idea_id: IdeaReviewId,
        reviewer: ActorId,
        outcome: IdeaGuidanceOutcome,
        body: String,
        ts: u64,
        season_id: u32,
    },
    IdeaReviewLinked {
        idea_id: IdeaReviewId,
        owner: ActorId,
        program_id: ActorId,
        linked_at: u64,
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
        self.post_comment_with_event(
            program_id,
            expected_revision,
            body,
            ReviewAuthorRole::Reviewer,
        )
    }

    #[export(unwrap_result)]
    pub fn owner_reply(
        &mut self,
        program_id: ActorId,
        expected_revision: u32,
        body: String,
    ) -> Result<(), ContractError> {
        self.post_comment_with_event(program_id, expected_revision, body, ReviewAuthorRole::Owner)
    }

    #[export(unwrap_result)]
    pub fn approve_for_listing(
        &mut self,
        program_id: ActorId,
        expected_revision: u32,
        reason: String,
        criteria: ReviewCriteria,
    ) -> Result<(), ContractError> {
        self.decide_with_event(
            program_id,
            expected_revision,
            reason,
            criteria,
            ReviewVerdict::ApprovedForListing,
        )
    }

    #[export(unwrap_result)]
    pub fn request_revision(
        &mut self,
        program_id: ActorId,
        expected_revision: u32,
        reason: String,
        criteria: ReviewCriteria,
    ) -> Result<(), ContractError> {
        self.decide_with_event(
            program_id,
            expected_revision,
            reason,
            criteria,
            ReviewVerdict::RevisionRequested,
        )
    }

    fn post_comment_with_event(
        &mut self,
        program_id: ActorId,
        expected_revision: u32,
        body: String,
        role: ReviewAuthorRole,
    ) -> Result<(), ContractError> {
        let outcome = self.post_comment(program_id, expected_revision, &body, role)?;
        self.emit_event(ReviewEvent::ReviewCommentPosted {
            program_id,
            revision: expected_revision,
            author: outcome.author,
            author_role: role,
            body,
            ts: outcome.ts,
            season_id: outcome.season_id,
        })
        .expect("emit ReviewCommentPosted failed");
        Ok(())
    }

    fn decide_with_event(
        &mut self,
        program_id: ActorId,
        expected_revision: u32,
        reason: String,
        criteria: ReviewCriteria,
        verdict: ReviewVerdict,
    ) -> Result<(), ContractError> {
        let outcome = self.decide(program_id, expected_revision, verdict, &reason, &criteria)?;
        self.emit_event(ReviewEvent::ReviewDecisionRecorded {
            program_id,
            revision: expected_revision,
            reviewer: outcome.reviewer,
            verdict,
            reason,
            criteria,
            old_status: outcome.old_status,
            new_status: outcome.new_status,
            decided_at: outcome.decided_at,
            season_id: outcome.season_id,
        })
        .expect("emit ReviewDecisionRecorded failed");
        Ok(())
    }

    #[export(unwrap_result)]
    pub fn submit_idea_review(
        &mut self,
        req: SubmitIdeaReviewReq,
    ) -> Result<IdeaReviewId, ContractError> {
        let config = self.admin.borrow().config.clone();
        guards::ensure_user_mutations_allowed(&config)?;
        guards::ensure_review_enabled(&config)?;
        guards::check_idea_review_req(&req, &config)?;

        let caller = msg::source();
        let now = exec::block_timestamp();
        let season_id = self.current_season;
        let idea_id = {
            let mut review = self.review.borrow_mut();
            ensure_rate_limit(&mut review, caller, now, config.review_rate_limit_ms)?;
            review.next_idea_id = review.next_idea_id.saturating_add(1);
            let idea_id = review.next_idea_id;
            review.idea_summaries.insert(
                idea_id,
                IdeaReviewSummary {
                    idea_id,
                    owner: caller,
                    github_url: req.github_url.clone(),
                    idea: req.idea.clone(),
                    status: IdeaReviewStatus::Submitted,
                    linked_program_id: None,
                    comment_count: 0,
                    latest_guidance_outcome: None,
                    latest_guidance: None,
                    latest_reviewer: None,
                    season_id,
                    created_at: now,
                    updated_at: now,
                },
            );
            idea_id
        };

        self.emit_event(ReviewEvent::IdeaReviewSubmitted {
            idea_id,
            owner: caller,
            github_url: req.github_url,
            idea: req.idea,
            submitted_at: now,
            season_id,
        })
        .expect("emit IdeaReviewSubmitted failed");

        Ok(idea_id)
    }

    #[export(unwrap_result)]
    pub fn post_idea_reviewer_comment(
        &mut self,
        idea_id: IdeaReviewId,
        body: String,
    ) -> Result<(), ContractError> {
        self.post_idea_comment_with_event(idea_id, body, ReviewAuthorRole::Reviewer)
    }

    #[export(unwrap_result)]
    pub fn owner_idea_reply(
        &mut self,
        idea_id: IdeaReviewId,
        body: String,
    ) -> Result<(), ContractError> {
        self.post_idea_comment_with_event(idea_id, body, ReviewAuthorRole::Owner)
    }

    #[export(unwrap_result)]
    pub fn record_idea_guidance(
        &mut self,
        idea_id: IdeaReviewId,
        outcome: IdeaGuidanceOutcome,
        body: String,
    ) -> Result<(), ContractError> {
        let result = self.record_idea_guidance_state(idea_id, outcome, &body)?;
        self.emit_event(ReviewEvent::IdeaReviewGuidanceRecorded {
            idea_id,
            reviewer: result.author,
            outcome,
            body,
            ts: result.ts,
            season_id: result.season_id,
        })
        .expect("emit IdeaReviewGuidanceRecorded failed");
        Ok(())
    }

    #[export(unwrap_result)]
    pub fn link_idea_review_to_application(
        &mut self,
        idea_id: IdeaReviewId,
        program_id: ActorId,
    ) -> Result<(), ContractError> {
        let config = self.admin.borrow().config.clone();
        guards::ensure_user_mutations_allowed(&config)?;
        guards::ensure_review_enabled(&config)?;

        let caller = msg::source();
        let now = exec::block_timestamp();
        let season_id = self.current_season;
        {
            let reg = self.registry.borrow();
            registry::ensure_current_program_id(&reg, program_id)?;
            let app = reg
                .applications
                .get(&program_id)
                .ok_or(ContractError::UnknownApplication)?;
            if caller != app.owner {
                return Err(ContractError::NotOwner);
            }
        }
        {
            let mut review = self.review.borrow_mut();
            ensure_rate_limit(&mut review, caller, now, config.review_rate_limit_ms)?;
            let summary = review
                .idea_summaries
                .get_mut(&idea_id)
                .ok_or(ContractError::UnknownIdeaReview)?;
            if summary.owner != caller {
                return Err(ContractError::NotOwner);
            }
            if summary.linked_program_id.is_some() {
                return Err(ContractError::IdeaAlreadyLinked);
            }
            summary.linked_program_id = Some(program_id);
            summary.status = IdeaReviewStatus::Linked;
            summary.updated_at = now;
        }

        self.emit_event(ReviewEvent::IdeaReviewLinked {
            idea_id,
            owner: caller,
            program_id,
            linked_at: now,
            season_id,
        })
        .expect("emit IdeaReviewLinked failed");
        Ok(())
    }

    #[export]
    pub fn get_review_summary(&self, program_id: ActorId) -> Option<ReviewSummary> {
        self.review.borrow().summaries.get(&program_id).cloned()
    }

    #[export]
    pub fn get_idea_review_summary(&self, idea_id: IdeaReviewId) -> Option<IdeaReviewSummary> {
        self.review.borrow().idea_summaries.get(&idea_id).cloned()
    }

    #[export]
    pub fn list_idea_review_summaries(
        &self,
        cursor: Option<IdeaReviewId>,
        limit: u32,
    ) -> IdeaReviewPage {
        let limit = guards::clamp_page_size(limit, MAX_PAGE_SIZE_LIST) as usize;
        let start_after = cursor.unwrap_or(0);
        let mut items = Vec::new();
        let mut next_cursor = None;
        for (idea_id, summary) in self.review.borrow().idea_summaries.iter() {
            if *idea_id <= start_after {
                continue;
            }
            items.push(summary.clone());
            if items.len() == limit {
                next_cursor = Some(*idea_id);
                break;
            }
        }
        IdeaReviewPage { items, next_cursor }
    }

    fn post_idea_comment_with_event(
        &mut self,
        idea_id: IdeaReviewId,
        body: String,
        role: ReviewAuthorRole,
    ) -> Result<(), ContractError> {
        let result = self.post_idea_comment(idea_id, &body, role)?;
        self.emit_event(ReviewEvent::IdeaReviewCommentPosted {
            idea_id,
            author: result.author,
            author_role: role,
            body,
            ts: result.ts,
            season_id: result.season_id,
        })
        .expect("emit IdeaReviewCommentPosted failed");
        Ok(())
    }
}

struct CommentOutcome {
    author: ActorId,
    ts: u64,
    season_id: u32,
}

struct DecisionOutcome {
    reviewer: ActorId,
    old_status: AppStatus,
    new_status: AppStatus,
    decided_at: u64,
    season_id: u32,
}

impl<'a> ReviewService<'a> {
    fn post_comment(
        &mut self,
        program_id: ActorId,
        expected_revision: u32,
        body: &str,
        role: ReviewAuthorRole,
    ) -> Result<CommentOutcome, ContractError> {
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

        Ok(CommentOutcome {
            author: caller,
            ts: now,
            season_id,
        })
    }

    fn decide(
        &mut self,
        program_id: ActorId,
        expected_revision: u32,
        verdict: ReviewVerdict,
        reason: &str,
        criteria: &ReviewCriteria,
    ) -> Result<DecisionOutcome, ContractError> {
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

        Ok(DecisionOutcome {
            reviewer: caller,
            old_status,
            new_status,
            decided_at: now,
            season_id,
        })
    }

    fn post_idea_comment(
        &mut self,
        idea_id: IdeaReviewId,
        body: &str,
        role: ReviewAuthorRole,
    ) -> Result<CommentOutcome, ContractError> {
        let config = self.admin.borrow().config.clone();
        guards::ensure_user_mutations_allowed(&config)?;
        guards::ensure_review_enabled(&config)?;
        guards::check_review_body(body, &config)?;

        let caller = msg::source();
        let now = exec::block_timestamp();
        let season_id = self.current_season;
        let mut review = self.review.borrow_mut();
        ensure_rate_limit(&mut review, caller, now, config.review_rate_limit_ms)?;
        match role {
            ReviewAuthorRole::Reviewer => {
                if !is_active_reviewer(&review, season_id, caller) {
                    return Err(ContractError::NotReviewer);
                }
                ensure_not_idea_self_review(&review, idea_id, caller)?;
            }
            ReviewAuthorRole::Owner => {
                let summary = review
                    .idea_summaries
                    .get(&idea_id)
                    .ok_or(ContractError::UnknownIdeaReview)?;
                if summary.owner != caller {
                    return Err(ContractError::NotOwner);
                }
            }
        }

        let summary = review
            .idea_summaries
            .get_mut(&idea_id)
            .ok_or(ContractError::UnknownIdeaReview)?;
        summary.comment_count = summary.comment_count.saturating_add(1);
        if summary.status == IdeaReviewStatus::Submitted {
            summary.status = IdeaReviewStatus::Commented;
        }
        summary.updated_at = now;

        Ok(CommentOutcome {
            author: caller,
            ts: now,
            season_id,
        })
    }

    fn record_idea_guidance_state(
        &mut self,
        idea_id: IdeaReviewId,
        outcome: IdeaGuidanceOutcome,
        body: &str,
    ) -> Result<CommentOutcome, ContractError> {
        let config = self.admin.borrow().config.clone();
        guards::ensure_user_mutations_allowed(&config)?;
        guards::ensure_review_enabled(&config)?;
        guards::check_review_body(body, &config)?;

        let caller = msg::source();
        let now = exec::block_timestamp();
        let season_id = self.current_season;
        let mut review = self.review.borrow_mut();
        ensure_rate_limit(&mut review, caller, now, config.review_rate_limit_ms)?;
        if !is_active_reviewer(&review, season_id, caller) {
            return Err(ContractError::NotReviewer);
        }
        ensure_not_idea_self_review(&review, idea_id, caller)?;

        let summary = review
            .idea_summaries
            .get_mut(&idea_id)
            .ok_or(ContractError::UnknownIdeaReview)?;
        if summary.linked_program_id.is_none() {
            summary.status = IdeaReviewStatus::GuidanceRecorded;
        }
        summary.latest_guidance_outcome = Some(outcome);
        summary.latest_guidance = Some(body.to_string());
        summary.latest_reviewer = Some(caller);
        summary.updated_at = now;

        Ok(CommentOutcome {
            author: caller,
            ts: now,
            season_id,
        })
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

    let mut decisions = Vec::new();
    review.decisions.retain(|(program_id, revision), decided| {
        if *program_id == old_program_id {
            decisions.push(((new_program_id, *revision), *decided));
            false
        } else {
            true
        }
    });
    for (key, value) in decisions {
        review.decisions.insert(key, value);
    }
    for idea in review.idea_summaries.values_mut() {
        if idea.linked_program_id == Some(old_program_id) {
            idea.linked_program_id = Some(new_program_id);
        }
    }

    summary
}

pub(crate) fn import_reviewers(
    review: &mut ReviewState,
    season_id: u32,
    reviewers: &[ActorId],
) -> Result<(), ContractError> {
    let mut seen = BTreeMap::new();
    for reviewer in reviewers {
        if *reviewer == ActorId::zero()
            || is_active_reviewer(review, season_id, *reviewer)
            || seen.insert(*reviewer, ()).is_some()
        {
            return Err(ContractError::MigrationEntityConflict);
        }
    }
    for reviewer in reviewers {
        review.reviewers.insert((season_id, *reviewer), true);
    }
    Ok(())
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
    let track = app.track;
    let new_status = match verdict {
        ReviewVerdict::ApprovedForListing => AppStatus::Live,
        ReviewVerdict::RevisionRequested => AppStatus::Building,
    };
    app.status = new_status;
    registry::reindex_application_status(reg, program_id, track, old_status, new_status);
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
    review
        .summaries
        .entry(program_id)
        .or_insert_with(|| initial_summary(program_id))
}

fn ensure_not_self_review(reviewer: ActorId, app: &Application) -> Result<(), ContractError> {
    if reviewer == app.owner || reviewer == app.program_id {
        return Err(ContractError::SelfReviewForbidden);
    }
    Ok(())
}

fn ensure_not_idea_self_review(
    review: &ReviewState,
    idea_id: IdeaReviewId,
    reviewer: ActorId,
) -> Result<(), ContractError> {
    let summary = review
        .idea_summaries
        .get(&idea_id)
        .ok_or(ContractError::UnknownIdeaReview)?;
    if summary.owner == reviewer {
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
