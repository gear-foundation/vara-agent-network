//! Registry service gtest suite.

mod common;

use common::*;
use agents_network_client::{AgentsNetworkClient, HandleRef, RegistryError, Track, registry::Registry};
use sails_rs::client::*;
use sails_rs::gtest::*;
use sails_rs::prelude::*;

#[tokio::test]
async fn register_participant_happy_path() {
    let system = init_system();
    let env = GtestEnv::new(system, DEPLOYER.into());
    let program = deploy(&env).await;

    program
        .registry()
        .register_participant("alice".to_string(), "github.com/alice".to_string())
        .with_actor_id(ALICE.into())
        .await
        .unwrap()
        .unwrap();

    let p = program
        .registry()
        .get_participant(ALICE.into())
        .await
        .unwrap();
    assert!(p.is_some());
    let p = p.unwrap();
    assert_eq!(p.handle, "alice");
    assert_eq!(p.github, "github.com/alice");

    let resolved = program
        .registry()
        .resolve_handle("alice".to_string())
        .await
        .unwrap();
    assert_eq!(resolved, Some(HandleRef::Participant(ALICE.into())));
}

#[tokio::test]
async fn cross_namespace_handle_collision() {
    // Participant claims "foo"; program trying to register with handle "foo"
    // gets HandleTaken — the unified namespace blocks the cross-claim.
    let system = init_system();
    let env = GtestEnv::new(system, DEPLOYER.into());
    let program = deploy(&env).await;

    program
        .registry()
        .register_participant("foo".to_string(), "github.com/alice".to_string())
        .with_actor_id(ALICE.into())
        .await
        .unwrap()
        .unwrap();

    let err = program
        .registry()
        .register_application(mk_register_req("foo", BOB))
        .with_actor_id(STUB_PROGRAM_ALPHA.into())
        .await
        .unwrap()
        .unwrap_err();
    assert_eq!(err, RegistryError::HandleTaken);
}

#[tokio::test]
async fn handle_malformed_variants() {
    let system = init_system();
    let env = GtestEnv::new(system, DEPLOYER.into());
    let program = deploy(&env).await;

    for bad in ["", "ab", "Alice", "al_ice", "emoji🤖", "a".repeat(33).as_str()] {
        let err = program
            .registry()
            .register_participant(bad.to_string(), "github.com/x".to_string())
            .with_actor_id(ALICE.into())
            .await
            .unwrap()
            .unwrap_err();
        assert_eq!(
            err,
            RegistryError::HandleMalformed,
            "expected HandleMalformed for {bad:?}",
        );
    }

    // Max-length valid (32 chars).
    let thirty_two = "a".repeat(32);
    program
        .registry()
        .register_participant(thirty_two.clone(), "github.com/x".to_string())
        .with_actor_id(ALICE.into())
        .await
        .unwrap()
        .unwrap();
}

#[tokio::test]
async fn operator_slot_griefing_resistant() {
    // After the /review fix: `apps_by_owner[req.operator]` is no longer capped.
    // A griefer cannot exhaust a victim's operator-slot budget by registering
    // stub programs that name the victim as operator. `apps_by_owner` is still
    // populated for UX lookup. Cost-to-deploy is the real anti-Sybil backstop.
    let system = init_system();
    for i in 0..25u64 {
        system.mint_to(300 + i, FUND);
    }
    let env = GtestEnv::new(system, DEPLOYER.into());
    let program = deploy(&env).await;

    // 21 registrations all attesting BOB as operator — none should fail.
    for i in 0..21u64 {
        let handle = format!("app-{i:02}");
        program
            .registry()
            .register_application(mk_register_req(&handle, BOB))
            .with_actor_id((300 + i).into())
            .await
            .unwrap()
            .unwrap();
    }
}

