//! Factory deploy() surface tests.

mod common;

use common::*;
use factory_client::{FactoryClient, deployer::Deployer};
use sails_rs::client::*;
use sails_rs::prelude::*;

#[tokio::test]
async fn deploy_returns_program_id_and_records_state() {
    let system = init_system();
    let env = GtestEnv::new(system, ADMIN.into());
    let factory = deploy(&env, Some(0)).await; // cooldown=0 → no cooldown for happy path
    let code_id = submit_child_code(&env);

    let total_before = factory.deployer().total_deploys().await.unwrap();
    assert_eq!(total_before, 0);

    let program_id = factory
        .deployer()
        .deploy(code_id, [1u8; 16], Vec::new(), 50_000_000_000)
        .with_actor_id(ALICE.into())
        .await
        .unwrap();

    // Program ID is non-zero (would be all-zeros only on a buggy salt path).
    let zero: ActorId = 0u64.into();
    assert_ne!(program_id, zero);

    // Bookkeeping advanced.
    let total_after = factory.deployer().total_deploys().await.unwrap();
    assert_eq!(total_after, 1);

    // last_deploy_block is set for Alice and is non-None.
    let last = factory
        .deployer()
        .last_deploy_block(ALICE.into())
        .await
        .unwrap();
    assert!(last.is_some(), "last_deploy_block should be recorded");
}

#[tokio::test]
async fn cooldown_blocks_second_deploy_within_window() {
    let system = init_system();
    let env = GtestEnv::new(system, ADMIN.into());
    let factory = deploy(&env, Some(50)).await; // cooldown = 50 blocks
    let code_id = submit_child_code(&env);

    // First deploy succeeds.
    factory
        .deployer()
        .deploy(code_id, [1u8; 16], Vec::new(), 50_000_000_000)
        .with_actor_id(ALICE.into())
        .await
        .unwrap();

    // Second deploy with different salt is rejected — same deployer, still
    // inside the cooldown window. Salt difference doesn't matter; the
    // cooldown is per-deployer, not per-salt.
    factory
        .deployer()
        .deploy(code_id, [2u8; 16], Vec::new(), 50_000_000_000)
        .with_actor_id(ALICE.into())
        .await
        .unwrap_err();
}

#[tokio::test]
async fn cooldown_does_not_block_other_deployers() {
    let system = init_system();
    let env = GtestEnv::new(system, ADMIN.into());
    let factory = deploy(&env, Some(50)).await;
    let code_id = submit_child_code(&env);

    factory
        .deployer()
        .deploy(code_id, [1u8; 16], Vec::new(), 50_000_000_000)
        .with_actor_id(ALICE.into())
        .await
        .unwrap();

    // Bob is a different deployer — cooldown is per-deployer, so Bob is
    // free to deploy immediately even with the same salt (different salt
    // namespace because deployer id is mixed in).
    factory
        .deployer()
        .deploy(code_id, [1u8; 16], Vec::new(), 50_000_000_000)
        .with_actor_id(BOB.into())
        .await
        .unwrap();
}

#[tokio::test]
async fn salt_collision_avoided_across_deployers() {
    // Two deployers passing the SAME user_salt and SAME code_id must get
    // DIFFERENT program IDs because the factory mixes the deployer's
    // ActorId into the runtime salt. Without that mixing, the second
    // deploy would be rejected by the runtime as a duplicate program.
    let system = init_system();
    let env = GtestEnv::new(system, ADMIN.into());
    let factory = deploy(&env, Some(0)).await;
    let code_id = submit_child_code(&env);

    let alice_pid = factory
        .deployer()
        .deploy(code_id, [42u8; 16], Vec::new(), 50_000_000_000)
        .with_actor_id(ALICE.into())
        .await
        .unwrap();

    let bob_pid = factory
        .deployer()
        .deploy(code_id, [42u8; 16], Vec::new(), 50_000_000_000)
        .with_actor_id(BOB.into())
        .await
        .unwrap();

    assert_ne!(alice_pid, bob_pid, "different deployers must get different program IDs");
}

// NOTE: a "same_deployer_same_salt_collides" test was intentionally not added.
// On the real Vara runtime, two deploys with the same (creator=factory,
// code_id, deployer, user_salt) tuple resolve to the same program ID and
// the second is rejected as a duplicate. gtest's create_program does not
// reproduce that determinism faithfully (it folds additional per-message
// entropy into the program ID), so a collision-rejection assertion would
// be a gtest artefact, not a factory behaviour — we cover the real
// invariant (salt mixing isolates deployers) in
// `salt_collision_avoided_across_deployers` and leave runtime collision
// behaviour to be verified at smoke-test time.

#[tokio::test]
async fn init_payload_too_large_is_rejected() {
    let system = init_system();
    let env = GtestEnv::new(system, ADMIN.into());
    let factory = deploy(&env, Some(0)).await;
    let code_id = submit_child_code(&env);

    // 64 KiB + 1 byte — one byte over the limit.
    let too_big = vec![0u8; 64 * 1024 + 1];

    factory
        .deployer()
        .deploy(code_id, [1u8; 16], too_big, 50_000_000_000)
        .with_actor_id(ALICE.into())
        .await
        .unwrap_err();
}

#[tokio::test]
async fn init_gas_limit_zero_or_above_max_is_rejected() {
    let system = init_system();
    let env = GtestEnv::new(system, ADMIN.into());
    let factory = deploy(&env, Some(0)).await;
    let code_id = submit_child_code(&env);

    // Zero gas would cause the child's init to trap immediately on the
    // first instruction — factory rejects up-front rather than spawning
    // a guaranteed-dead program.
    factory
        .deployer()
        .deploy(code_id, [1u8; 16], Vec::new(), 0)
        .with_actor_id(ALICE.into())
        .await
        .unwrap_err();

    // 100 B is the cap; one above = reject.
    factory
        .deployer()
        .deploy(code_id, [2u8; 16], Vec::new(), 100_000_000_001)
        .with_actor_id(ALICE.into())
        .await
        .unwrap_err();
}
