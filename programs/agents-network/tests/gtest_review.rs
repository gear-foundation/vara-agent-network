//! Review service lifecycle tests.

mod common;

use agents_network_client::{
    AgentsNetworkClient, AppStatus, ProjectGuidanceOutcome, ProjectReviewStatus, ReviewVerdict,
    SubmitProjectReviewReq, admin::Admin, registry::Registry, review::Review,
};
use common::*;
use sails_rs::client::*;

async fn link_approved_project_review(
    program: &Actor<agents_network_client::AgentsNetworkClientProgram, GtestEnv>,
    owner: u64,
    reviewer: u64,
    handle: &str,
    program_id: u64,
) -> u64 {
    if let Some(project_review_id) = linked_project_review_id(program, program_id).await {
        return project_review_id;
    }
    let project_review_id = program
        .review()
        .submit_project_review(SubmitProjectReviewReq {
            github_url: format!("https://github.com/alice/{handle}"),
            idea: format!("{handle} provides useful network value"),
        })
        .with_actor_id(owner.into())
        .await
        .unwrap();
    program
        .review()
        .record_project_guidance(
            project_review_id,
            ProjectGuidanceOutcome::Proceed,
            "ready to build".to_string(),
        )
        .with_actor_id(reviewer.into())
        .await
        .unwrap();
    program
        .review()
        .link_project_review_to_application(project_review_id, program_id.into())
        .with_actor_id(owner.into())
        .await
        .unwrap();
    project_review_id
}

#[tokio::test]
async fn coach_role_is_admin_granted_and_publicly_queryable() {
    let system = init_system();
    let env = GtestEnv::new(system, DEPLOYER.into());
    let program = deploy(&env).await;

    program
        .review()
        .add_coach(CAROL.into())
        .with_actor_id(ALICE.into())
        .await
        .unwrap_err();
    program
        .review()
        .add_coach(0.into())
        .with_actor_id(DEPLOYER.into())
        .await
        .unwrap_err();

    program
        .review()
        .add_coach(CAROL.into())
        .with_actor_id(DEPLOYER.into())
        .await
        .unwrap();
    assert!(program.review().is_coach(CAROL.into()).await.unwrap());
    assert_eq!(
        program.review().list_coaches().await.unwrap(),
        vec![CAROL.into()]
    );
    program
        .review()
        .add_coach(CAROL.into())
        .with_actor_id(DEPLOYER.into())
        .await
        .unwrap_err();

    program
        .review()
        .remove_coach(CAROL.into())
        .with_actor_id(DEPLOYER.into())
        .await
        .unwrap();
    assert!(!program.review().is_coach(CAROL.into()).await.unwrap());
    assert!(program.review().list_coaches().await.unwrap().is_empty());
}

#[tokio::test]
async fn project_review_submission_requires_active_coach_approval_by_default() {
    let system = init_system();
    let env = GtestEnv::new(system, DEPLOYER.into());
    let program = deploy(&env).await;
    let mut config = program.admin().get_config().await.unwrap();
    config.review_rate_limit_ms = 0;
    program
        .admin()
        .update_config(config)
        .with_actor_id(DEPLOYER.into())
        .await
        .unwrap();

    let req = SubmitProjectReviewReq {
        github_url: "https://github.com/alice/coach-gated-agent".to_string(),
        idea: "agent that only opens after public coach approval".to_string(),
    };

    program
        .review()
        .submit_project_review(req.clone())
        .with_actor_id(ALICE.into())
        .await
        .unwrap_err();
    program
        .review()
        .approve_project_review_submission(ALICE.into(), 7)
        .with_actor_id(CAROL.into())
        .await
        .unwrap_err();
    program
        .review()
        .add_coach(CAROL.into())
        .with_actor_id(DEPLOYER.into())
        .await
        .unwrap();
    program
        .review()
        .approve_project_review_submission(CAROL.into(), 8)
        .with_actor_id(CAROL.into())
        .await
        .unwrap_err();

    let approval_id = program
        .review()
        .approve_project_review_submission(ALICE.into(), 7)
        .with_actor_id(CAROL.into())
        .await
        .unwrap();
    let project_review_id = program
        .review()
        .submit_approved_project_review(req.clone(), approval_id)
        .with_actor_id(ALICE.into())
        .await
        .unwrap();
    let summary = program
        .review()
        .get_project_review_summary(project_review_id)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(summary.owner, ALICE.into());

    program
        .review()
        .submit_approved_project_review(req.clone(), approval_id)
        .with_actor_id(ALICE.into())
        .await
        .unwrap_err();
}

