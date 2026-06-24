//! Coach-gated application permit tests.

mod common;

use agents_network_client::{
    AgentsNetworkClient, ApplicationPermitDetails, ApplicationPermitPurpose,
    ProjectGuidanceOutcome, RegisterApplicationWithApprovalReq, Track, admin::Admin,
    registry::Registry, review::Review,
};
use common::*;
use sails_rs::client::*;
use sails_rs::prelude::*;

fn permit_details(handle: &str, operator: u64, program_id: u64) -> ApplicationPermitDetails {
    ApplicationPermitDetails {
        handle: handle.to_string(),
        program_id: ActorId::from(program_id),
        operator: ActorId::from(operator),
        github_url: format!("https://github.com/alice/{handle}"),
        skills_hash: [1u8; 32],
        skills_url: format!("https://example.com/{handle}/skills.json"),
        idl_hash: [2u8; 32],
        idl_url: format!("https://example.com/{handle}/agent.idl"),
        description: format!("{handle} does a thing"),
        track: Track::Services,
        contacts: None,
    }
}

async fn ready_project_review(
    program: &Actor<agents_network_client::AgentsNetworkClientProgram, GtestEnv>,
    details: &ApplicationPermitDetails,
) -> u64 {
    let mut config = program.admin().get_config().await.unwrap();
    config.review_rate_limit_ms = 0;
    config.require_project_review_approval = false;
    program
        .admin()
        .update_config(config)
        .with_actor_id(DEPLOYER.into())
        .await
        .unwrap();
    program
        .review()
        .add_reviewer(MALLORY.into())
        .with_actor_id(DEPLOYER.into())
        .await
        .unwrap();
    program
        .review()
        .add_coach(CAROL.into())
        .with_actor_id(DEPLOYER.into())
        .await
        .unwrap();
    let project_review_id = program
        .review()
        .submit_project_review(agents_network_client::SubmitProjectReviewReq {
            github_url: details.github_url.clone(),
            idea: "coach-reviewed app".to_string(),
        })
        .with_actor_id(ALICE.into())
        .await
        .unwrap();
    program
        .review()
        .record_project_guidance(
            project_review_id,
            ProjectGuidanceOutcome::Proceed,
            "build it".to_string(),
        )
        .with_actor_id(MALLORY.into())
        .await
        .unwrap();
    project_review_id
}

async fn approve_register_permit(
    program: &Actor<agents_network_client::AgentsNetworkClientProgram, GtestEnv>,
    project_review_id: u64,
    details: ApplicationPermitDetails,
) -> u64 {
    program
        .review()
        .approve_application_permit(
            project_review_id,
            ApplicationPermitPurpose::Register,
            details,
            77,
        )
        .with_actor_id(CAROL.into())
        .await
        .unwrap()
}

#[tokio::test]
async fn register_rejects_unknown_permit_without_state() {
    let system = init_system();
    let env = GtestEnv::new(system, DEPLOYER.into());
    let program = deploy(&env).await;
    let details = permit_details("gated-app", ALICE, STUB_PROGRAM_ALPHA);

    program
        .registry()
        .register_application(RegisterApplicationWithApprovalReq {
            approval_id: 404,
            details: details.clone(),
        })
        .with_actor_id(ALICE.into())
        .await
        .unwrap_err();

    assert!(
        program
            .registry()
            .get_application(STUB_PROGRAM_ALPHA.into())
            .await
            .unwrap()
            .is_none()
    );
    assert_eq!(
        program
            .registry()
            .resolve_handle("gated-app".to_string())
            .await
            .unwrap(),
        None
    );
}

#[tokio::test]
async fn valid_register_permit_registers_and_links_once() {
    let system = init_system();
    let env = GtestEnv::new(system, DEPLOYER.into());
    let program = deploy(&env).await;
    let details = permit_details("approved-app", ALICE, STUB_PROGRAM_ALPHA);
    let project_review_id = ready_project_review(&program, &details).await;
    let approval_id = approve_register_permit(&program, project_review_id, details.clone()).await;

    program
        .registry()
        .register_application(RegisterApplicationWithApprovalReq {
            approval_id,
            details: details.clone(),
        })
        .with_actor_id(ALICE.into())
        .await
        .unwrap();

    let app = program
        .registry()
        .get_application(STUB_PROGRAM_ALPHA.into())
        .await
        .unwrap()
        .expect("registered app");
    assert_eq!(app.handle, "approved-app");
    let linked = program
        .review()
        .get_project_review_summary(project_review_id)
        .await
        .unwrap()
        .expect("project review");
    assert_eq!(linked.linked_program_id, Some(STUB_PROGRAM_ALPHA.into()));

    program
        .registry()
        .register_application(RegisterApplicationWithApprovalReq {
            approval_id,
            details,
        })
        .with_actor_id(ALICE.into())
        .await
        .unwrap_err();
}

#[tokio::test]
async fn permit_details_mismatch_leaves_no_registration_state() {
    let system = init_system();
    let env = GtestEnv::new(system, DEPLOYER.into());
    let program = deploy(&env).await;
    let details = permit_details("match-app", ALICE, STUB_PROGRAM_ALPHA);
    let project_review_id = ready_project_review(&program, &details).await;
    let approval_id = approve_register_permit(&program, project_review_id, details.clone()).await;
    let mut wrong = details;
    wrong.handle = "wrong-app".to_string();

    program
        .registry()
        .register_application(RegisterApplicationWithApprovalReq {
            approval_id,
            details: wrong,
        })
        .with_actor_id(ALICE.into())
        .await
        .unwrap_err();

    assert!(
        program
            .registry()
            .get_application(STUB_PROGRAM_ALPHA.into())
            .await
            .unwrap()
            .is_none()
    );
}