#[tokio::test]
async fn program_ownership_proof_blocks_squatting() {
    // A wallet cannot impersonate a deployed program's ActorId. If the squatter
    // wallet X calls registerApplication claiming the handle, the registry
    // always writes applications[msg::source()] — so X registers itself (as a
    // wallet-agent), NOT someone else's program.
    let system = init_system();
    let env = GtestEnv::new(system, DEPLOYER.into());
    let program = deploy(&env).await;

    // Squatter Mallory registers claiming handle "openai".
    program
        .registry()
        .register_application(mk_register_req("openai", MALLORY))
        .with_actor_id(MALLORY.into())
        .await
        .unwrap()
        .unwrap();

    // Handle resolves to Mallory's ActorId, not any program.
    let resolved = program
        .registry()
        .resolve_handle("openai".to_string())
        .await
        .unwrap();
    assert_eq!(resolved, Some(HandleRef::Application(MALLORY.into())));

    // The real OpenAI program later tries to register. Handle is taken — but
    // by mallory's wallet, not by a rival program. Squatter can only squat
    // handles; they cannot impersonate a specific program ActorId.
    let err = program
        .registry()
        .register_application(mk_register_req("openai", ALICE))
        .with_actor_id(STUB_PROGRAM_ALPHA.into())
        .await
        .unwrap()
        .unwrap_err();
    assert_eq!(err, RegistryError::HandleTaken);

    // The real program can still register under a different handle.
    program
        .registry()
        .register_application(mk_register_req("openai-real", ALICE))
        .with_actor_id(STUB_PROGRAM_ALPHA.into())
        .await
        .unwrap()
        .unwrap();
}

#[tokio::test]
async fn wallet_agent_archetype_is_legitimate() {
    // A wallet CAN register itself as an application (Social/Open archetype).
    // No security issue; handle claimed; chat/board authorship uses the same
    // wallet ActorId. Functionally equivalent to a participant but in the
    // application namespace.
    let system = init_system();
    let env = GtestEnv::new(system, DEPLOYER.into());
    let program = deploy(&env).await;

    program
        .registry()
        .register_application(mk_register_req("alice-bot", ALICE))
        .with_actor_id(ALICE.into())
        .await
        .unwrap()
        .unwrap();

    let app = program
        .registry()
        .get_application(ALICE.into())
        .await
        .unwrap();
    assert!(app.is_some());
    let app = app.unwrap();
    assert_eq!(app.handle, "alice-bot");
    assert_eq!(app.owner, ALICE.into());
}

#[tokio::test]
async fn discover_clamps_limit_to_50() {
    let system = init_system();
    for i in 0..60u64 {
        system.mint_to(400 + i, FUND);
    }
    let env = GtestEnv::new(system, DEPLOYER.into());
    let program = deploy(&env).await;

    // Register 60 apps (spread across 3 operators to avoid AppLimitReached).
    for i in 0..60u64 {
        let handle = format!("app-{i:02}");
        let operator = match i / 20 {
            0 => ALICE,
            1 => BOB,
            _ => CAROL,
        };
        program
            .registry()
            .register_application(mk_register_req(&handle, operator))
            .with_actor_id((400 + i).into())
            .await
            .unwrap()
            .unwrap();
    }

    let page = program
        .registry()
        .discover(empty_filter(), None, 1000)
        .await
        .unwrap();
    assert_eq!(page.items.len(), 50, "limit must clamp to 50");
}

#[tokio::test]
async fn discover_track_filter() {
    let system = init_system();
    for i in 0..10u64 {
        system.mint_to(500 + i, FUND);
    }
    let env = GtestEnv::new(system, DEPLOYER.into());
    let program = deploy(&env).await;

    // 3 Services, 3 Social, 2 Economy, 2 Open.
    let tracks = [
        Track::Services,
        Track::Services,
        Track::Services,
        Track::Social,
        Track::Social,
        Track::Social,
        Track::Economy,
        Track::Economy,
        Track::Open,
        Track::Open,
    ];
    for (i, track) in tracks.into_iter().enumerate() {
        let handle = format!("app-{i}");
        let mut req = mk_register_req(&handle, ALICE);
        req.track = track;
        program
            .registry()
            .register_application(req)
            .with_actor_id((500 + i as u64).into())
            .await
            .unwrap()
            .unwrap();
    }

    let page = program
        .registry()
        .discover(
            agents_network_client::DiscoveryFilter {
                track: Some(Track::Services),
                status: None,
            },
            None,
            100,
        )
        .await
        .unwrap();
    assert_eq!(page.items.len(), 3);
    for app in &page.items {
        assert_eq!(app.track, Track::Services);
    }
}

#[tokio::test]
async fn already_registered_rejects_second_participant_call() {
    let system = init_system();
    let env = GtestEnv::new(system, DEPLOYER.into());
    let program = deploy(&env).await;

    program
        .registry()
        .register_participant("alice".to_string(), "github.com/alice".to_string())
        .with_actor_id(ALICE.into())
        .await
        .unwrap()
        .unwrap();

    let err = program
        .registry()
        .register_participant("alice2".to_string(), "github.com/alice".to_string())
        .with_actor_id(ALICE.into())
        .await
        .unwrap()
        .unwrap_err();
    assert_eq!(err, RegistryError::AlreadyRegistered);
}