#[tokio::test]
async fn removing_coach_invalidates_unconsumed_approval() {
    let system = init_system();
    let env = GtestEnv::new(system, DEPLOYER.into());
    let program = deploy(&env).await;
    let mut config = program.admin().get_config().await.unwrap();
    config.review_rate_limit_ms = 0;
    program
        .admin()
        .update_config(config)
        .with_actor_id(DEPLOYER.into())
        .await
        .unwrap();

    program
        .review()
        .add_coach(CAROL.into())
        .with_actor_id(DEPLOYER.into())
        .await
        .unwrap();
    let approval_id = program
        .review()
        .approve_project_review_submission(ALICE.into(), 12)
        .with_actor_id(CAROL.into())
        .await
        .unwrap();
    program
        .review()
        .remove_coach(CAROL.into())
        .with_actor_id(DEPLOYER.into())
        .await
        .unwrap();

    program
        .review()
        .submit_approved_project_review(
            SubmitProjectReviewReq {
                github_url: "https://github.com/alice/stale-coach".to_string(),
                idea: "approval should fail after coach removal".to_string(),
            },
            approval_id,
        )
        .with_actor_id(ALICE.into())
        .await
        .unwrap_err();
}

#[tokio::test]
async fn config_can_disable_project_review_approval_gate() {
    let system = init_system();
    let env = GtestEnv::new(system, DEPLOYER.into());
    let program = deploy(&env).await;
    let mut config = program.admin().get_config().await.unwrap();
    config.review_rate_limit_ms = 0;
    config.require_project_review_approval = false;
    program
        .admin()
        .update_config(config)
        .with_actor_id(DEPLOYER.into())
        .await
        .unwrap();

    let project_review_id = program
        .review()
        .submit_project_review(SubmitProjectReviewReq {
            github_url: "https://github.com/alice/legacy-open-submit".to_string(),
            idea: "legacy open submission remains admin configurable".to_string(),
        })
        .with_actor_id(ALICE.into())
        .await
        .unwrap();
    assert_eq!(project_review_id, 1);
}

