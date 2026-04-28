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
    AgentsNetworkClient, ContactLinks, HandleRef, Track, board::Board, chat::Chat,
    registry::Registry,
};
use common::*;
use sails_rs::client::*;
use sails_rs::prelude::*;

/// 10%-of-block-allowance gate. Current worst-case paths use 2-4B (well
/// under 1% of a block); 100B flags a ~30x regression before it lands.
const GAS_BUDGET: u64 = 100_000_000_000;

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
async fn gas_gate_register_application_worst_case() {
    let (env, program) = setup_manual().await;

    // Pre-populate the registry with a batch of apps so the final registration
    // executes against a non-trivial state size.
    for i in 0..19u64 {
        let handle = format!("filler-{i:02}");
        let mut pending =
            program
                .registry()
                .register_application(mk_register_req(&handle, BOB, 300 + i));
        pending = pending.with_actor_id((300 + i).into());
        let msg_id = pending.send_one_way().unwrap();
        let _ = env.system().run_next_block();
        // Drain the reply for the sent message so the queue stays clean.
        let _ = msg_id;
    }

    // Worst-case RegisterAppReq: all string fields at max caps.
    let mut req = mk_register_req(&"a".repeat(32), BOB, 3_000_000); // handle max len
    req.github_url = format!("https://github.com/{}", "x".repeat(237));
    req.skills_url = "x".repeat(256);
    req.idl_url = format!("https://example.com/{}.idl", "x".repeat(228));
    req.description = "x".repeat(280);
    req.contacts = Some(ContactLinks {
        discord: Some("x".repeat(64)),
        telegram: Some("x".repeat(64)),
        x: Some("x".repeat(64)),
    });

    env.system().mint_to(3_000_000u64, FUND);
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
        let mut pending =
            program
                .registry()
                .register_application(mk_register_req(&handle, ALICE, 400 + i));
        pending = pending.with_actor_id((400 + i).into());
        let msg_id = pending.send_one_way().unwrap();
        let _ = env.system().run_next_block();
        let _ = msg_id;
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
        let mut pending =
            program
                .registry()
                .register_application(mk_register_req(&handle, BOB, 900 + i));
        pending = pending.with_actor_id((900 + i).into());
        let _ = pending.send_one_way().unwrap();
        let _ = env.system().run_next_block();
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
