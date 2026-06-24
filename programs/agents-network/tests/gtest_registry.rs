//! Registry service gtest suite.

mod common;

use agents_network_client::{
    AgentsNetworkClient, AppStatus, ContactLinks, HandleRef, Track, admin::Admin, board::Board,
    chat::Chat, registry::Registry, review::Review,
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

    expect_register_permit_rejected_for_test(
        &program,
        mk_register_req("foo", BOB, STUB_PROGRAM_ALPHA),
    )
    .await;
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
    expect_register_permit_rejected_for_test(&program, req).await;
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
        expect_register_permit_rejected_for_test(&program, req).await;
    }

    let mut req = mk_register_req("ipfs-idl", ALICE, STUB_PROGRAM_ALPHA);
    req.idl_url = "ipfs://bafybeibot/agent.idl".to_string();
    register_application_for_test(&program, req, STUB_PROGRAM_ALPHA).await;
}

#[tokio::test]
async fn application_hashes_must_be_non_zero() {
    let system = init_system();
    let env = GtestEnv::new(system, DEPLOYER.into());
    let program = deploy(&env).await;

    let mut req = mk_register_req("zero-skills", ALICE, STUB_PROGRAM_ALPHA);
    req.skills_hash = [0u8; 32];
    expect_register_permit_rejected_for_test(&program, req).await;

    let mut req = mk_register_req("zero-idl", ALICE, STUB_PROGRAM_ALPHA);
    req.idl_hash = [0u8; 32];
    expect_register_permit_rejected_for_test(&program, req).await;
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
        register_application_for_test(&program, mk_register_req(&handle, BOB, 300 + i), (300 + i))
            .await;
    }
}

#[tokio::test]
async fn program_id_is_globally_unique() {
    let system = init_system();
    let env = GtestEnv::new(system, DEPLOYER.into());
    let program = deploy(&env).await;

    register_application_for_test(
        &program,
        mk_register_req("openai", ALICE, STUB_PROGRAM_ALPHA),
        ALICE,
    )
    .await;

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
    expect_register_permit_rejected_for_test(
        &program,
        mk_register_req("openai-two", BOB, STUB_PROGRAM_ALPHA),
    )
    .await;
}

