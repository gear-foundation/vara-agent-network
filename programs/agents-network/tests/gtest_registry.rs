//! Registry service gtest suite.

mod common;

use agents_network_client::{
    AgentsNetworkClient, ContactLinks, HandleRef, Track, registry::Registry,
};
use common::*;
use sails_rs::client::*;
use sails_rs::prelude::*;

#[tokio::test]
async fn register_participant_happy_path() {
    let system = init_system();
    let env = GtestEnv::new(system, DEPLOYER.into());
    let program = deploy(&env).await;

    program
        .registry()
        .register_participant("alice".to_string(), "https://github.com/alice".to_string())
        .with_actor_id(ALICE.into())
        .await
        .unwrap();

    let p = program
        .registry()
        .get_participant(ALICE.into())
        .await
        .unwrap();
    assert!(p.is_some());
    let p = p.unwrap();
    assert_eq!(p.handle, "alice");
    assert_eq!(p.github, "https://github.com/alice");

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
        .register_participant("foo".to_string(), "https://github.com/alice".to_string())
        .with_actor_id(ALICE.into())
        .await
        .unwrap();

    program
        .registry()
        .register_application(mk_register_req("foo", BOB, STUB_PROGRAM_ALPHA))
        .with_actor_id(STUB_PROGRAM_ALPHA.into())
        .await
        .unwrap_err();
}

#[tokio::test]
async fn handle_malformed_variants() {
    let system = init_system();
    let env = GtestEnv::new(system, DEPLOYER.into());
    let program = deploy(&env).await;

    for bad in ["", "ab", "Alice", "emoji🤖", "a".repeat(33).as_str()] {
        program
            .registry()
            .register_participant(bad.to_string(), "https://github.com/x".to_string())
            .with_actor_id(ALICE.into())
            .await
            .unwrap_err();
    }

    // Max-length valid (32 chars).
    let thirty_two = "a".repeat(32);
    program
        .registry()
        .register_participant(thirty_two.clone(), "https://github.com/x".to_string())
        .with_actor_id(ALICE.into())
        .await
        .unwrap();
}

#[tokio::test]
async fn github_url_must_be_https_github() {
    let system = init_system();
    let env = GtestEnv::new(system, DEPLOYER.into());
    let program = deploy(&env).await;

    for bad in [
        "github.com/alice",
        "http://github.com/alice",
        "https://gitlab.com/alice/project",
    ] {
        program
            .registry()
            .register_participant("alice".to_string(), bad.to_string())
            .with_actor_id(ALICE.into())
            .await
            .unwrap_err();
    }

    let mut req = mk_register_req("bad-github", ALICE, STUB_PROGRAM_ALPHA);
    req.github_url = "https://gitlab.com/alice/project".to_string();
    program
        .registry()
        .register_application(req)
        .with_actor_id(STUB_PROGRAM_ALPHA.into())
        .await
        .unwrap_err();
}

#[tokio::test]
async fn idl_url_must_end_with_idl_extension() {
    let system = init_system();
    let env = GtestEnv::new(system, DEPLOYER.into());
    let program = deploy(&env).await;

    for bad in [
        "https://example.com/agent.json",
        "https://example.com/agent.IDL",
        "ipfs://bafybeibot/agent.json",
        "ftp://example.com/agent.idl",
    ] {
        let mut req = mk_register_req("bad-idl", ALICE, STUB_PROGRAM_ALPHA);
        req.idl_url = bad.to_string();
        program
            .registry()
            .register_application(req)
            .with_actor_id(STUB_PROGRAM_ALPHA.into())
            .await
            .unwrap_err();
    }

    let mut req = mk_register_req("ipfs-idl", ALICE, STUB_PROGRAM_ALPHA);
    req.idl_url = "ipfs://bafybeibot/agent.idl".to_string();
    program
        .registry()
        .register_application(req)
        .with_actor_id(STUB_PROGRAM_ALPHA.into())
        .await
        .unwrap();
}

#[tokio::test]
async fn application_hashes_must_be_non_zero() {
    let system = init_system();
    let env = GtestEnv::new(system, DEPLOYER.into());
    let program = deploy(&env).await;

    let mut req = mk_register_req("zero-skills", ALICE, STUB_PROGRAM_ALPHA);
    req.skills_hash = [0u8; 32];
    program
        .registry()
        .register_application(req)
        .with_actor_id(STUB_PROGRAM_ALPHA.into())
        .await
        .unwrap_err();

    let mut req = mk_register_req("zero-idl", ALICE, STUB_PROGRAM_ALPHA);
    req.idl_hash = [0u8; 32];
    program
        .registry()
        .register_application(req)
        .with_actor_id(STUB_PROGRAM_ALPHA.into())
        .await
        .unwrap_err();
}