#[tokio::test]
async fn reviewer_revision_request_then_listing_approval_loop_tracks_revisions() {
    let system = init_system();
    let env = GtestEnv::new(system, DEPLOYER.into());
    let program = deploy(&env).await;
    disable_review_rate_limit(&program).await;

    program
        .review()
        .add_reviewer(CAROL.into())
        .with_actor_id(DEPLOYER.into())
        .await
        .unwrap();

    register_application_for_test(
        &program,
        mk_register_req("reviewed-app", ALICE, STUB_PROGRAM_ALPHA),
        STUB_PROGRAM_ALPHA,
    )
    .await;
    link_approved_project_review(&program, ALICE, CAROL, "reviewed-app", STUB_PROGRAM_ALPHA).await;

    let summary = program
        .review()
        .get_review_summary(STUB_PROGRAM_ALPHA.into())
        .await
        .unwrap()
        .expect("summary initialized at registration");
    assert_eq!(summary.pending_submission_revision, Some(1));
    assert_eq!(summary.display_revision, Some(1));

    program
        .review()
        .request_review(
            STUB_PROGRAM_ALPHA.into(),
            "please check the agent".to_string(),
        )
        .with_actor_id(ALICE.into())
        .await
        .unwrap();

    program
        .review()
        .post_reviewer_comment(STUB_PROGRAM_ALPHA.into(), 1, "add usage proof".to_string())
        .with_actor_id(CAROL.into())
        .await
        .unwrap();

    program
        .review()
        .owner_reply(STUB_PROGRAM_ALPHA.into(), 1, "added proof".to_string())
        .with_actor_id(ALICE.into())
        .await
        .unwrap();

    let summary = program
        .review()
        .get_review_summary(STUB_PROGRAM_ALPHA.into())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(summary.active_request_revision, Some(1));
    assert!(summary.active_request_acknowledged);
    assert_eq!(summary.current_revision_comment_count, 2);

    program
        .registry()
        .submit_application(STUB_PROGRAM_ALPHA.into())
        .with_actor_id(ALICE.into())
        .await
        .unwrap();

    let summary = program
        .review()
        .get_review_summary(STUB_PROGRAM_ALPHA.into())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(summary.submission_revision, Some(1));
    assert_eq!(summary.display_revision, Some(1));
    assert_eq!(summary.current_revision_comment_count, 2);

    program
        .review()
        .request_revision(
            STUB_PROGRAM_ALPHA.into(),
            1,
            "needs a runnable demo".to_string(),
            criteria(),
        )
        .with_actor_id(CAROL.into())
        .await
        .unwrap();

    let app = program
        .registry()
        .get_application(STUB_PROGRAM_ALPHA.into())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(app.status, AppStatus::Building);

    let summary = program
        .review()
        .get_review_summary(STUB_PROGRAM_ALPHA.into())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        summary.latest_verdict,
        Some(ReviewVerdict::RevisionRequested)
    );
    assert_eq!(summary.pending_submission_revision, Some(2));
    assert_eq!(summary.submission_revision, Some(1));
    assert_eq!(summary.display_revision, Some(2));
    assert_eq!(summary.current_revision_comment_count, 0);

    program
        .review()
        .approve_for_listing(
            STUB_PROGRAM_ALPHA.into(),
            1,
            "stale retry".to_string(),
            criteria(),
        )
        .with_actor_id(CAROL.into())
        .await
        .unwrap_err();

    program
        .registry()
        .submit_application(STUB_PROGRAM_ALPHA.into())
        .with_actor_id(ALICE.into())
        .await
        .unwrap();

    program
        .review()
        .approve_for_listing(
            STUB_PROGRAM_ALPHA.into(),
            2,
            "ready for public listing".to_string(),
            criteria(),
        )
        .with_actor_id(CAROL.into())
        .await
        .unwrap();

    let app = program
        .registry()
        .get_application(STUB_PROGRAM_ALPHA.into())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(app.status, AppStatus::Live);

    let summary = program
        .review()
        .get_review_summary(STUB_PROGRAM_ALPHA.into())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        summary.latest_verdict,
        Some(ReviewVerdict::ApprovedForListing)
    );
    assert_eq!(summary.submission_revision, Some(2));
    assert_eq!(summary.display_revision, Some(2));
    assert_eq!(summary.pending_submission_revision, None);
}

#[tokio::test]
async fn review_guards_reject_self_review_and_stale_revision() {
    let system = init_system();
    let env = GtestEnv::new(system, DEPLOYER.into());
    let program = deploy(&env).await;
    disable_review_rate_limit(&program).await;

    program
        .review()
        .add_reviewer(ALICE.into())
        .with_actor_id(DEPLOYER.into())
        .await
        .unwrap();
    program
        .review()
        .add_reviewer(CAROL.into())
        .with_actor_id(DEPLOYER.into())
        .await
        .unwrap();

    register_application_for_test(
        &program,
        mk_register_req("guarded-app", ALICE, STUB_PROGRAM_ALPHA),
        STUB_PROGRAM_ALPHA,
    )
    .await;
    link_approved_project_review(&program, ALICE, CAROL, "guarded-app", STUB_PROGRAM_ALPHA).await;

    program
        .review()
        .post_reviewer_comment(STUB_PROGRAM_ALPHA.into(), 1, "owner reviewer".to_string())
        .with_actor_id(ALICE.into())
        .await
        .unwrap_err();

    program
        .review()
        .post_reviewer_comment(STUB_PROGRAM_ALPHA.into(), 99, "stale".to_string())
        .with_actor_id(CAROL.into())
        .await
        .unwrap_err();

    program
        .registry()
        .submit_application(STUB_PROGRAM_ALPHA.into())
        .with_actor_id(ALICE.into())
        .await
        .unwrap();

    program
        .review()
        .approve_for_listing(
            STUB_PROGRAM_ALPHA.into(),
            1,
            "owner reviewer cannot approve".to_string(),
            criteria(),
        )
        .with_actor_id(ALICE.into())
        .await
        .unwrap_err();

    program
        .review()
        .request_revision(
            STUB_PROGRAM_ALPHA.into(),
            1,
            "owner reviewer cannot request revision".to_string(),
            criteria(),
        )
        .with_actor_id(ALICE.into())
        .await
        .unwrap_err();
}

