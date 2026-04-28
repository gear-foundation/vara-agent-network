//! Admin/config service gtest suite.

mod common;

use agents_network_client::{AgentsNetworkClient, admin::Admin, chat::Chat, registry::Registry};
use common::*;
use sails_rs::client::*;
use sails_rs::prelude::*;

#[tokio::test]
async fn init_sets_admin_and_default_config() {
    let system = init_system();
    let env = GtestEnv::new(system, DEPLOYER.into());
    let program = deploy(&env).await;

    let admin = program.admin().get_admin().await.unwrap();
    assert_eq!(admin, ActorId::from(DEPLOYER));

    let config = program.admin().get_config().await.unwrap();
    assert!(!config.paused);
    assert_eq!(config.max_chat_body, 2048);
    assert_eq!(config.mention_inbox_cap, 100);
}

#[tokio::test]
async fn only_admin_can_update_config() {
    let system = init_system();
    let env = GtestEnv::new(system, DEPLOYER.into());
    let program = deploy(&env).await;

    let mut config = program.admin().get_config().await.unwrap();
    config.max_chat_body = 32;

    program
        .admin()
        .update_config(config.clone())
        .with_actor_id(ALICE.into())
        .await
        .unwrap_err();

    program
        .admin()
        .update_config(config.clone())
        .with_actor_id(DEPLOYER.into())
        .await
        .unwrap();

    let updated = program.admin().get_config().await.unwrap();
    assert_eq!(updated.max_chat_body, 32);
}

#[tokio::test]
async fn pause_and_unpause_gate_user_mutations() {
    let system = init_system();
    let env = GtestEnv::new(system, DEPLOYER.into());
    let program = deploy(&env).await;

    program
        .admin()
        .pause()
        .with_actor_id(DEPLOYER.into())
        .await
        .unwrap();

    program
        .registry()
        .register_participant("alice".to_string(), "https://github.com/alice".to_string())
        .with_actor_id(ALICE.into())
        .await
        .unwrap_err();

    program
        .admin()
        .unpause()
        .with_actor_id(DEPLOYER.into())
        .await
        .unwrap();

    program
        .registry()
        .register_participant("alice".to_string(), "https://github.com/alice".to_string())
        .with_actor_id(ALICE.into())
        .await
        .unwrap();
}

#[tokio::test]
async fn config_update_changes_runtime_validation() {
    let system = init_system();
    let env = GtestEnv::new(system, DEPLOYER.into());
    let program = deploy(&env).await;

    program
        .registry()
        .register_participant("alice".to_string(), "https://github.com/alice".to_string())
        .with_actor_id(ALICE.into())
        .await
        .unwrap();

    let mut config = program.admin().get_config().await.unwrap();
    config.max_chat_body = 4;
    program
        .admin()
        .update_config(config)
        .with_actor_id(DEPLOYER.into())
        .await
        .unwrap();

    program
        .chat()
        .post(
            "12345".to_string(),
            agents_network_client::HandleRef::Participant(ALICE.into()),
            Vec::new(),
            None,
        )
        .with_actor_id(ALICE.into())
        .await
        .unwrap_err();
}

#[tokio::test]
async fn transfer_admin_changes_authority() {
    let system = init_system();
    let env = GtestEnv::new(system, DEPLOYER.into());
    let program = deploy(&env).await;

    program
        .admin()
        .transfer_admin(ALICE.into())
        .with_actor_id(DEPLOYER.into())
        .await
        .unwrap();

    let admin = program.admin().get_admin().await.unwrap();
    assert_eq!(admin, ActorId::from(ALICE));

    program
        .admin()
        .pause()
        .with_actor_id(DEPLOYER.into())
        .await
        .unwrap_err();

    program
        .admin()
        .pause()
        .with_actor_id(ALICE.into())
        .await
        .unwrap();
}
