//! Board service gtest suite.

mod common;

use agents_network_client::{
    AgentsNetworkClient, AnnouncementKind, board::Board, registry::Registry,
};
use common::*;
use sails_rs::client::*;
use sails_rs::prelude::*;

async fn setup()
-> sails_rs::client::Actor<agents_network_client::AgentsNetworkClientProgram, GtestEnv> {
    let system = init_system();
    let env = GtestEnv::new(system, DEPLOYER.into());
    let program = deploy(&env).await;

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
async fn set_identity_card_happy_path() {
    let program = setup().await;

    program
        .board()
        .set_identity_card(STUB_PROGRAM_ALPHA.into(), mk_identity_card_req())
        .with_actor_id(BOB.into())
        .await
        .unwrap();

    let page = program
        .board()
        .list_identity_cards(None, 100)
        .await
        .unwrap();
    assert_eq!(page.items.len(), 1);
    assert_eq!(page.items[0].0, ActorId::from(STUB_PROGRAM_ALPHA));
    assert_eq!(page.items[0].1.who_i_am, "I am a bot");
}

#[tokio::test]
async fn set_identity_card_unauthorized() {
    let program = setup().await;

    // Mallory is neither the program nor the operator.
    program
        .board()
        .set_identity_card(STUB_PROGRAM_ALPHA.into(), mk_identity_card_req())
        .with_actor_id(MALLORY.into())
        .await
        .unwrap_err();

    // Program self-call works.
    program
        .board()
        .set_identity_card(STUB_PROGRAM_ALPHA.into(), mk_identity_card_req())
        .with_actor_id(STUB_PROGRAM_ALPHA.into())
        .await
        .unwrap();
}

#[tokio::test]
async fn post_announcement_happy_path() {
    let program = setup().await;

    let id = program
        .board()
        .post_announcement(STUB_PROGRAM_ALPHA.into(), mk_announcement_req("hello"))
        .with_actor_id(BOB.into())
        .await
        .unwrap();
    // Registration auto-announce already has id=1; invitation is id=2.
    assert_eq!(id, 2);

    let page = program.board().list_announcements(None, 100).await.unwrap();
    assert_eq!(page.items.len(), 2);
    // Sorted by PostId; registration (id=1) first, then invitation (id=2).
    assert_eq!(page.items[0].1.kind, AnnouncementKind::Registration);
    assert_eq!(page.items[1].1.kind, AnnouncementKind::Invitation);
    assert_eq!(page.items[1].1.title, "hello");
}

#[tokio::test]
async fn rate_limit_blocks_rapid_posts() {
    // Board rate limit is 60s per app. Consecutive posts from the same app
    // within 60s hit RateLimited.
    let program = setup().await;

    program
        .board()
        .post_announcement(STUB_PROGRAM_ALPHA.into(), mk_announcement_req("one"))
        .with_actor_id(BOB.into())
        .await
        .unwrap();

    program
        .board()
        .post_announcement(STUB_PROGRAM_ALPHA.into(), mk_announcement_req("two"))
        .with_actor_id(BOB.into())
        .await
        .unwrap_err();
}

#[tokio::test]
async fn archive_announcement_manual() {
    let program = setup().await;

    let id = program
        .board()
        .post_announcement(STUB_PROGRAM_ALPHA.into(), mk_announcement_req("drop-me"))
        .with_actor_id(BOB.into())
        .await
        .unwrap();

    program
        .board()
        .archive_announcement(STUB_PROGRAM_ALPHA.into(), id)
        .with_actor_id(BOB.into())
        .await
        .unwrap();

    let page = program.board().list_announcements(None, 100).await.unwrap();
    // Only the registration auto-announcement remains.
    assert_eq!(page.items.len(), 1);
    assert_eq!(page.items[0].1.kind, AnnouncementKind::Registration);
}

#[tokio::test]
async fn edit_announcement_happy_path() {
    let program = setup().await;

    let id = program
        .board()
        .post_announcement(STUB_PROGRAM_ALPHA.into(), mk_announcement_req("first"))
        .with_actor_id(BOB.into())
        .await
        .unwrap();

    let mut edited = mk_announcement_req("updated");
    edited.body = "new body".to_string();
    program
        .board()
        .edit_announcement(STUB_PROGRAM_ALPHA.into(), id, edited)
        .with_actor_id(BOB.into())
        .await
        .unwrap();

    let page = program.board().list_announcements(None, 100).await.unwrap();
    let inv = page
        .items
        .iter()
        .find(|(_, a)| a.kind == AnnouncementKind::Invitation)
        .unwrap();
    assert_eq!(inv.1.title, "updated");
    assert_eq!(inv.1.body, "new body");
}

#[tokio::test]
async fn registration_path_emits_no_board_event() {
    // Per Option A + shared-helper design: registerApplication writes the
    // kind=Registration announcement to state BUT emits ONLY
    // ApplicationRegistered from RegistryService. No AnnouncementPosted event
    // on the registration path.
    //
    // We can't easily assert the absence of an event without the listener
    // API. But we CAN assert the state: the announcement queue has exactly
    // 1 entry right after registration, and it's kind=Registration.
    let program = setup().await;
    let page = program.board().list_announcements(None, 100).await.unwrap();
    assert_eq!(page.items.len(), 1);
    assert_eq!(page.items[0].1.kind, AnnouncementKind::Registration);
}
