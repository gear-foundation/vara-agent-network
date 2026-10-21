//! Admin surface — set_cooldown, transfer_admin, query gates.

mod common;

use common::*;
use factory_client::{FactoryClient, deployer::Deployer};
use sails_rs::client::*;
use sails_rs::prelude::*;

#[tokio::test]
async fn admin_can_set_cooldown_others_cannot() {
    let system = init_system();
    let env = GtestEnv::new(system, ADMIN.into());
    let factory = deploy(&env, Some(50)).await;

    // Mallory cannot.
    factory
        .deployer()
        .set_cooldown(10)
        .with_actor_id(MALLORY.into())
        .await
        .unwrap_err();

    // Admin can.
    factory
        .deployer()
        .set_cooldown(10)
        .with_actor_id(ADMIN.into())
        .await
        .unwrap();

    let cooldown = factory.deployer().cooldown().await.unwrap();
    assert_eq!(cooldown, 10);
}

#[tokio::test]
async fn cooldown_zero_disables_rate_limit() {
    let system = init_system();
    let env = GtestEnv::new(system, ADMIN.into());
    let factory = deploy(&env, Some(0)).await;
    let code_id = submit_child_code(&env);

    // Two back-to-back deploys with cooldown=0 both succeed.
    factory
        .deployer()
        .deploy(code_id, [1u8; 16], Vec::new(), 50_000_000_000)
        .with_actor_id(ALICE.into())
        .await
        .unwrap();

    factory
        .deployer()
        .deploy(code_id, [2u8; 16], Vec::new(), 50_000_000_000)
        .with_actor_id(ALICE.into())
        .await
        .unwrap();
}

#[tokio::test]
async fn cooldown_above_max_is_rejected() {
    let system = init_system();
    let env = GtestEnv::new(system, ADMIN.into());
    let factory = deploy(&env, None).await;

    // 14_400 is the cap; one block past = reject.
    factory
        .deployer()
        .set_cooldown(14_401)
        .with_actor_id(ADMIN.into())
        .await
        .unwrap_err();
}

#[tokio::test]
async fn transfer_admin_changes_authority() {
    let system = init_system();
    let env = GtestEnv::new(system, ADMIN.into());
    let factory = deploy(&env, Some(50)).await;

    factory
        .deployer()
        .transfer_admin(ALICE.into())
        .with_actor_id(ADMIN.into())
        .await
        .unwrap();

    // Old admin lost authority.
    factory
        .deployer()
        .set_cooldown(20)
        .with_actor_id(ADMIN.into())
        .await
        .unwrap_err();

    // New admin works.
    factory
        .deployer()
        .set_cooldown(20)
        .with_actor_id(ALICE.into())
        .await
        .unwrap();

    let admin = factory.deployer().admin().await.unwrap();
    assert_eq!(admin, ALICE.into());
}

#[tokio::test]
async fn next_eligible_block_returns_zero_for_unknown_deployer() {
    let system = init_system();
    let env = GtestEnv::new(system, ADMIN.into());
    let factory = deploy(&env, Some(50)).await;

    let next = factory
        .deployer()
        .next_eligible_block(MALLORY.into())
        .await
        .unwrap();
    assert_eq!(next, 0);
}
