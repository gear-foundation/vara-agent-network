//! Shared test helpers. Each tests/*.rs is an independent binary, but this
//! module is pulled into each with `mod common;`.

#![allow(dead_code)]

use agents_network_client::{
    AgentsNetworkClient, AgentsNetworkClientCtors, ApplicationPermitDetails,
    ApplicationPermitPurpose, CriterionAssessment, CriterionCoverage, ProjectGuidanceOutcome,
    RegisterApplicationWithApprovalReq, ReviewCriteria, SubmitProjectReviewReq, admin::Admin,
    registry::Registry, review::Review,
};
use sails_rs::client::*;
use sails_rs::gtest::*;
use sails_rs::prelude::*;

pub const DEPLOYER: u64 = 100;
pub const ALICE: u64 = 101;
pub const BOB: u64 = 102;
pub const CAROL: u64 = 103;
pub const MALLORY: u64 = 104;

/// IDs we pretend are deployed programs. In gtest these are just ActorIds
/// that we reuse as msg::source() by calling `env.with_actor_id(...)`.
/// Real chains enforce "programs have code; wallets don't" — gtest does not,
/// so a test's "program" can masquerade as a wallet and vice versa; tests
/// choose which role to treat a given ActorId as.
pub const STUB_PROGRAM_ALPHA: u64 = 200;
pub const STUB_PROGRAM_BETA: u64 = 201;
pub const STUB_PROGRAM_GAMMA: u64 = 202;

pub const FUND: ValueUnit = 10_000_000_000_000_000;

pub fn init_system() -> System {
    let system = System::new();
    system.init_logger_with_default_filter("gwasm=error,gtest=error,sails_rs=error");
    system.mint_to(DEPLOYER, FUND);
    system.mint_to(ALICE, FUND);
    system.mint_to(BOB, FUND);
    system.mint_to(CAROL, FUND);
    system.mint_to(MALLORY, FUND);
    system.mint_to(STUB_PROGRAM_ALPHA, FUND);
    system.mint_to(STUB_PROGRAM_BETA, FUND);
    system.mint_to(STUB_PROGRAM_GAMMA, FUND);
    // Bulk-mint ranges used by stress/ring tests: wallet IDs 300..600 and
    // poster IDs 3000..3200. Cheap; keeps every test self-contained.
    for i in 300..600u64 {
        system.mint_to(i, FUND);
    }
    for i in 3000..3200u64 {
        system.mint_to(i, FUND);
    }
    system
}

/// Deploy the Vara Agent Network program, return an `Actor` handle bound to
/// `DEPLOYER`. Tests flip the caller per call with `.with_actor_id(...)`.
pub async fn deploy(
    env: &GtestEnv,
) -> sails_rs::client::Actor<agents_network_client::AgentsNetworkClientProgram, GtestEnv> {
    let code_id = env.system().submit_code(agents_network::WASM_BINARY);
    env.clone()
        .deploy::<agents_network_client::AgentsNetworkClientProgram>(code_id, b"salt".to_vec())
        .new(DEPLOYER.into(), 1) // admin = deployer, initial_season = 1
        .await
        .unwrap()
}

