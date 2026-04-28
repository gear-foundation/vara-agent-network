//! Integration + happy-path tests. Domain-specific suites live in
//! gtest_registry.rs / gtest_chat.rs / gtest_board.rs.

mod common;

use agents_network_client::{
    AgentsNetworkClient, AppStatus, ContactLinks, HandleRef, admin::Admin, chat::Chat,
    registry::Registry,
};
use common::*;
use sails_rs::client::*;
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
        .register_participant("alice".to_string(), "https://github.com/alice".to_string())
        .with_actor_id(ALICE.into())
        .await
        .unwrap();

    // Bob registers.
    program
        .registry()
        .register_participant("bob".to_string(), "https://github.com/bob".to_string())
        .with_actor_id(BOB.into())
        .await
        .unwrap();

    // bob's agent program self-registers (msg::source == program ActorId).
    program
        .registry()
        .register_application(mk_register_req("nft", BOB, STUB_PROGRAM_ALPHA))
        .with_actor_id(STUB_PROGRAM_ALPHA.into())
        .await
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
async fn update_application_by_operator_and_by_program() {
    let system = init_system();
    let env = GtestEnv::new(system, DEPLOYER.into());
    let program = deploy(&env).await;

    // Stub program registers with ALICE as operator.
    program
        .registry()
        .register_application(mk_register_req("foo", ALICE, STUB_PROGRAM_ALPHA))
        .with_actor_id(STUB_PROGRAM_ALPHA.into())
        .await
        .unwrap();

    // Alice (operator) can update editable metadata, but not lifecycle status.
    let mut patch = empty_patch();
    patch.description = Some("operator updated".to_string());
    program
        .registry()
        .update_application(STUB_PROGRAM_ALPHA.into(), patch.clone())
        .with_actor_id(ALICE.into())
        .await
        .unwrap();

    // Program itself (self-call) can update.
    let mut patch2 = empty_patch();
    patch2.description = Some("updated".to_string());
    program
        .registry()
        .update_application(STUB_PROGRAM_ALPHA.into(), patch2)
        .with_actor_id(STUB_PROGRAM_ALPHA.into())
        .await
        .unwrap();

    // IDL URL patches keep the same validation as registration.
    let mut bad_idl_patch = empty_patch();
    bad_idl_patch.idl_url = Some("https://example.com/agent.json".to_string());
    program
        .registry()
        .update_application(STUB_PROGRAM_ALPHA.into(), bad_idl_patch)
        .with_actor_id(ALICE.into())
        .await
        .unwrap_err();

    let mut good_idl_patch = empty_patch();
    good_idl_patch.idl_url = Some("https://example.com/agent-updated.idl".to_string());
    program
        .registry()
        .update_application(STUB_PROGRAM_ALPHA.into(), good_idl_patch)
        .with_actor_id(ALICE.into())
        .await
        .unwrap();

    // Mallory (not operator, not program) cannot update.
    let mut patch3 = empty_patch();
    patch3.description = Some("hijack".to_string());
    program
        .registry()
        .update_application(STUB_PROGRAM_ALPHA.into(), patch3)
        .with_actor_id(MALLORY.into())
        .await
        .unwrap_err();
}

#[tokio::test]
async fn application_lifecycle_owner_submits_admin_sets_trusted_status() {
    let system = init_system();
    let env = GtestEnv::new(system, DEPLOYER.into());
    let program = deploy(&env).await;

    program
        .registry()
        .register_application(mk_register_req("lifecycle", ALICE, STUB_PROGRAM_ALPHA))
        .with_actor_id(STUB_PROGRAM_ALPHA.into())
        .await
        .unwrap();

    let app = program
        .registry()
        .get_application(STUB_PROGRAM_ALPHA.into())
        .await
        .unwrap()
        .expect("application should exist");
    assert_eq!(app.status, AppStatus::Building);

    program
        .registry()
        .submit_application(STUB_PROGRAM_ALPHA.into())
        .with_actor_id(ALICE.into())
        .await
        .unwrap();

    let app = program
        .registry()
        .get_application(STUB_PROGRAM_ALPHA.into())
        .await
        .unwrap()
        .expect("application should exist");
    assert_eq!(app.status, AppStatus::Submitted);

    program
        .admin()
        .set_application_status(STUB_PROGRAM_ALPHA.into(), AppStatus::Live)
        .with_actor_id(MALLORY.into())
        .await
        .unwrap_err();

    program
        .admin()
        .set_application_status(STUB_PROGRAM_ALPHA.into(), AppStatus::Live)
        .with_actor_id(DEPLOYER.into())
        .await
        .unwrap();

    let app = program
        .registry()
        .get_application(STUB_PROGRAM_ALPHA.into())
        .await
        .unwrap()
        .expect("application should exist");
    assert_eq!(app.status, AppStatus::Live);

    program
        .registry()
        .submit_application(STUB_PROGRAM_ALPHA.into())
        .with_actor_id(ALICE.into())
        .await
        .unwrap_err();
}

#[tokio::test]
async fn update_application_contacts_can_change_and_clear() {
    let system = init_system();
    let env = GtestEnv::new(system, DEPLOYER.into());
    let program = deploy(&env).await;

    program
        .registry()
        .register_application(mk_register_req("contacts", ALICE, STUB_PROGRAM_ALPHA))
        .with_actor_id(STUB_PROGRAM_ALPHA.into())
        .await
        .unwrap();

    let mut patch = empty_patch();
    patch.contacts = Some(Some(ContactLinks {
        discord: Some("agent-lab".to_string()),
        telegram: Some("@agent_lab".to_string()),
        x: Some("@agent_lab_x".to_string()),
    }));
    program
        .registry()
        .update_application(STUB_PROGRAM_ALPHA.into(), patch)
        .with_actor_id(ALICE.into())
        .await
        .unwrap();

    let app = program
        .registry()
        .get_application(STUB_PROGRAM_ALPHA.into())
        .await
        .unwrap()
        .expect("application should exist");
    assert_eq!(
        app.contacts
            .as_ref()
            .and_then(|contacts| contacts.telegram.as_deref()),
        Some("@agent_lab")
    );

    let mut clear_patch = empty_patch();
    clear_patch.contacts = Some(None);
    program
        .registry()
        .update_application(STUB_PROGRAM_ALPHA.into(), clear_patch)
        .with_actor_id(ALICE.into())
        .await
        .unwrap();

    let app = program
        .registry()
        .get_application(STUB_PROGRAM_ALPHA.into())
        .await
        .unwrap()
        .expect("application should exist");
    assert!(app.contacts.is_none());
}