#[tokio::test]
async fn one_wallet_can_register_multiple_applications() {
    let system = init_system();
    let env = GtestEnv::new(system, DEPLOYER.into());
    let program = deploy(&env).await;

    register_application_for_test(
        &program,
        mk_register_req("alice-one", ALICE, STUB_PROGRAM_ALPHA),
        ALICE,
    )
    .await;
    register_application_for_test(
        &program,
        mk_register_req("alice-two", ALICE, STUB_PROGRAM_BETA),
        ALICE,
    )
    .await;

    let first = program
        .registry()
        .get_application(STUB_PROGRAM_ALPHA.into())
        .await
        .unwrap()
        .expect("first application should be registered");
    let second = program
        .registry()
        .get_application(STUB_PROGRAM_BETA.into())
        .await
        .unwrap()
        .expect("second application should be registered");
    assert_eq!(first.owner, ALICE.into());
    assert_eq!(second.owner, ALICE.into());
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

    register_application_for_test(&program, mk_register_req("alice-bot", ALICE, ALICE), ALICE)
        .await;

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
async fn building_application_can_patch_all_mutable_metadata_and_handle() {
    let system = init_system();
    let env = GtestEnv::new(system, DEPLOYER.into());
    let program = deploy(&env).await;

    register_application_for_test(
        &program,
        mk_register_req("draft-app", ALICE, STUB_PROGRAM_ALPHA),
        STUB_PROGRAM_ALPHA,
    )
    .await;

    let mut details = mk_register_req("renamed-app", ALICE, STUB_PROGRAM_ALPHA);
    details.description = "renamed description".to_string();
    details.track = Track::Open;
    details.github_url = "https://github.com/alice/draft-app".to_string();
    details.skills_hash = [3u8; 32];
    details.skills_url = "https://example.com/renamed/skills.json".to_string();
    details.idl_hash = [4u8; 32];
    details.idl_url = "https://example.com/renamed/agent.idl".to_string();
    update_application_with_approval_for_test(&program, STUB_PROGRAM_ALPHA, details, ALICE).await;

    let app = program
        .registry()
        .get_application(STUB_PROGRAM_ALPHA.into())
        .await
        .unwrap()
        .expect("application should exist");
    assert_eq!(app.handle, "renamed-app");
    assert_eq!(app.description, "renamed description");
    assert_eq!(app.track, Track::Open);
    assert_eq!(app.github_url, "https://github.com/alice/draft-app");
    assert_eq!(app.skills_hash, [3u8; 32]);
    assert_eq!(app.idl_hash, [4u8; 32]);

    assert_eq!(
        program
            .registry()
            .resolve_handle("draft-app".to_string())
            .await
            .unwrap(),
        None
    );
    assert_eq!(
        program
            .registry()
            .resolve_handle("renamed-app".to_string())
            .await
            .unwrap(),
        Some(HandleRef::Application(STUB_PROGRAM_ALPHA.into()))
    );
}

#[tokio::test]
async fn submitted_application_cannot_be_patched_but_owner_can_delete() {
    let system = init_system();
    let env = GtestEnv::new(system, DEPLOYER.into());
    let program = deploy(&env).await;

    register_application_for_test(
        &program,
        mk_register_req("submitted-app", ALICE, STUB_PROGRAM_ALPHA),
        STUB_PROGRAM_ALPHA,
    )
    .await;
    link_ready_project_review(&program, ALICE, "submitted-app", STUB_PROGRAM_ALPHA).await;
    program
        .registry()
        .submit_application(STUB_PROGRAM_ALPHA.into())
        .with_actor_id(ALICE.into())
        .await
        .unwrap();

    program
        .registry()
        .update_application_contacts(STUB_PROGRAM_ALPHA.into(), None)
        .with_actor_id(ALICE.into())
        .await
        .unwrap_err();
    program
        .registry()
        .admin_force_delete_application(STUB_PROGRAM_ALPHA.into(), "submitted cleanup".to_string())
        .with_actor_id(DEPLOYER.into())
        .await
        .unwrap();

    let app = program
        .registry()
        .get_application(STUB_PROGRAM_ALPHA.into())
        .await
        .unwrap();
    assert!(app.is_none());
}

#[tokio::test]
async fn owner_delete_removes_registry_and_handle() {
    let system = init_system();
    let env = GtestEnv::new(system, DEPLOYER.into());
    let program = deploy(&env).await;

    register_application_for_test(
        &program,
        mk_register_req("delete-me", ALICE, STUB_PROGRAM_ALPHA),
        STUB_PROGRAM_ALPHA,
    )
    .await;
    program
        .registry()
        .delete_application(STUB_PROGRAM_ALPHA.into())
        .with_actor_id(ALICE.into())
        .await
        .unwrap();

    let app = program
        .registry()
        .get_application(STUB_PROGRAM_ALPHA.into())
        .await
        .unwrap();
    assert!(app.is_none());
    assert_eq!(
        program
            .registry()
            .resolve_handle("delete-me".to_string())
            .await
            .unwrap(),
        None
    );
}

#[tokio::test]
async fn admin_can_delete_submitted_application() {
    let system = init_system();
    let env = GtestEnv::new(system, DEPLOYER.into());
    let program = deploy(&env).await;

    register_application_for_test(
        &program,
        mk_register_req("admin-delete", ALICE, STUB_PROGRAM_ALPHA),
        STUB_PROGRAM_ALPHA,
    )
    .await;
    link_ready_project_review(&program, ALICE, "admin-delete", STUB_PROGRAM_ALPHA).await;
    program
        .registry()
        .submit_application(STUB_PROGRAM_ALPHA.into())
        .with_actor_id(ALICE.into())
        .await
        .unwrap();

    program
        .registry()
        .admin_force_delete_application(STUB_PROGRAM_ALPHA.into(), "admin cleanup".to_string())
        .with_actor_id(DEPLOYER.into())
        .await
        .unwrap();

    let app = program
        .registry()
        .get_application(STUB_PROGRAM_ALPHA.into())
        .await
        .unwrap();
    assert!(app.is_none());
}

#[tokio::test]
async fn owner_can_replace_program_id_while_building() {
    let system = init_system();
    let env = GtestEnv::new(system, DEPLOYER.into());
    let program = deploy(&env).await;

    register_application_for_test(
        &program,
        mk_register_req("replace-me", ALICE, STUB_PROGRAM_ALPHA),
        STUB_PROGRAM_ALPHA,
    )
    .await;

    replace_application_program_for_test(
        &program,
        STUB_PROGRAM_ALPHA,
        mk_register_req("replace-me", ALICE, STUB_PROGRAM_BETA),
        ALICE,
        "redeployed with fixed metadata",
    )
    .await;

    assert_eq!(
        program
            .registry()
            .resolve_current_program_id(STUB_PROGRAM_ALPHA.into())
            .await
            .unwrap(),
        STUB_PROGRAM_BETA.into()
    );
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
        .expect("new program id should own the application row");
    assert_eq!(app.program_id, STUB_PROGRAM_BETA.into());
    assert_eq!(app.owner, ALICE.into());
    assert_eq!(
        program
            .registry()
            .resolve_handle("replace-me".to_string())
            .await
            .unwrap(),
        Some(HandleRef::Application(STUB_PROGRAM_BETA.into()))
    );
    let app = program
        .registry()
        .get_application(STUB_PROGRAM_BETA.into())
        .await
        .unwrap()
        .expect("replacement target should remain readable");
    assert_eq!(app.status, AppStatus::Building);
}

#[tokio::test]
async fn replacement_moves_board_chat_and_review_current_state() {
    let system = init_system();
    let env = GtestEnv::new(system, DEPLOYER.into());
    let program = deploy(&env).await;
    disable_review_rate_limit(&program).await;

    register_application_for_test(
        &program,
        mk_register_req("move-state", ALICE, STUB_PROGRAM_ALPHA),
        STUB_PROGRAM_ALPHA,
    )
    .await;
    program
        .board()
        .set_identity_card(STUB_PROGRAM_ALPHA.into(), mk_identity_card_req())
        .with_actor_id(ALICE.into())
        .await
        .unwrap();
    program
        .board()
        .post_announcement(STUB_PROGRAM_ALPHA.into(), mk_announcement_req("invite"))
        .with_actor_id(ALICE.into())
        .await
        .unwrap();
    program
        .chat()
        .post(
            "hello @move-state".to_string(),
            HandleRef::Participant(BOB.into()),
            vec![HandleRef::Application(STUB_PROGRAM_ALPHA.into())],
            None,
        )
        .with_actor_id(BOB.into())
        .await
        .unwrap();
    program
        .review()
        .request_review(STUB_PROGRAM_ALPHA.into(), "please review".to_string())
        .with_actor_id(ALICE.into())
        .await
        .unwrap();

    replace_application_program_for_test(
        &program,
        STUB_PROGRAM_ALPHA,
        mk_register_req("move-state", ALICE, STUB_PROGRAM_BETA),
        ALICE,
        "redeployed under a new program id",
    )
    .await;

    let cards = program.board().list_identity_cards(None, 10).await.unwrap();
    assert_eq!(cards.items.len(), 1);
    assert_eq!(cards.items[0].0, STUB_PROGRAM_BETA.into());

    let announcements = program.board().list_announcements(None, 10).await.unwrap();
    assert_eq!(announcements.items.len(), 2);
    assert!(
        announcements
            .items
            .iter()
            .all(|(app, _)| *app == STUB_PROGRAM_BETA.into())
    );
    program
        .board()
        .post_announcement(
            STUB_PROGRAM_BETA.into(),
            mk_announcement_req("rate-limited"),
        )
        .with_actor_id(ALICE.into())
        .await
        .unwrap_err();

    let old_mentions = program
        .chat()
        .get_mentions(HandleRef::Application(STUB_PROGRAM_ALPHA.into()), 0, 100)
        .await
        .unwrap();
    assert!(old_mentions.headers.is_empty());
    let new_mentions = program
        .chat()
        .get_mentions(HandleRef::Application(STUB_PROGRAM_BETA.into()), 0, 100)
        .await
        .unwrap();
    assert_eq!(new_mentions.headers.len(), 1);

    assert!(
        program
            .review()
            .get_review_summary(STUB_PROGRAM_ALPHA.into())
            .await
            .unwrap()
            .is_none()
    );
    let summary = program
        .review()
        .get_review_summary(STUB_PROGRAM_BETA.into())
        .await
        .unwrap()
        .expect("review summary should move to the new program id");
    assert_eq!(summary.program_id, STUB_PROGRAM_BETA.into());
    assert_eq!(summary.active_request_revision, Some(1));
}

#[tokio::test]
async fn owner_can_replace_after_revision_request_returns_to_building() {
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
        mk_register_req("revision-replace", ALICE, STUB_PROGRAM_ALPHA),
        STUB_PROGRAM_ALPHA,
    )
    .await;
    link_ready_project_review(&program, ALICE, "revision-replace", STUB_PROGRAM_ALPHA).await;
    program
        .registry()
        .submit_application(STUB_PROGRAM_ALPHA.into())
        .with_actor_id(ALICE.into())
        .await
        .unwrap();
    program
        .review()
        .request_publish_changes(
            STUB_PROGRAM_ALPHA.into(),
            1,
            "needs another deployment".to_string(),
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

    replace_application_program_for_test(
        &program,
        STUB_PROGRAM_ALPHA,
        mk_register_req("revision-replace", ALICE, STUB_PROGRAM_BETA),
        ALICE,
        "replacement after reviewer revision request",
    )
    .await;

    let summary = program
        .review()
        .get_review_summary(STUB_PROGRAM_BETA.into())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(summary.pending_submission_revision, Some(2));
    assert_eq!(summary.latest_reviewer, Some(CAROL.into()));
}

#[tokio::test]
async fn stale_program_id_mutations_are_rejected() {
    let system = init_system();
    let env = GtestEnv::new(system, DEPLOYER.into());
    let program = deploy(&env).await;

    register_application_for_test(
        &program,
        mk_register_req("stale-app", ALICE, STUB_PROGRAM_ALPHA),
        STUB_PROGRAM_ALPHA,
    )
    .await;
    replace_application_program_for_test(
        &program,
        STUB_PROGRAM_ALPHA,
        mk_register_req("stale-app", ALICE, STUB_PROGRAM_BETA),
        ALICE,
        "new deployment",
    )
    .await;

    program
        .registry()
        .update_application_contacts(STUB_PROGRAM_ALPHA.into(), None)
        .with_actor_id(ALICE.into())
        .await
        .unwrap_err();
    program
        .registry()
        .submit_application(STUB_PROGRAM_ALPHA.into())
        .with_actor_id(ALICE.into())
        .await
        .unwrap_err();
    program
        .review()
        .request_review(STUB_PROGRAM_ALPHA.into(), "stale review".to_string())
        .with_actor_id(ALICE.into())
        .await
        .unwrap_err();
    program
        .board()
        .set_identity_card(STUB_PROGRAM_ALPHA.into(), mk_identity_card_req())
        .with_actor_id(ALICE.into())
        .await
        .unwrap_err();
    program
        .chat()
        .post(
            "stale author".to_string(),
            HandleRef::Application(STUB_PROGRAM_ALPHA.into()),
            Vec::new(),
            None,
        )
        .with_actor_id(ALICE.into())
        .await
        .unwrap_err();
    program
        .chat()
        .post(
            "stale mention".to_string(),
            HandleRef::Participant(BOB.into()),
            vec![HandleRef::Application(STUB_PROGRAM_ALPHA.into())],
            None,
        )
        .with_actor_id(BOB.into())
        .await
        .unwrap_err();
}

#[tokio::test]
async fn program_ids_remain_reserved_after_replacement_and_delete() {
    let system = init_system();
    let env = GtestEnv::new(system, DEPLOYER.into());
    let program = deploy(&env).await;

    register_application_for_test(
        &program,
        mk_register_req("reserved-app", ALICE, STUB_PROGRAM_ALPHA),
        STUB_PROGRAM_ALPHA,
    )
    .await;
    replace_application_program_for_test(
        &program,
        STUB_PROGRAM_ALPHA,
        mk_register_req("reserved-app", ALICE, STUB_PROGRAM_BETA),
        ALICE,
        "reserve both ids",
    )
    .await;
    program
        .registry()
        .delete_application(STUB_PROGRAM_BETA.into())
        .with_actor_id(ALICE.into())
        .await
        .unwrap();

    expect_register_permit_rejected_for_test(
        &program,
        mk_register_req("reuse-old", ALICE, STUB_PROGRAM_ALPHA),
    )
    .await;
    expect_register_permit_rejected_for_test(
        &program,
        mk_register_req("reuse-new", ALICE, STUB_PROGRAM_BETA),
    )
    .await;
}

#[tokio::test]
async fn replacement_reason_is_required_and_capped() {
    let system = init_system();
    let env = GtestEnv::new(system, DEPLOYER.into());
    let program = deploy(&env).await;

    register_application_for_test(
        &program,
        mk_register_req("reason-app", ALICE, STUB_PROGRAM_ALPHA),
        STUB_PROGRAM_ALPHA,
    )
    .await;
    expect_replace_application_program_rejected_for_test(
        &program,
        STUB_PROGRAM_ALPHA,
        mk_register_req("reason-app", ALICE, STUB_PROGRAM_BETA),
        ALICE,
        "",
    )
    .await;
    expect_replace_application_program_rejected_for_test(
        &program,
        STUB_PROGRAM_ALPHA,
        mk_register_req("reason-app", ALICE, STUB_PROGRAM_GAMMA),
        ALICE,
        &"x".repeat(1_001),
    )
    .await;
}

#[tokio::test]
async fn replacement_limit_is_eight_per_lineage() {
    let system = init_system();
    let env = GtestEnv::new(system, DEPLOYER.into());
    let program = deploy(&env).await;

    register_application_for_test(
        &program,
        mk_register_req("limit-app", ALICE, STUB_PROGRAM_ALPHA),
        STUB_PROGRAM_ALPHA,
    )
    .await;

    let mut current = STUB_PROGRAM_ALPHA;
    for next in 300..308u64 {
        replace_application_program_for_test(
            &program,
            current,
            mk_register_req("limit-app", ALICE, next),
            ALICE,
            &format!("replacement {next}"),
        )
        .await;
        assert_eq!(
            program
                .registry()
                .resolve_current_program_id(STUB_PROGRAM_ALPHA.into())
                .await
                .unwrap(),
            next.into()
        );
        current = next;
    }

    expect_replace_application_program_rejected_for_test(
        &program,
        current,
        mk_register_req("limit-app", ALICE, 308),
        ALICE,
        "one too many",
    )
    .await;
}

#[tokio::test]
async fn replacement_rejects_submitted_live_and_award_statuses() {
    let system = init_system();
    let env = GtestEnv::new(system, DEPLOYER.into());
    let program = deploy(&env).await;

    register_application_for_test(
        &program,
        mk_register_req("submitted-reject", ALICE, STUB_PROGRAM_ALPHA),
        STUB_PROGRAM_ALPHA,
    )
    .await;
    link_ready_project_review(&program, ALICE, "submitted-reject", STUB_PROGRAM_ALPHA).await;
    program
        .registry()
        .submit_application(STUB_PROGRAM_ALPHA.into())
        .with_actor_id(ALICE.into())
        .await
        .unwrap();
    expect_replace_application_program_rejected_for_test(
        &program,
        STUB_PROGRAM_ALPHA,
        mk_register_req("submitted-reject", ALICE, STUB_PROGRAM_BETA),
        ALICE,
        "submitted should reject",
    )
    .await;

    for (idx, status) in [AppStatus::Live, AppStatus::Finalist, AppStatus::Winner]
        .into_iter()
        .enumerate()
    {
        let old = 400u64 + idx as u64 * 2;
        let new = old + 1;
        let handle = format!("status-reject-{idx}");
        register_application_for_test(&program, mk_register_req(&handle, ALICE, old), old).await;
        program
            .admin()
            .set_application_status(old.into(), status)
            .with_actor_id(DEPLOYER.into())
            .await
            .unwrap();
        expect_replace_application_program_rejected_for_test(
            &program,
            old,
            mk_register_req(&handle, ALICE, new),
            ALICE,
            "trusted status should reject",
        )
        .await;
    }
}

#[tokio::test]
async fn program_self_call_and_non_owner_cannot_delete_application() {
    let system = init_system();
    let env = GtestEnv::new(system, DEPLOYER.into());
    let program = deploy(&env).await;

    register_application_for_test(
        &program,
        mk_register_req("delete-auth", ALICE, STUB_PROGRAM_ALPHA),
        STUB_PROGRAM_ALPHA,
    )
    .await;

    program
        .registry()
        .delete_application(STUB_PROGRAM_ALPHA.into())
        .with_actor_id(STUB_PROGRAM_ALPHA.into())
        .await
        .unwrap_err();
    program
        .registry()
        .delete_application(STUB_PROGRAM_ALPHA.into())
        .with_actor_id(MALLORY.into())
        .await
        .unwrap_err();

    let app = program
        .registry()
        .get_application(STUB_PROGRAM_ALPHA.into())
        .await
        .unwrap();
    assert!(app.is_some());
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

    expect_register_permit_rejected_for_test(&program, req).await;

    let mut req = mk_register_req("contact-ok", ALICE, STUB_PROGRAM_ALPHA);
    req.contacts = Some(ContactLinks {
        discord: Some("discord-user".to_string()),
        telegram: Some("@telegram_user".to_string()),
        x: Some("@x_user".to_string()),
    });

    register_application_for_test(&program, req, STUB_PROGRAM_ALPHA).await;

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
