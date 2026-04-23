//! Phase 0 pre-IDL gas gate — measure worst-case per-message gas on the two
//! IDL-visible hot paths:
//!
//! - `ChatService::post` with 8 mentions × populated ring inboxes (each
//!   mention evicts oldest header).
//! - `RegistryService::register_application` full path (handle claim +
//!   apps_by_owner append + applications insert + push_announcement).
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

use common::*;
use hackathon_client::{HackathonClient, HandleRef, chat::Chat, registry::Registry};
use sails_rs::client::*;
use sails_rs::gtest::*;
use sails_rs::prelude::*;

/// 10%-of-block-allowance gate. Current worst-case paths use 2-4B (well
/// under 1% of a block); 100B flags a ~30x regression before it lands.
const GAS_BUDGET: u64 = 100_000_000_000;

async fn setup_manual() -> (
    GtestEnv,
    sails_rs::client::Actor<hackathon_client::HackathonClientProgram, GtestEnv>,
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
fn burn(
    env: &GtestEnv,
    msg_id: sails_rs::prelude::MessageId,
) -> u64 {
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

    // Saturate apps_by_owner[BOB] to 19 entries via 19 stub-program self-registrations.
    for i in 0..19u64 {
        let handle = format!("filler-{i:02}");
        let mut pending = program
            .registry()
            .register_application(mk_register_req(&handle, BOB));
        pending = pending.with_actor_id((300 + i).into());
        let msg_id = pending.send_one_way().unwrap();
        let _ = env.system().run_next_block();
        // Drain the reply for the sent message so the queue stays clean.
        let _ = msg_id;
    }

    // Worst-case RegisterAppReq: all string fields at max caps.
    let mut req = mk_register_req(&"a".repeat(32), BOB); // handle max len
    req.github_url = "x".repeat(256);
    req.skills_url = "x".repeat(256);
    req.idl_url = "x".repeat(256);
    req.description = "x".repeat(280);
    req.x_account = Some("x".repeat(64));
    req.skills_hash = [0xab; 32];
    req.idl_hash = [0xcd; 32];

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
        let mut pending = program
            .registry()
            .register_application(mk_register_req(&handle, ALICE));
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
    // Register posters as participants (participant authorship now requires registration).
    for &pid in &poster_ids {
        env.system().mint_to(pid, FUND);
        let handle = format!("filler-{pid}");
        let mut pending = program
            .registry()
            .register_participant(handle, format!("github.com/p{pid}"));
        pending = pending.with_actor_id(pid.into());
        let _ = pending.send_one_way().unwrap();
        let _ = env.system().run_next_block();
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
    // Register the worst-case author so chat auth passes; otherwise the post
    // returns Unauthorized and we'd be measuring the rejected path.
    let mut reg_pending = program
        .registry()
        .register_participant("worst-author".to_string(), "github.com/wa".to_string());
    reg_pending = reg_pending.with_actor_id((6_000_000u64).into());
    let _ = reg_pending.send_one_way().unwrap();
    let _ = env.system().run_next_block();

    let mut pending = program
        .chat()
        .post(body, HandleRef::Participant((6_000_000u64).into()), mentions, None);
    pending = pending.with_actor_id((6_000_000u64).into());
    let msg_id = pending.send_one_way().unwrap();

    let gas = burn(&env, msg_id);
    eprintln!("gas(chat::post worst-case, 8-evict) = {gas}");
    assert!(
        gas < GAS_BUDGET,
        "chat::post worst-case burned {gas} gas; budget {GAS_BUDGET}"
    );
}