#[tokio::test]
async fn manual_reopen_to_building_submits_next_revision() {
    let system = init_system();
    let env = GtestEnv::new(system, DEPLOYER.into());
    let program = deploy(&env).await;
    disable_review_rate_limit(&program).await;

    program
        .review()
        .add_reviewer(CAROL.into())
        .with_actor_id(DEPLOYER.into())
        .await
        .unwrap();

    register_application_for_test(
        &program,
        mk_register_req("reopened-app", ALICE, STUB_PROGRAM_ALPHA),
        STUB_PROGRAM_ALPHA,
    )
    .await;
    link_approved_project_review(&program, ALICE, CAROL, "reopened-app", STUB_PROGRAM_ALPHA).await;

    program
        .registry()
        .submit_application(STUB_PROGRAM_ALPHA.into())
        .with_actor_id(ALICE.into())
        .await
        .unwrap();

    program
        .review()
        .approve_for_listing(
            STUB_PROGRAM_ALPHA.into(),
            1,
            "initially ready".to_string(),
            criteria(),
        )
        .with_actor_id(CAROL.into())
        .await
        .unwrap();

    program
        .admin()
        .set_application_status(STUB_PROGRAM_ALPHA.into(), AppStatus::Building)
        .with_actor_id(DEPLOYER.into())
        .await
        .unwrap();

    let summary = program
        .review()
        .get_review_summary(STUB_PROGRAM_ALPHA.into())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(summary.pending_submission_revision, Some(2));
    assert_eq!(summary.display_revision, Some(2));
    assert!(summary.manual_override);

    program
        .registry()
        .submit_application(STUB_PROGRAM_ALPHA.into())
        .with_actor_id(ALICE.into())
        .await
        .unwrap();

    let summary = program
        .review()
        .get_review_summary(STUB_PROGRAM_ALPHA.into())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(summary.submission_revision, Some(2));
    assert_eq!(summary.display_revision, Some(2));
    assert_eq!(summary.pending_submission_revision, None);

    program
        .review()
        .approve_for_listing(
            STUB_PROGRAM_ALPHA.into(),
            1,
            "old revision should stay closed".to_string(),
            criteria(),
        )
        .with_actor_id(CAROL.into())
        .await
        .unwrap_err();

    program
        .review()
        .approve_for_listing(
            STUB_PROGRAM_ALPHA.into(),
            2,
            "reopened revision is ready".to_string(),
            criteria(),
        )
        .with_actor_id(CAROL.into())
        .await
        .unwrap();
}

