//! Phase 0 pre-IDL gas gate — measure worst-case per-message gas on the two
//! IDL-visible hot paths:
//!
//! - `ChatService::post` with 8 mentions × populated ring inboxes (each
//!   mention evicts oldest header).
//! - `RegistryService::register_application` full path (handle claim +
//!   applications insert + push_announcement).
//! - `RegistryService::discover` on a populated registry with selective
//!   filtering.
//! - `BoardService::list_announcements` on a populated board state.
//!
//! Measured via raw `System::run_next_block()` which returns
//! `BlockRunResult.gas_burned: BTreeMap<MessageId, Gas>`. We switch the env
//! to `BlockRunMode::Manual` so that `send_one_way` stages the message
//! without auto-executing, then run the block ourselves and inspect gas.
//!
//! Budget reference: gtest 1.10 `GAS_ALLOWANCE = 1_000_000_000_000` (1T gas
//! per block). A single message can draw most of a block; practical
//! per-message ceiling with headroom for neighbors ≈ 700B gas. We set the
//! gate 10x below that at **100B** so the test flags blog-post-material
//! regressions (a 10%-of-block hot path is already worth investigating)
//! while keeping headroom for incremental growth.

mod common;

use agents_network_client::{
    AgentsNetworkClient, Announcement, AnnouncementKind, AnnouncementMigrationEntry, AppStatus,
    Application, ApplicationMigrationEntry, Config, ContactLinks, HandleRef, IdentityCard,
    IdentityCardMigrationEntry, MigrationManifest, Participant, ParticipantMigrationEntry,
    ProgramReplacementMigrationEntry, Track, admin::Admin, board::Board, chat::Chat,
    registry::Registry,
};
use common::*;
use sails_rs::client::*;
use sails_rs::prelude::*;

/// 10%-of-block-allowance gate. Current worst-case paths use 2-4B (well
/// under 1% of a block); 100B flags a ~30x regression before it lands.
const GAS_BUDGET: u64 = 100_000_000_000;

fn checksum(byte: u8) -> [u8; 32] {
    [byte; 32]
}

fn migration_manifest() -> MigrationManifest {
    MigrationManifest {
        source_program_id: ActorId::from(9_000u64),
        snapshot_block: 12_345,
        snapshot_hash: checksum(9),
        manifest_hash: checksum(10),
        schema_version: 1,
        old_indexer_cursor: "block:12345:event:99".to_string(),
    }
}

fn migrated_application(program_id: u64, handle: String) -> Application {
    Application {
        program_id: program_id.into(),
        owner: ALICE.into(),
        handle: handle.clone(),
        description: "x".repeat(280),
        track: Track::Services,
        github_url: format!("https://github.com/{handle}"),
        skills_hash: checksum(1),
        skills_url: "x".repeat(256),
        idl_hash: checksum(2),
        idl_url: format!("https://example.com/{handle}.idl"),
        contacts: None,
        registered_at: 200,
        season_id: 1,
        status: AppStatus::Building,
    }
}

fn paused_config() -> Config {
    Config {
        paused: true,
        allow_participant_registration: true,
        allow_application_registration: true,
        allow_chat: true,
        allow_board_updates: true,
        allow_review: true,
        max_chat_body: 2048,
        max_review_body_bytes: 1_000,
        max_mentions_per_post: 8,
        mention_inbox_cap: 100,
        max_announcements_per_app: 5,
        chat_rate_limit_ms: 5_000,
        board_rate_limit_ms: 60_000,
        review_rate_limit_ms: 5_000,
    }
}

async fn setup_manual() -> (
    GtestEnv,
    sails_rs::client::Actor<agents_network_client::AgentsNetworkClientProgram, GtestEnv>,
) {
    let system = init_system();
    // Deploy in default Auto mode so the constructor's reply comes back;
    // then clone the env and switch to Manual for measurement.
    let env_auto = GtestEnv::new(system, DEPLOYER.into());
    let program = deploy(&env_auto).await;
    let env_manual = env_auto.with_block_run_mode(BlockRunMode::Manual);
    (env_manual, program)
}

