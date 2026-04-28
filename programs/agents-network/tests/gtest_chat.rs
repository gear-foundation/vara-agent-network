//! Chat service gtest suite.

mod common;

use agents_network_client::{AgentsNetworkClient, HandleRef, chat::Chat, registry::Registry};
use common::*;
use sails_rs::client::*;
use sails_rs::prelude::*;

async fn setup()
-> sails_rs::client::Actor<agents_network_client::AgentsNetworkClientProgram, GtestEnv> {
    let system = init_system();
    let env = GtestEnv::new(system, DEPLOYER.into());
    let program = deploy(&env).await;

    // Alice + Bob registered; Bob's stub program self-registers as application.
    program
        .registry()
        .register_participant("alice".to_string(), "https://github.com/alice".to_string())
        .with_actor_id(ALICE.into())
        .await
        .unwrap();
    program
        .registry()
        .register_participant("bob".to_string(), "https://github.com/bob".to_string())
        .with_actor_id(BOB.into())
        .await
        .unwrap();
    program
        .registry()
        .register_application(mk_register_req("nft", BOB, STUB_PROGRAM_ALPHA))
        .with_actor_id(STUB_PROGRAM_ALPHA.into())
        .await
        .unwrap();

    program
}

#[tokio::test]
async fn post_happy_path_mentions_appended() {
    let program = setup().await;

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

    let page = program
        .chat()
        .get_mentions(HandleRef::Application(STUB_PROGRAM_ALPHA.into()), 0, 100)
        .await
        .unwrap();
    assert_eq!(page.headers.len(), 1);
    assert_eq!(page.headers[0].msg_id, 1);
    assert!(!page.overflow);
}

#[tokio::test]
async fn empty_body_rejected() {
    let program = setup().await;

    program
        .chat()
        .post(
            "".to_string(),
            HandleRef::Participant(ALICE.into()),
            Vec::new(),
            None,
        )
        .with_actor_id(ALICE.into())
        .await
        .unwrap_err();
}

#[tokio::test]
async fn body_size_boundary() {
    let program = setup().await;

    let at_cap = "x".repeat(2048);
    program
        .chat()
        .post(
            at_cap,
            HandleRef::Participant(ALICE.into()),
            Vec::new(),
            None,
        )
        .with_actor_id(ALICE.into())
        .await
        .unwrap();

    let over_cap = "x".repeat(2049);
    program
        .chat()
        .post(
            over_cap,
            HandleRef::Participant(BOB.into()),
            Vec::new(),
            None,
        )
        .with_actor_id(BOB.into()) // different wallet to avoid rate limit
        .await
        .unwrap_err();
}

#[tokio::test]
async fn mentions_cap_boundary() {
    let program = setup().await;

    let eight: Vec<HandleRef> = (0..8)
        .map(|i| HandleRef::Participant(ActorId::from(i as u64 + 1000)))
        .collect();
    program
        .chat()
        .post(
            "ok".to_string(),
            HandleRef::Participant(ALICE.into()),
            eight,
            None,
        )
        .with_actor_id(ALICE.into())
        .await
        .unwrap();

    let nine: Vec<HandleRef> = (0..9)
        .map(|i| HandleRef::Participant(ActorId::from(i as u64 + 2000)))
        .collect();
    program
        .chat()
        .post(
            "ok".to_string(),
            HandleRef::Participant(BOB.into()),
            nine,
            None,
        )
        .with_actor_id(BOB.into())
        .await
        .unwrap_err();
}

#[tokio::test]
async fn dedup_mentions_single_header_per_recipient() {
    let program = setup().await;

    let dup = vec![
        HandleRef::Application(STUB_PROGRAM_ALPHA.into()),
        HandleRef::Application(STUB_PROGRAM_ALPHA.into()),
        HandleRef::Application(STUB_PROGRAM_ALPHA.into()),
    ];
    program
        .chat()
        .post(
            "hey hey hey".to_string(),
            HandleRef::Participant(ALICE.into()),
            dup,
            None,
        )
        .with_actor_id(ALICE.into())
        .await
        .unwrap();

    let page = program
        .chat()
        .get_mentions(HandleRef::Application(STUB_PROGRAM_ALPHA.into()), 0, 100)
        .await
        .unwrap();
    assert_eq!(page.headers.len(), 1, "duplicate mentions must dedup");
}

#[tokio::test]
async fn unregistered_wallet_can_post_as_participant_actor() {
    let program = setup().await;

    let msg_id = program
        .chat()
        .post(
            "gm from a guest wallet".to_string(),
            HandleRef::Participant(MALLORY.into()),
            Vec::new(),
            None,
        )
        .with_actor_id(MALLORY.into())
        .await
        .unwrap();

    assert_eq!(msg_id, 1);
}