#[tokio::test]
async fn re_registered_application_can_receive_fresh_revision_one_decision() {
    let system = init_system();
    let env = GtestEnv::new(system, DEPLOYER.into());
    let program = deploy(&env).await;
    disable_review_rate_limit(&program).await;

    program
        .review()
        .add_reviewer(CAROL.into())
        .with_actor_id(DEPLOYER.into())
        .await
        .unwrap();

    register_application_for_test(
        &program,
        mk_register_req("reviewed-then-deleted", ALICE, STUB_PROGRAM_ALPHA),
        STUB_PROGRAM_ALPHA,
    )
    .await;
    link_approved_project_review(
        &program,
        ALICE,
        CAROL,
        "reviewed-then-deleted",
        STUB_PROGRAM_ALPHA,
    )
    .await;
    program
        .registry()
        .submit_application(STUB_PROGRAM_ALPHA.into())
        .with_actor_id(ALICE.into())
        .await
        .unwrap();
    program
        .review()
        .approve_for_listing(
            STUB_PROGRAM_ALPHA.into(),
            1,
            "first listing".to_string(),
            criteria(),
        )
        .with_actor_id(CAROL.into())
        .await
        .unwrap();

    program
        .registry()
        .admin_force_delete_application(
            STUB_PROGRAM_ALPHA.into(),
            "reset review fixture".to_string(),
        )
        .with_actor_id(DEPLOYER.into())
        .await
        .unwrap();
    register_application_for_test(
        &program,
        mk_register_req("reviewed-again", ALICE, STUB_PROGRAM_BETA),
        STUB_PROGRAM_BETA,
    )
    .await;
    link_approved_project_review(&program, ALICE, CAROL, "reviewed-again", STUB_PROGRAM_BETA).await;
    program
        .registry()
        .submit_application(STUB_PROGRAM_BETA.into())
        .with_actor_id(ALICE.into())
        .await
        .unwrap();

    let summary = program
        .review()
        .get_review_summary(STUB_PROGRAM_BETA.into())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(summary.submission_revision, Some(1));
    assert_eq!(summary.latest_verdict, None);

    program
        .review()
        .request_revision(
            STUB_PROGRAM_BETA.into(),
            1,
            "fresh review can decide revision one".to_string(),
            criteria(),
        )
        .with_actor_id(CAROL.into())
        .await
        .unwrap();

    let summary = program
        .review()
        .get_review_summary(STUB_PROGRAM_BETA.into())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        summary.latest_verdict,
        Some(ReviewVerdict::RevisionRequested)
    );
    assert_eq!(summary.pending_submission_revision, Some(2));
}

#[tokio::test]
async fn project_review_guidance_link_and_program_replacement_preserve_predeploy_thread() {
    let system = init_system();
    let env = GtestEnv::new(system, DEPLOYER.into());
    let program = deploy(&env).await;
    disable_review_rate_limit(&program).await;

    program
        .review()
        .add_reviewer(CAROL.into())
        .with_actor_id(DEPLOYER.into())
        .await
        .unwrap();
    program
        .review()
        .add_reviewer(ALICE.into())
        .with_actor_id(DEPLOYER.into())
        .await
        .unwrap();

    let project_review_id = program
        .review()
        .submit_project_review(SubmitProjectReviewReq {
            github_url: "https://github.com/alice/idea-agent".to_string(),
            idea: "agent that helps builders find valuable integrations".to_string(),
        })
        .with_actor_id(ALICE.into())
        .await
        .unwrap();

    program
        .review()
        .post_project_reviewer_comment(project_review_id, "focus on integration demand".to_string())
        .with_actor_id(ALICE.into())
        .await
        .unwrap_err();

    program
        .review()
        .post_project_reviewer_comment(project_review_id, "focus on integration demand".to_string())
        .with_actor_id(CAROL.into())
        .await
        .unwrap();

    program
        .review()
        .owner_project_reply(
            project_review_id,
            "will target app-to-app matching".to_string(),
        )
        .with_actor_id(ALICE.into())
        .await
        .unwrap();

    program
        .review()
        .record_project_guidance(
            project_review_id,
            ProjectGuidanceOutcome::Proceed,
            "valuable if it proves demand with one consuming app".to_string(),
        )
        .with_actor_id(CAROL.into())
        .await
        .unwrap();

    let idea = program
        .review()
        .get_project_review_summary(project_review_id)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(idea.status, ProjectReviewStatus::GuidanceRecorded);
    assert_eq!(idea.comment_count, 2);
    assert_eq!(
        idea.latest_guidance_outcome,
        Some(ProjectGuidanceOutcome::Proceed)
    );

    register_application_for_test(
        &program,
        mk_register_req("idea-agent", BOB, STUB_PROGRAM_ALPHA),
        STUB_PROGRAM_ALPHA,
    )
    .await;
    program
        .review()
        .link_project_review_to_application(project_review_id, STUB_PROGRAM_ALPHA.into())
        .with_actor_id(ALICE.into())
        .await
        .unwrap_err();

    program
        .registry()
        .delete_application(STUB_PROGRAM_ALPHA.into())
        .with_actor_id(BOB.into())
        .await
        .unwrap();
    let details = mk_register_req("idea-agent", ALICE, STUB_PROGRAM_BETA);
    let approval_id = approve_application_permit_for_test(
        &program,
        project_review_id,
        agents_network_client::ApplicationPermitPurpose::Register,
        details.clone(),
    )
    .await;
    program
        .registry()
        .register_application(agents_network_client::RegisterApplicationWithApprovalReq {
            approval_id,
            details,
        })
        .with_actor_id(STUB_PROGRAM_BETA.into())
        .await
        .unwrap();

    let linked = program
        .review()
        .get_project_review_summary(project_review_id)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(linked.status, ProjectReviewStatus::Linked);
    assert_eq!(linked.linked_program_id, Some(STUB_PROGRAM_BETA.into()));

    replace_application_program_for_test(
        &program,
        STUB_PROGRAM_BETA,
        mk_register_req("idea-agent", ALICE, STUB_PROGRAM_GAMMA),
        ALICE,
        "new deployment after review guidance",
    )
    .await;

    let replaced = program
        .review()
        .get_project_review_summary(project_review_id)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(replaced.linked_program_id, Some(STUB_PROGRAM_GAMMA.into()));
}

