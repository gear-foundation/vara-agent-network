//! Integration + happy-path tests. Domain-specific suites live in
//! gtest_registry.rs / gtest_chat.rs / gtest_board.rs.

mod common;

use common::*;
use hackathon_client::{
    AppStatus, ApplicationPatch, HackathonClient, HandleRef, RegistryError, board::Board,
    chat::Chat, registry::Registry,
};
use sails_rs::client::*;
use sails_rs::gtest::*;
use sails_rs::prelude::*;

#[tokio::test]
async fn happy_path_end_to_end() {
    // register alice as participant
    // register bob as participant
    // bob_app (stub program) self-registers as application
    // alice posts chat mentioning bob_app
    // bob_app.get_mentions returns the header
    let system = init_system();
    let env = GtestEnv::new(system, DEPLOYER.into());
    let program = deploy(&env).await;

    // Alice registers.
    program
        .registry()
        .register_participant("alice".to_string(), "github.com/alice".to_string())
        .with_actor_id(ALICE.into())
        .await
        .unwrap()
        .unwrap();

    // Bob registers.
    program
        .registry()
        .register_participant("bob".to_string(), "github.com/bob".to_string())
        .with_actor_id(BOB.into())
        .await
        .unwrap()
        .unwrap();

    // bob's agent program self-registers (msg::source == program ActorId).
    program
        .registry()
        .register_application(mk_register_req("nft", BOB))
        .with_actor_id(STUB_PROGRAM_ALPHA.into())
        .await
        .unwrap()
        .unwrap();

    // Verify state.
    let app = program
        .registry()
        .get_application(STUB_PROGRAM_ALPHA.into())
        .await
        .unwrap();
    assert!(app.is_some(), "application should be registered");
    let app = app.unwrap();
    assert_eq!(app.handle, "nft");
    assert_eq!(app.owner, BOB.into());

    // Handle resolution works.
    let resolved = program
        .registry()
        .resolve_handle("nft".to_string())
        .await
        .unwrap();
    assert_eq!(
        resolved,
        Some(HandleRef::Application(STUB_PROGRAM_ALPHA.into()))
    );

    // Alice mentions bob_app.
    let msg_id = program
        .chat()
        .post(
            "hey @nft".to_string(),
            HandleRef::Participant(ALICE.into()),
            vec![HandleRef::Application(STUB_PROGRAM_ALPHA.into())],
            None,
        )
        .with_actor_id(ALICE.into())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(msg_id, 1);

    // bob_app reads mentions.
    let mentions = program
        .chat()
        .get_mentions(HandleRef::Application(STUB_PROGRAM_ALPHA.into()), 0, 100)
        .await
        .unwrap();
    assert_eq!(mentions.headers.len(), 1);
    assert_eq!(mentions.headers[0].msg_id, 1);
    assert_eq!(
        mentions.headers[0].author,
        HandleRef::Participant(ALICE.into())
    );
    assert!(!mentions.overflow);
}

#[tokio::test]
async fn protocol_version_returns_2() {
    // v2: event-enrichment release. ApplicationRegistered/Updated +
    // IdentityCardUpdated + AnnouncementPosted/Edited now carry payloads
    // sufficient for deterministic indexer replay without state refetch.
    let system = init_system();
    let env = GtestEnv::new(system, DEPLOYER.into());
    let program = deploy(&env).await;

    let v = program.registry().protocol_version().await.unwrap();
    assert_eq!(v, 2);
}

#[tokio::test]
async fn update_application_by_operator_and_by_program() {
    let system = init_system();
    let env = GtestEnv::new(system, DEPLOYER.into());
    let program = deploy(&env).await;

    // Stub program registers with ALICE as operator.
    program
        .registry()
        .register_application(mk_register_req("foo", ALICE))
        .with_actor_id(STUB_PROGRAM_ALPHA.into())
        .await
        .unwrap()
        .unwrap();

    // Alice (operator) can update.
    let mut patch = empty_patch();
    patch.status = Some(AppStatus::Live);
    program
        .registry()
        .update_application(STUB_PROGRAM_ALPHA.into(), patch.clone())
        .with_actor_id(ALICE.into())
        .await
        .unwrap()
        .unwrap();

    // Program itself (self-call) can update.
    let mut patch2 = empty_patch();
    patch2.description = Some("updated".to_string());
    program
        .registry()
        .update_application(STUB_PROGRAM_ALPHA.into(), patch2)
        .with_actor_id(STUB_PROGRAM_ALPHA.into())
        .await
        .unwrap()
        .unwrap();

    // Mallory (not operator, not program) cannot update.
    let mut patch3 = empty_patch();
    patch3.description = Some("hijack".to_string());
    let err = program
        .registry()
        .update_application(STUB_PROGRAM_ALPHA.into(), patch3)
        .with_actor_id(MALLORY.into())
        .await
        .unwrap()
        .unwrap_err();
    assert_eq!(err, RegistryError::NotOwner);
}
