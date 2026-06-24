//! Coach-gated application permit tests.

mod common;

use agents_network_client::{
    AgentsNetworkClient, ApplicationPermitDetails, ApplicationPermitPurpose, ContactLinks,
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
    let owner = if details.operator == BOB.into() {
        BOB
    } else if details.operator == CAROL.into() {
        CAROL
    } else {
        ALICE
    };
    let project_review_id = submit_approved_project_review_for_test(
        program,
        owner,
        details.github_url.clone(),
        "coach-reviewed app".to_string(),
    )
    .await;
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
    approve_permit(
        program,
        project_review_id,
        ApplicationPermitPurpose::Register,
        details,
    )
    .await
}

async fn approve_permit(
    program: &Actor<agents_network_client::AgentsNetworkClientProgram, GtestEnv>,
    project_review_id: u64,
    purpose: ApplicationPermitPurpose,
    details: ApplicationPermitDetails,
) -> u64 {
    program
        .review()
        .approve_application_permit(project_review_id, purpose, details, 77)
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

#[tokio::test]
async fn contacts_update_can_clear_contacts() {
    let system = init_system();
    let env = GtestEnv::new(system, DEPLOYER.into());
    let program = deploy(&env).await;
    let mut details = permit_details("contact-app", ALICE, STUB_PROGRAM_ALPHA);
    details.contacts = Some(ContactLinks {
        discord: Some("alice#0001".to_string()),
        telegram: None,
        x: None,
    });
    let project_review_id = ready_project_review(&program, &details).await;
    let approval_id = approve_register_permit(&program, project_review_id, details.clone()).await;
    program
        .registry()
        .register_application(RegisterApplicationWithApprovalReq {
            approval_id,
            details,
        })
        .with_actor_id(ALICE.into())
        .await
        .unwrap();

    program
        .registry()
        .update_application_contacts(STUB_PROGRAM_ALPHA.into(), None)
        .with_actor_id(ALICE.into())
        .await
        .unwrap();

    let app = program
        .registry()
        .get_application(STUB_PROGRAM_ALPHA.into())
        .await
        .unwrap()
        .expect("registered app");
    assert!(app.contacts.is_none());
}

#[tokio::test]
async fn protected_metadata_update_requires_matching_permit() {
    let system = init_system();
    let env = GtestEnv::new(system, DEPLOYER.into());
    let program = deploy(&env).await;
    let details = permit_details("metadata-app", ALICE, STUB_PROGRAM_ALPHA);
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

    let mut approved = details;
    approved.description = "approved metadata".to_string();
    approved.skills_hash = [3u8; 32];
    let metadata_approval = approve_permit(
        &program,
        project_review_id,
        ApplicationPermitPurpose::UpdateMetadata,
        approved.clone(),
    )
    .await;
    program
        .registry()
        .update_application_with_approval(
            STUB_PROGRAM_ALPHA.into(),
            metadata_approval,
            approved.clone(),
        )
        .with_actor_id(ALICE.into())
        .await
        .unwrap();

    let app = program
        .registry()
        .get_application(STUB_PROGRAM_ALPHA.into())
        .await
        .unwrap()
        .expect("registered app");
    assert_eq!(app.description, "approved metadata");
    assert_eq!(app.skills_hash, [3u8; 32]);
}

#[tokio::test]
async fn replace_program_requires_matching_permit_and_moves_state() {
    let system = init_system();
    let env = GtestEnv::new(system, DEPLOYER.into());
    let program = deploy(&env).await;
    let details = permit_details("replace-app", ALICE, STUB_PROGRAM_ALPHA);
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

    let mut replacement = details;
    replacement.program_id = STUB_PROGRAM_BETA.into();
    replacement.idl_hash = [4u8; 32];
    let replacement_approval = approve_permit(
        &program,
        project_review_id,
        ApplicationPermitPurpose::ReplaceProgram,
        replacement.clone(),
    )
    .await;
    let mut wrong = replacement.clone();
    wrong.idl_hash = [5u8; 32];
    program
        .registry()
        .apply_approved_application_transition(
            STUB_PROGRAM_ALPHA.into(),
            replacement_approval,
            wrong,
            "redeployed".to_string(),
        )
        .with_actor_id(ALICE.into())
        .await
        .unwrap_err();

    program
        .registry()
        .apply_approved_application_transition(
            STUB_PROGRAM_ALPHA.into(),
            replacement_approval,
            replacement,
            "redeployed".to_string(),
        )
        .with_actor_id(ALICE.into())
        .await
        .unwrap();

    assert!(
        program
            .registry()
            .get_application(STUB_PROGRAM_ALPHA.into())
            .await
            .unwrap()
            .is_none()
    );
    let app = program
        .registry()
        .get_application(STUB_PROGRAM_BETA.into())
        .await
        .unwrap()
        .expect("replacement app");
    assert_eq!(app.idl_hash, [4u8; 32]);
    assert_eq!(
        program
            .registry()
            .resolve_current_program_id(STUB_PROGRAM_ALPHA.into())
            .await
            .unwrap(),
        STUB_PROGRAM_BETA.into()
    );
}

#[tokio::test]
async fn admin_prune_releases_program_reservation() {
    let system = init_system();
    let env = GtestEnv::new(system, DEPLOYER.into());
    let program = deploy(&env).await;
    let details = permit_details("prune-app", ALICE, STUB_PROGRAM_ALPHA);
    let project_review_id = ready_project_review(&program, &details).await;
    let approval_id = approve_register_permit(&program, project_review_id, details.clone()).await;
    program
        .registry()
        .register_application(RegisterApplicationWithApprovalReq {
            approval_id,
            details,
        })
        .with_actor_id(ALICE.into())
        .await
        .unwrap();
    program
        .registry()
        .admin_prune_application(STUB_PROGRAM_ALPHA.into(), "junk".to_string())
        .with_actor_id(DEPLOYER.into())
        .await
        .unwrap();

    let details = permit_details("force-app", ALICE, STUB_PROGRAM_ALPHA);
    let project_review_id = submit_approved_project_review_for_test(
        &program,
        ALICE,
        details.github_url.clone(),
        "reused after prune".to_string(),
    )
    .await;
    program
        .review()
        .record_project_guidance(
            project_review_id,
            ProjectGuidanceOutcome::Proceed,
            "ready to build".to_string(),
        )
        .with_actor_id(MALLORY.into())
        .await
        .unwrap();
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
}

#[tokio::test]
async fn admin_force_delete_preserves_program_reservation() {
    let system = init_system();
    let env = GtestEnv::new(system, DEPLOYER.into());
    let program = deploy(&env).await;
    let details = permit_details("force-app", ALICE, STUB_PROGRAM_ALPHA);
    let project_review_id = ready_project_review(&program, &details).await;
    let approval_id = approve_register_permit(&program, project_review_id, details.clone()).await;
    program
        .registry()
        .register_application(RegisterApplicationWithApprovalReq {
            approval_id,
            details,
        })
        .with_actor_id(ALICE.into())
        .await
        .unwrap();
    program
        .registry()
        .admin_force_delete_application(STUB_PROGRAM_ALPHA.into(), "audit".to_string())
        .with_actor_id(DEPLOYER.into())
        .await
        .unwrap();

    let blocked = permit_details("reserved-app", ALICE, STUB_PROGRAM_ALPHA);
    let project_review_id = submit_approved_project_review_for_test(
        &program,
        ALICE,
        blocked.github_url.clone(),
        "should remain reserved".to_string(),
    )
    .await;
    program
        .review()
        .record_project_guidance(
            project_review_id,
            ProjectGuidanceOutcome::Proceed,
            "ready to build".to_string(),
        )
        .with_actor_id(MALLORY.into())
        .await
        .unwrap();
    program
        .review()
        .approve_application_permit(
            project_review_id,
            ApplicationPermitPurpose::Register,
            blocked,
            77,
        )
        .with_actor_id(CAROL.into())
        .await
        .unwrap_err();
}