#[tokio::test]
async fn project_review_respects_paused_and_review_disabled_config() {
    let system = init_system();
    let env = GtestEnv::new(system, DEPLOYER.into());
    let program = deploy(&env).await;

    let mut config = program.admin().get_config().await.unwrap();
    config.review_rate_limit_ms = 0;
    config.paused = true;
    program
        .admin()
        .update_config(config.clone())
        .with_actor_id(DEPLOYER.into())
        .await
        .unwrap();
    program
        .review()
        .submit_project_review(SubmitProjectReviewReq {
            github_url: "https://github.com/alice/idea-agent".to_string(),
            idea: "agent that helps builders find valuable integrations".to_string(),
        })
        .with_actor_id(ALICE.into())
        .await
        .unwrap_err();

    config.paused = false;
    config.allow_review = false;
    program
        .admin()
        .update_config(config)
        .with_actor_id(DEPLOYER.into())
        .await
        .unwrap();
    program
        .review()
        .submit_project_review(SubmitProjectReviewReq {
            github_url: "https://github.com/alice/idea-agent".to_string(),
            idea: "agent that helps builders find valuable integrations".to_string(),
        })
        .with_actor_id(ALICE.into())
        .await
        .unwrap_err();
}

#[tokio::test]
async fn project_review_rate_limits_repeated_builder_actions() {
    let system = init_system();
    let env = GtestEnv::new(system, DEPLOYER.into());
    let program = deploy(&env).await;
    let mut config = program.admin().get_config().await.unwrap();
    config.require_project_review_approval = false;
    program
        .admin()
        .update_config(config)
        .with_actor_id(DEPLOYER.into())
        .await
        .unwrap();

    program
        .review()
        .submit_project_review(SubmitProjectReviewReq {
            github_url: "https://github.com/alice/idea-agent".to_string(),
            idea: "agent that helps builders find valuable integrations".to_string(),
        })
        .with_actor_id(ALICE.into())
        .await
        .unwrap();
    program
        .review()
        .submit_project_review(SubmitProjectReviewReq {
            github_url: "https://github.com/alice/another-idea-agent".to_string(),
            idea: "another valuable integration idea".to_string(),
        })
        .with_actor_id(ALICE.into())
        .await
        .unwrap_err();
}

