//! Review service lifecycle tests.

mod common;

use agents_network_client::{
    AgentsNetworkClient, AppStatus, CriterionAssessment, CriterionCoverage, ReviewCriteria,
    ReviewVerdict, admin::Admin, registry::Registry, review::Review,
};
use common::*;
use sails_rs::client::*;

fn criteria() -> ReviewCriteria {
    let met = CriterionAssessment {
        coverage: CriterionCoverage::Met,
        note: Some("clear evidence".to_string()),
    };
    ReviewCriteria {
        technical_readiness: met.clone(),
        network_value: met.clone(),
        evidence_quality: met.clone(),
        safety_maintenance: met,
    }
}

#[tokio::test]
async fn judge_rejection_then_acceptance_loop_tracks_revisions() {
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
        .add_judge(CAROL.into())
        .with_actor_id(DEPLOYER.into())
        .await
        .unwrap();

    program
        .registry()
        .register_application(mk_register_req("reviewed-app", ALICE, STUB_PROGRAM_ALPHA))
        .with_actor_id(STUB_PROGRAM_ALPHA.into())
        .await
        .unwrap();

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
        .request_review(STUB_PROGRAM_ALPHA.into(), "please check the agent".to_string())
        .with_actor_id(ALICE.into())
        .await
        .unwrap();

    program
        .review()
        .post_judge_comment(STUB_PROGRAM_ALPHA.into(), 1, "add usage proof".to_string())
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
        .decide_rejected(
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
    assert_eq!(summary.latest_verdict, Some(ReviewVerdict::Rejected));
    assert_eq!(summary.pending_submission_revision, Some(2));
    assert_eq!(summary.submission_revision, Some(1));
    assert_eq!(summary.display_revision, Some(2));
    assert_eq!(summary.current_revision_comment_count, 0);

    program
        .review()
        .decide_accepted(
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
        .decide_accepted(
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
    assert_eq!(summary.latest_verdict, Some(ReviewVerdict::Accepted));
    assert_eq!(summary.submission_revision, Some(2));
    assert_eq!(summary.display_revision, Some(2));
    assert_eq!(summary.pending_submission_revision, None);
}

#[tokio::test]
async fn review_guards_reject_self_review_and_stale_revision() {
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
        .add_judge(ALICE.into())
        .with_actor_id(DEPLOYER.into())
        .await
        .unwrap();
    program
        .review()
        .add_judge(CAROL.into())
        .with_actor_id(DEPLOYER.into())
        .await
        .unwrap();

    program
        .registry()
        .register_application(mk_register_req("guarded-app", ALICE, STUB_PROGRAM_ALPHA))
        .with_actor_id(STUB_PROGRAM_ALPHA.into())
        .await
        .unwrap();

    program
        .review()
        .post_judge_comment(STUB_PROGRAM_ALPHA.into(), 1, "owner judge".to_string())
        .with_actor_id(ALICE.into())
        .await
        .unwrap_err();

    program
        .review()
        .post_judge_comment(STUB_PROGRAM_ALPHA.into(), 99, "stale".to_string())
        .with_actor_id(CAROL.into())
        .await
        .unwrap_err();
}