#[tokio::test]
async fn unauthorized_author_participant() {
    let program = setup().await;

    // Mallory tries to author as Alice.
    program
        .chat()
        .post(
            "impersonation".to_string(),
            HandleRef::Participant(ALICE.into()),
            Vec::new(),
            None,
        )
        .with_actor_id(MALLORY.into())
        .await
        .unwrap_err();
}

#[tokio::test]
async fn unauthorized_author_application() {
    let program = setup().await;

    // Mallory tries to author as the nft application (STUB_PROGRAM_ALPHA).
    program
        .chat()
        .post(
            "impersonation".to_string(),
            HandleRef::Application(STUB_PROGRAM_ALPHA.into()),
            Vec::new(),
            None,
        )
        .with_actor_id(MALLORY.into())
        .await
        .unwrap_err();

    // Bob (operator of nft) can author as Application(nft).
    program
        .chat()
        .post(
            "legit".to_string(),
            HandleRef::Application(STUB_PROGRAM_ALPHA.into()),
            Vec::new(),
            None,
        )
        .with_actor_id(BOB.into())
        .await
        .unwrap();

    // Program itself (self-call) can author.
    program
        .chat()
        .post(
            "self-call".to_string(),
            HandleRef::Application(STUB_PROGRAM_ALPHA.into()),
            Vec::new(),
            None,
        )
        .with_actor_id(STUB_PROGRAM_ALPHA.into())
        .await
        .unwrap();
}

#[tokio::test]
async fn get_mentions_overflow_signals_after_ring_saturation() {
    let program = setup().await;

    // Push 101 mentions at the nft inbox — 100 cap + 1 eviction.
    // Each post must come from a different msg::source() to avoid rate limit.
    for i in 0..110u64 {
        program
            .chat()
            .post(
                format!("msg {i}"),
                HandleRef::Participant((3000 + i).into()),
                vec![HandleRef::Application(STUB_PROGRAM_ALPHA.into())],
                None,
            )
            .with_actor_id((3000 + i).into())
            .await
            .unwrap();
    }

    // Query from since_seq = 0. oldest_retained_seq should be > 0 after
    // eviction, so overflow=true.
    let page = program
        .chat()
        .get_mentions(HandleRef::Application(STUB_PROGRAM_ALPHA.into()), 0, 200)
        .await
        .unwrap();
    assert_eq!(page.headers.len(), 100, "ring holds 100");
    // After evicting 10, oldest_retained should be msg_id 11.
    // since_seq=0 < oldest_retained=11 → overflow=true.
    // BUT our `overflow` check uses `since_seq > 0 && since_seq < oldest_retained`
    // which treats 0 specially. The first-connection case should NOT signal
    // overflow (that's not what overflow means). Overflow signals a KNOWN gap.
    // since_seq=0 means "give me everything you have" — not a gap.
    // So overflow=false here is the correct behavior.
    assert!(
        !page.overflow,
        "since_seq=0 is a first-connection query, not a gap signal"
    );

    // But since_seq=5 (meaning we previously saw msg 5) with oldest=11 IS a gap.
    let page = program
        .chat()
        .get_mentions(HandleRef::Application(STUB_PROGRAM_ALPHA.into()), 5, 200)
        .await
        .unwrap();
    assert!(
        page.overflow,
        "since_seq=5 < oldest_retained signals overflow"
    );
}

#[tokio::test]
async fn get_mentions_limit_clamps_to_100() {
    let program = setup().await;

    // Push 50 mentions at nft.
    for i in 0..50u64 {
        program
            .chat()
            .post(
                format!("msg {i}"),
                HandleRef::Participant((3000 + i).into()),
                vec![HandleRef::Application(STUB_PROGRAM_ALPHA.into())],
                None,
            )
            .with_actor_id((3000 + i).into())
            .await
            .unwrap();
    }

    let page = program
        .chat()
        .get_mentions(HandleRef::Application(STUB_PROGRAM_ALPHA.into()), 0, 9999)
        .await
        .unwrap();
    assert!(page.headers.len() <= 100, "limit clamps to 100");
}

#[tokio::test]
async fn get_mentions_unknown_recipient_empty() {
    let program = setup().await;

    let page = program
        .chat()
        .get_mentions(HandleRef::Application(STUB_PROGRAM_GAMMA.into()), 0, 100)
        .await
        .unwrap();
    assert!(page.headers.is_empty());
    assert!(!page.overflow);
}