#[tokio::test]
async fn project_review_rejects_invalid_inputs_and_bad_links() {
    let system = init_system();
    let env = GtestEnv::new(system, DEPLOYER.into());
    let program = deploy(&env).await;
    disable_review_rate_limit(&program).await;

    program
        .review()
        .add_reviewer(ALICE.into())
        .with_actor_id(DEPLOYER.into())
        .await
        .unwrap();
    program
        .review()
        .add_reviewer(CAROL.into())
        .with_actor_id(DEPLOYER.into())
        .await
        .unwrap();

    program
        .review()
        .submit_project_review(SubmitProjectReviewReq {
            github_url: "https://gitlab.com/alice/idea-agent".to_string(),
            idea: "agent idea".to_string(),
        })
        .with_actor_id(ALICE.into())
        .await
        .unwrap_err();
    program
        .review()
        .submit_project_review(SubmitProjectReviewReq {
            github_url: "https://github.com/alice/idea-agent".to_string(),
            idea: String::new(),
        })
        .with_actor_id(ALICE.into())
        .await
        .unwrap_err();

    let project_review_id = program
        .review()
        .submit_project_review(SubmitProjectReviewReq {
            github_url: "https://github.com/alice/idea-agent".to_string(),
            idea: "agent that helps builders find valuable integrations".to_string(),
        })
        .with_actor_id(ALICE.into())
        .await
        .unwrap();

    program
        .review()
        .post_project_reviewer_comment(project_review_id, "self review".to_string())
        .with_actor_id(ALICE.into())
        .await
        .unwrap_err();
    program
        .review()
        .record_project_guidance(
            999,
            ProjectGuidanceOutcome::Proceed,
            "unknown idea".to_string(),
        )
        .with_actor_id(CAROL.into())
        .await
        .unwrap_err();

    register_application_for_test(
        &program,
        mk_register_req("idea-agent", ALICE, STUB_PROGRAM_ALPHA),
        STUB_PROGRAM_ALPHA,
    )
    .await;
    program
        .review()
        .link_project_review_to_application(project_review_id, STUB_PROGRAM_ALPHA.into())
        .with_actor_id(ALICE.into())
        .await
        .unwrap_err();
    program
        .review()
        .record_project_guidance(
            project_review_id,
            ProjectGuidanceOutcome::Proceed,
            "ready to build".to_string(),
        )
        .with_actor_id(CAROL.into())
        .await
        .unwrap();
    program
        .review()
        .link_project_review_to_application(project_review_id, STUB_PROGRAM_ALPHA.into())
        .with_actor_id(ALICE.into())
        .await
        .unwrap_err();
    program
        .review()
        .link_project_review_to_application(project_review_id, STUB_PROGRAM_ALPHA.into())
        .with_actor_id(ALICE.into())
        .await
        .unwrap_err();

    let second_project_review_id = program
        .review()
        .submit_project_review(SubmitProjectReviewReq {
            github_url: "https://github.com/alice/idea-agent-v2".to_string(),
            idea: "new deployment still needs the same guidance".to_string(),
        })
        .with_actor_id(ALICE.into())
        .await
        .unwrap();
    replace_application_program_for_test(
        &program,
        STUB_PROGRAM_ALPHA,
        mk_register_req("idea-agent", ALICE, STUB_PROGRAM_BETA),
        ALICE,
        "replacement before linking second idea",
    )
    .await;
    program
        .review()
        .link_project_review_to_application(second_project_review_id, STUB_PROGRAM_ALPHA.into())
        .with_actor_id(ALICE.into())
        .await
        .unwrap_err();
}

#[tokio::test]
async fn project_review_pagination_cursor_resumes_after_last_returned_idea() {
    let system = init_system();
    let env = GtestEnv::new(system, DEPLOYER.into());
    let program = deploy(&env).await;
    disable_review_rate_limit(&program).await;

    for idx in 1..=3 {
        program
            .review()
            .submit_project_review(SubmitProjectReviewReq {
                github_url: format!("https://github.com/alice/idea-agent-{idx}"),
                idea: format!("valuable integration idea {idx}"),
            })
            .with_actor_id(ALICE.into())
            .await
            .unwrap();
    }

    let first_page = program
        .review()
        .list_project_review_summaries(None, 2)
        .await
        .unwrap();
    assert_eq!(
        first_page
            .items
            .iter()
            .map(|idea| idea.project_review_id)
            .collect::<Vec<_>>(),
        vec![1, 2]
    );
    assert_eq!(first_page.next_cursor, Some(2));

    let second_page = program
        .review()
        .list_project_review_summaries(first_page.next_cursor, 2)
        .await
        .unwrap();
    assert_eq!(
        second_page
            .items
            .iter()
            .map(|idea| idea.project_review_id)
            .collect::<Vec<_>>(),
        vec![3]
    );
    assert_eq!(second_page.next_cursor, None);
}