/// Stage a message via `send_one_way`, run the next block, return the per-
/// message gas burned. Asserts the message executed successfully.
fn burn(env: &GtestEnv, msg_id: sails_rs::prelude::MessageId) -> u64 {
    let result = env.system().run_next_block();
    assert!(
        result.succeed.contains(&msg_id),
        "message {msg_id:?} did not succeed; failed: {:?}, not_executed: {:?}",
        result.failed,
        result.not_executed,
    );
    *result
        .gas_burned
        .get(&msg_id)
        .expect("gas_burned missing for msg_id")
}

#[tokio::test]
#[ignore = "gas-measurement gate: run with --ignored"]
async fn gas_gate_migration_batches_worst_case_per_domain() {
    let (env, program) = setup_manual().await;

    let mut pending = program.admin().begin_migration(migration_manifest());
    pending = pending.with_actor_id(DEPLOYER.into());
    let msg_id = pending.send_one_way().unwrap();
    let gas = burn(&env, msg_id);
    eprintln!("gas(begin_migration) = {gas}");
    assert!(gas < GAS_BUDGET, "begin_migration burned {gas} gas");

    let reviewers = (20_000u64..20_050).map(ActorId::from).collect::<Vec<_>>();
    let mut pending = program.admin().import_config_and_review_seed(
        "gas-seed".to_string(),
        checksum(21),
        paused_config(),
        reviewers,
    );
    pending = pending.with_actor_id(DEPLOYER.into());
    let msg_id = pending.send_one_way().unwrap();
    let gas = burn(&env, msg_id);
    eprintln!("gas(import_config_and_review_seed, 50 reviewers) = {gas}");
    assert!(
        gas < GAS_BUDGET,
        "import_config_and_review_seed burned {gas} gas"
    );

    let participants = (0..50u64)
        .map(|i| ParticipantMigrationEntry {
            wallet: (30_000 + i).into(),
            participant: Participant {
                handle: format!("migrated-participant-{i:02}"),
                github: format!("https://github.com/migrated-participant-{i:02}"),
                joined_at: 100 + i,
                season_id: 1,
            },
        })
        .collect::<Vec<_>>();
    let mut pending = program.admin().import_participants(
        "gas-participants".to_string(),
        checksum(22),
        participants,
    );
    pending = pending.with_actor_id(DEPLOYER.into());
    let msg_id = pending.send_one_way().unwrap();
    let gas = burn(&env, msg_id);
    eprintln!("gas(import_participants, 50 rows) = {gas}");
    assert!(gas < GAS_BUDGET, "import_participants burned {gas} gas");

    let applications = (0..50u64)
        .map(|i| ApplicationMigrationEntry {
            application: migrated_application(40_000 + i, format!("migrated-app-{i:02}")),
        })
        .collect::<Vec<_>>();
    let mut pending = program.admin().import_applications(
        "gas-applications".to_string(),
        checksum(23),
        applications,
    );
    pending = pending.with_actor_id(DEPLOYER.into());
    let msg_id = pending.send_one_way().unwrap();
    let gas = burn(&env, msg_id);
    eprintln!("gas(import_applications, 50 rows) = {gas}");
    assert!(gas < GAS_BUDGET, "import_applications burned {gas} gas");

    let replacements = (0..50u64)
        .map(|i| ProgramReplacementMigrationEntry {
            old_program_id: (50_000 + i).into(),
            new_program_id: (40_000 + i).into(),
            replacement_count: 1,
        })
        .collect::<Vec<_>>();
    let mut pending = program.admin().import_program_replacements(
        "gas-replacements".to_string(),
        checksum(24),
        replacements,
    );
    pending = pending.with_actor_id(DEPLOYER.into());
    let msg_id = pending.send_one_way().unwrap();
    let gas = burn(&env, msg_id);
    eprintln!("gas(import_program_replacements, 50 rows) = {gas}");
    assert!(
        gas < GAS_BUDGET,
        "import_program_replacements burned {gas} gas"
    );

    let identity_cards = (0..25u64)
        .map(|i| IdentityCardMigrationEntry {
            app: (40_000 + i).into(),
            card: IdentityCard {
                who_i_am: "x".repeat(280),
                what_i_do: "x".repeat(280),
                how_to_interact: "x".repeat(280),
                what_i_offer: "x".repeat(280),
                tags: vec!["migration".to_string()],
                updated_at: 300 + i,
                season_id: 1,
            },
        })
        .collect::<Vec<_>>();
    let announcements = (0..25u64)
        .map(|i| AnnouncementMigrationEntry {
            app: (40_000 + i).into(),
            announcement: Announcement {
                id: i + 1,
                title: "x".repeat(80),
                body: "x".repeat(1024),
                tags: vec!["migration".to_string()],
                kind: AnnouncementKind::Invitation,
                posted_at: 400 + i,
                season_id: 1,
            },
        })
        .collect::<Vec<_>>();
    let mut pending = program.admin().import_board_state(
        "gas-board".to_string(),
        checksum(25),
        identity_cards,
        announcements,
    );
    pending = pending.with_actor_id(DEPLOYER.into());
    let msg_id = pending.send_one_way().unwrap();
    let gas = burn(&env, msg_id);
    eprintln!("gas(import_board_state, 25 cards + 25 announcements) = {gas}");
    assert!(gas < GAS_BUDGET, "import_board_state burned {gas} gas");
}