/// Convenience helper: build application permit details with harmless defaults.
pub fn mk_register_req(handle: &str, operator: u64, program_id: u64) -> ApplicationPermitDetails {
    use agents_network_client::{ApplicationPermitDetails, Track};
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

pub fn mk_identity_card_req() -> agents_network_client::IdentityCardReq {
    use agents_network_client::IdentityCardReq;
    IdentityCardReq {
        who_i_am: "I am a bot".to_string(),
        what_i_do: "I do things".to_string(),
        how_to_interact: "Call me".to_string(),
        what_i_offer: "Things".to_string(),
        tags: vec!["tag1".to_string(), "tag2".to_string()],
    }
}

pub fn mk_announcement_req(title: &str) -> agents_network_client::AnnouncementReq {
    use agents_network_client::AnnouncementReq;
    AnnouncementReq {
        title: title.to_string(),
        body: format!("body of {title}"),
        tags: Vec::new(),
    }
}

pub fn empty_patch() -> agents_network_client::ApplicationPatch {
    use agents_network_client::ApplicationPatch;
    ApplicationPatch {
        handle: None,
        description: None,
        track: None,
        github_url: None,
        skills_hash: None,
        skills_url: None,
        idl_hash: None,
        idl_url: None,
        contacts: None,
    }
}

pub fn criteria() -> ReviewCriteria {
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

pub async fn disable_review_rate_limit(
    program: &sails_rs::client::Actor<agents_network_client::AgentsNetworkClientProgram, GtestEnv>,
) {
    let mut config = program.admin().get_config().await.unwrap();
    config.review_rate_limit_ms = 0;
    program
        .admin()
        .update_config(config)
        .with_actor_id(DEPLOYER.into())
        .await
        .unwrap();
}

pub async fn ensure_test_review_roles(
    program: &sails_rs::client::Actor<agents_network_client::AgentsNetworkClientProgram, GtestEnv>,
) {
    disable_review_rate_limit(program).await;
    let _ = program
        .review()
        .add_reviewer(MALLORY.into())
        .with_actor_id(DEPLOYER.into())
        .await;
    let _ = program
        .review()
        .add_coach(CAROL.into())
        .with_actor_id(DEPLOYER.into())
        .await;
    let _ = program
        .review()
        .add_coach(MALLORY.into())
        .with_actor_id(DEPLOYER.into())
        .await;
}

fn test_actor_u64(actor: ActorId) -> u64 {
    if actor == ALICE.into() {
        ALICE
    } else if actor == BOB.into() {
        BOB
    } else if actor == CAROL.into() {
        CAROL
    } else if actor == MALLORY.into() {
        MALLORY
    } else {
        std::panic!("unknown test actor: {actor:?}");
    }
}

pub async fn submit_project_review_for_test(
    program: &sails_rs::client::Actor<agents_network_client::AgentsNetworkClientProgram, GtestEnv>,
    owner: u64,
    github_url: String,
    idea: String,
) -> u64 {
    ensure_test_review_roles(program).await;
    program
        .review()
        .submit_project_review(SubmitProjectReviewReq { github_url, idea })
        .with_actor_id(owner.into())
        .await
        .unwrap()
}

pub async fn linked_project_review_id(
    program: &sails_rs::client::Actor<agents_network_client::AgentsNetworkClientProgram, GtestEnv>,
    program_id: u64,
) -> Option<u64> {
    program
        .review()
        .list_project_review_summaries(None, 100)
        .await
        .unwrap()
        .items
        .into_iter()
        .find(|summary| summary.linked_program_id == Some(program_id.into()))
        .map(|summary| summary.project_review_id)
}

pub async fn approved_register_req_for_test(
    program: &sails_rs::client::Actor<agents_network_client::AgentsNetworkClientProgram, GtestEnv>,
    details: ApplicationPermitDetails,
) -> (RegisterApplicationWithApprovalReq, u64) {
    let project_review_id = submit_project_review_for_test(
        program,
        test_actor_u64(details.operator),
        details.github_url.clone(),
        format!("{} provides useful network value", details.handle),
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
    let approval_id = approve_application_permit_for_test(
        program,
        project_review_id,
        ApplicationPermitPurpose::Register,
        details.clone(),
    )
    .await;
    (
        RegisterApplicationWithApprovalReq {
            approval_id,
            details,
        },
        project_review_id,
    )
}

pub async fn expect_register_permit_rejected_for_test(
    program: &sails_rs::client::Actor<agents_network_client::AgentsNetworkClientProgram, GtestEnv>,
    details: ApplicationPermitDetails,
) {
    let github_url = if details.github_url.starts_with("https://github.com/") {
        details.github_url.clone()
    } else {
        format!("https://github.com/alice/{}", details.handle)
    };
    let project_review_id = submit_project_review_for_test(
        program,
        test_actor_u64(details.operator),
        github_url,
        format!("{} provides useful network value", details.handle),
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
            details,
            77,
        )
        .with_actor_id(CAROL.into())
        .await
        .unwrap_err();
}

pub async fn approve_application_permit_for_test(
    program: &sails_rs::client::Actor<agents_network_client::AgentsNetworkClientProgram, GtestEnv>,
    project_review_id: u64,
    purpose: ApplicationPermitPurpose,
    details: ApplicationPermitDetails,
) -> u64 {
    ensure_test_review_roles(program).await;
    let coach = if details.operator == CAROL.into() {
        MALLORY
    } else {
        CAROL
    };
    program
        .review()
        .approve_application_permit(project_review_id, purpose, details, 77)
        .with_actor_id(coach.into())
        .await
        .unwrap()
}

pub async fn register_application_for_test(
    program: &sails_rs::client::Actor<agents_network_client::AgentsNetworkClientProgram, GtestEnv>,
    details: ApplicationPermitDetails,
    caller: u64,
) -> u64 {
    let (req, project_review_id) = approved_register_req_for_test(program, details).await;
    program
        .registry()
        .register_application(req)
        .with_actor_id(caller.into())
        .await
        .unwrap();
    project_review_id
}

pub async fn update_application_with_approval_for_test(
    program: &sails_rs::client::Actor<agents_network_client::AgentsNetworkClientProgram, GtestEnv>,
    program_id: u64,
    details: ApplicationPermitDetails,
    caller: u64,
) {
    let project_review_id = linked_project_review_id(program, program_id)
        .await
        .expect("application should have linked project review");
    let approval_id = approve_application_permit_for_test(
        program,
        project_review_id,
        ApplicationPermitPurpose::UpdateMetadata,
        details.clone(),
    )
    .await;
    program
        .registry()
        .update_application_with_approval(program_id.into(), approval_id, details)
        .with_actor_id(caller.into())
        .await
        .unwrap();
}

pub async fn replace_application_program_for_test(
    program: &sails_rs::client::Actor<agents_network_client::AgentsNetworkClientProgram, GtestEnv>,
    current_program_id: u64,
    details: ApplicationPermitDetails,
    caller: u64,
    reason: &str,
) {
    let project_review_id = linked_project_review_id(program, current_program_id)
        .await
        .expect("application should have linked project review");
    let approval_id = approve_application_permit_for_test(
        program,
        project_review_id,
        ApplicationPermitPurpose::ReplaceProgram,
        details.clone(),
    )
    .await;
    program
        .registry()
        .apply_approved_application_transition(
            current_program_id.into(),
            approval_id,
            details,
            reason.to_string(),
        )
        .with_actor_id(caller.into())
        .await
        .unwrap();
}

pub async fn expect_replace_application_program_rejected_for_test(
    program: &sails_rs::client::Actor<agents_network_client::AgentsNetworkClientProgram, GtestEnv>,
    current_program_id: u64,
    details: ApplicationPermitDetails,
    caller: u64,
    reason: &str,
) {
    let project_review_id = linked_project_review_id(program, current_program_id)
        .await
        .expect("application should have linked project review");
    ensure_test_review_roles(program).await;
    let coach = if details.operator == CAROL.into() {
        MALLORY
    } else {
        CAROL
    };
    let approval = program
        .review()
        .approve_application_permit(
            project_review_id,
            ApplicationPermitPurpose::ReplaceProgram,
            details.clone(),
            77,
        )
        .with_actor_id(coach.into())
        .await;
    let Ok(approval_id) = approval else {
        return;
    };
    program
        .registry()
        .apply_approved_application_transition(
            current_program_id.into(),
            approval_id,
            details,
            reason.to_string(),
        )
        .with_actor_id(caller.into())
        .await
        .unwrap_err();
}

pub async fn link_ready_project_review(
    program: &sails_rs::client::Actor<agents_network_client::AgentsNetworkClientProgram, GtestEnv>,
    owner: u64,
    handle: &str,
    program_id: u64,
) {
    if linked_project_review_id(program, program_id)
        .await
        .is_some()
    {
        return;
    }
    let _ = (program, owner, handle);
    std::panic!(
        "application {program_id} has no linked project review; register through the permit flow so registration auto-links it"
    );
}