#[tokio::test]
async fn operator_slot_griefing_resistant() {
    // A griefer cannot exhaust a victim's operator-slot budget by registering
    // stub programs that name the victim as operator. Cost-to-deploy is the
    // real anti-Sybil backstop here.
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
            .register_application(mk_register_req(&handle, BOB, 300 + i))
            .with_actor_id((300 + i).into())
            .await
            .unwrap();
    }
}

#[tokio::test]
async fn program_id_is_globally_unique() {
    let system = init_system();
    let env = GtestEnv::new(system, DEPLOYER.into());
    let program = deploy(&env).await;

    program
        .registry()
        .register_application(mk_register_req("openai", ALICE, STUB_PROGRAM_ALPHA))
        .with_actor_id(ALICE.into())
        .await
        .unwrap();

    let resolved = program
        .registry()
        .resolve_handle("openai".to_string())
        .await
        .unwrap();
    assert_eq!(
        resolved,
        Some(HandleRef::Application(STUB_PROGRAM_ALPHA.into()))
    );

    // Same program id cannot be registered twice, even under a different
    // handle/operator.
    program
        .registry()
        .register_application(mk_register_req("openai-two", BOB, STUB_PROGRAM_ALPHA))
        .with_actor_id(BOB.into())
        .await
        .unwrap_err();
}

#[tokio::test]
async fn one_wallet_can_register_multiple_applications() {
    let system = init_system();
    let env = GtestEnv::new(system, DEPLOYER.into());
    let program = deploy(&env).await;

    program
        .registry()
        .register_application(mk_register_req("alice-one", ALICE, STUB_PROGRAM_ALPHA))
        .with_actor_id(ALICE.into())
        .await
        .unwrap();
    program
        .registry()
        .register_application(mk_register_req("alice-two", ALICE, STUB_PROGRAM_BETA))
        .with_actor_id(ALICE.into())
        .await
        .unwrap();

    let page = program
        .registry()
        .discover(empty_filter(), None, 10)
        .await
        .unwrap();
    assert_eq!(page.items.len(), 2);
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
        .register_application(mk_register_req("alice-bot", ALICE, ALICE))
        .with_actor_id(ALICE.into())
        .await
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
async fn register_application_validates_contact_lengths() {
    let system = init_system();
    let env = GtestEnv::new(system, DEPLOYER.into());
    let program = deploy(&env).await;

    let mut req = mk_register_req("contact-bot", ALICE, STUB_PROGRAM_ALPHA);
    req.contacts = Some(ContactLinks {
        discord: Some("d".repeat(65)),
        telegram: None,
        x: None,
    });

    program
        .registry()
        .register_application(req)
        .with_actor_id(STUB_PROGRAM_ALPHA.into())
        .await
        .unwrap_err();

    let mut req = mk_register_req("contact-ok", ALICE, STUB_PROGRAM_ALPHA);
    req.contacts = Some(ContactLinks {
        discord: Some("discord-user".to_string()),
        telegram: Some("@telegram_user".to_string()),
        x: Some("@x_user".to_string()),
    });

    program
        .registry()
        .register_application(req)
        .with_actor_id(STUB_PROGRAM_ALPHA.into())
        .await
        .unwrap();

    let app = program
        .registry()
        .get_application(STUB_PROGRAM_ALPHA.into())
        .await
        .unwrap()
        .expect("application should be registered");

    let contacts = app.contacts.expect("contacts should be stored");
    assert_eq!(contacts.discord.as_deref(), Some("discord-user"));
    assert_eq!(contacts.telegram.as_deref(), Some("@telegram_user"));
    assert_eq!(contacts.x.as_deref(), Some("@x_user"));
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
            .register_application(mk_register_req(&handle, operator, 400 + i))
            .with_actor_id(operator.into())
            .await
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
        let mut req = mk_register_req(&handle, ALICE, 500 + i as u64);
        req.track = track;
        program
            .registry()
            .register_application(req)
            .with_actor_id(ALICE.into())
            .await
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
        .register_participant("alice".to_string(), "https://github.com/alice".to_string())
        .with_actor_id(ALICE.into())
        .await
        .unwrap();

    program
        .registry()
        .register_participant("alice2".to_string(), "https://github.com/alice".to_string())
        .with_actor_id(ALICE.into())
        .await
        .unwrap_err();
}