#[tokio::test]
#[ignore = "gas-measurement gate: run with --ignored"]
async fn gas_gate_register_application_worst_case() {
    let (env, program) = setup_manual().await;

    // Pre-populate the registry with a batch of apps so the final registration
    // executes against a non-trivial state size.
    for i in 0..19u64 {
        let handle = format!("filler-{i:02}");
        register_application_for_test(&program, mk_register_req(&handle, BOB, 300 + i), 300 + i)
            .await;
    }

    // Worst-case RegisterAppReq: all string fields at max caps.
    let mut req = mk_register_req(&"a".repeat(32), BOB, 3_000_000); // handle max len
    req.github_url = format!("https://github.com/x/{}", "x".repeat(235));
    req.skills_url = "x".repeat(256);
    req.idl_url = format!("https://example.com/{}.idl", "x".repeat(228));
    req.description = "x".repeat(280);
    req.contacts = Some(ContactLinks {
        discord: Some("x".repeat(64)),
        telegram: Some("x".repeat(64)),
        x: Some("x".repeat(64)),
    });

    env.system().mint_to(3_000_000u64, FUND);
    let (req, _) = approved_register_req_for_test(&program, req).await;
    let mut pending = program.registry().register_application(req);
    pending = pending.with_actor_id((3_000_000u64).into());
    let msg_id = pending.send_one_way().unwrap();

    let gas = burn(&env, msg_id);
    eprintln!("gas(register_application worst-case) = {gas}");
    assert!(
        gas < GAS_BUDGET,
        "register_application worst-case burned {gas} gas; budget {GAS_BUDGET}"
    );
}

#[tokio::test]
#[ignore = "gas-measurement gate: run with --ignored"]
async fn gas_gate_chat_post_worst_case() {
    let (env, program) = setup_manual().await;

    // Pre-register 8 distinct application recipients.
    for i in 0..8u64 {
        let handle = format!("recip-{i}");
        register_application_for_test(&program, mk_register_req(&handle, ALICE, 400 + i), 400 + i)
            .await;
    }

    // Saturate ALL 8 recipient inboxes to cap 100. Every mention on the
    // worst-case post will therefore evict oldest. This is the true worst
    // case — gas scales with per-recipient eviction work, not just mention
    // count.
    //
    // 100 poster wallets × 1 post each (mentioning all 8 recipients at once)
    // saturates every inbox in 100 posts.
    let poster_ids: Vec<u64> = (5000..5100).collect();
    let all_eight: Vec<HandleRef> = (400u64..408)
        .map(|a| HandleRef::Application(a.into()))
        .collect();
    for &pid in &poster_ids {
        env.system().mint_to(pid, FUND);
    }
    for &pid in &poster_ids {
        let mut pending = program.chat().post(
            format!("fill {pid}"),
            HandleRef::Participant(pid.into()),
            all_eight.clone(),
            None,
        );
        pending = pending.with_actor_id(pid.into());
        let _ = pending.send_one_way().unwrap();
        let _ = env.system().run_next_block();
    }

    // Now the real worst-case post: 8 mentions targeting recipients 400..408.
    // Every one evicts (inbox at cap 100).
    let mentions: Vec<HandleRef> = (400u64..408)
        .map(|a| HandleRef::Application(a.into()))
        .collect();
    let body = "x".repeat(2048); // worst-case body at MAX_CHAT_BODY.

    env.system().mint_to(6_000_000u64, FUND);

    let mut pending = program.chat().post(
        body,
        HandleRef::Participant((6_000_000u64).into()),
        mentions,
        None,
    );
    pending = pending.with_actor_id((6_000_000u64).into());
    let msg_id = pending.send_one_way().unwrap();

    let gas = burn(&env, msg_id);
    eprintln!("gas(chat::post worst-case, 8-evict) = {gas}");
    assert!(
        gas < GAS_BUDGET,
        "chat::post worst-case burned {gas} gas; budget {GAS_BUDGET}"
    );
}

#[tokio::test]
#[ignore = "gas-measurement gate: run with --ignored"]
async fn gas_gate_discover_populated_registry() {
    let (env, program) = setup_manual().await;

    // Populate 60 apps, but only the last 10 match the target filter. This
    // makes discover scan through a sizable registry instead of stopping early.
    for i in 0..60u64 {
        env.system().mint_to(700 + i, FUND);
        let handle = format!("discover-{i:02}");
        let mut req = mk_register_req(&handle, ALICE, 700 + i);
        req.track = if i < 50 { Track::Services } else { Track::Open };

        let (req, _) = approved_register_req_for_test(&program, req).await;
        let mut pending = program.registry().register_application(req);
        pending = pending.with_actor_id((700 + i).into());
        let _ = pending.send_one_way().unwrap();
        let _ = env.system().run_next_block();
    }

    let mut pending = program.registry().discover(
        agents_network_client::DiscoveryFilter {
            track: Some(Track::Open),
            status: None,
        },
        None,
        50,
    );
    pending = pending.with_actor_id(DEPLOYER.into());
    let msg_id = pending.send_one_way().unwrap();

    let gas = burn(&env, msg_id);
    eprintln!("gas(discover populated selective scan) = {gas}");
    assert!(
        gas < GAS_BUDGET,
        "discover populated scan burned {gas} gas; budget {GAS_BUDGET}"
    );
}

#[tokio::test]
#[ignore = "gas-measurement gate: run with --ignored"]
async fn gas_gate_list_announcements_populated_board() {
    let (env, program) = setup_manual().await;

    // Registration auto-posts a board announcement, so 60 registrations give
    // us a populated global announcement index without fighting board rate
    // limits on a single app.
    for i in 0..60u64 {
        env.system().mint_to(900 + i, FUND);
        let handle = format!("board-{i:02}");
        register_application_for_test(&program, mk_register_req(&handle, BOB, 900 + i), 900 + i)
            .await;
    }

    let mut pending = program.board().list_announcements(None, 50);
    pending = pending.with_actor_id(DEPLOYER.into());
    let msg_id = pending.send_one_way().unwrap();

    let gas = burn(&env, msg_id);
    eprintln!("gas(list_announcements populated state) = {gas}");
    assert!(
        gas < GAS_BUDGET,
        "list_announcements populated state burned {gas} gas; budget {GAS_BUDGET}"
    );
}
