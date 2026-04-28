//! Shared test helpers. Each tests/*.rs is an independent binary, but this
//! module is pulled into each with `mod common;`.

#![allow(dead_code)]

use agents_network_client::AgentsNetworkClientCtors;
use sails_rs::client::*;
use sails_rs::gtest::*;
use sails_rs::prelude::*;

pub const DEPLOYER: u64 = 100;
pub const ALICE: u64 = 101;
pub const BOB: u64 = 102;
pub const CAROL: u64 = 103;
pub const MALLORY: u64 = 104;

/// IDs we pretend are deployed programs. In gtest these are just ActorIds
/// that we reuse as msg::source() by calling `env.with_actor_id(...)`.
/// Real chains enforce "programs have code; wallets don't" — gtest does not,
/// so a test's "program" can masquerade as a wallet and vice versa; tests
/// choose which role to treat a given ActorId as.
pub const STUB_PROGRAM_ALPHA: u64 = 200;
pub const STUB_PROGRAM_BETA: u64 = 201;
pub const STUB_PROGRAM_GAMMA: u64 = 202;

pub const FUND: ValueUnit = 100_000_000_000_000;

pub fn init_system() -> System {
    let system = System::new();
    system.init_logger_with_default_filter("gwasm=error,gtest=error,sails_rs=error");
    system.mint_to(DEPLOYER, FUND);
    system.mint_to(ALICE, FUND);
    system.mint_to(BOB, FUND);
    system.mint_to(CAROL, FUND);
    system.mint_to(MALLORY, FUND);
    system.mint_to(STUB_PROGRAM_ALPHA, FUND);
    system.mint_to(STUB_PROGRAM_BETA, FUND);
    system.mint_to(STUB_PROGRAM_GAMMA, FUND);
    // Bulk-mint ranges used by stress/ring tests: wallet IDs 300..600 and
    // poster IDs 3000..3200. Cheap; keeps every test self-contained.
    for i in 300..600u64 {
        system.mint_to(i, FUND);
    }
    for i in 3000..3200u64 {
        system.mint_to(i, FUND);
    }
    system
}

/// Deploy the Vara Agent Network program, return an `Actor` handle bound to
/// `DEPLOYER`. Tests flip the caller per call with `.with_actor_id(...)`.
pub async fn deploy(
    env: &GtestEnv,
) -> sails_rs::client::Actor<agents_network_client::AgentsNetworkClientProgram, GtestEnv> {
    let code_id = env.system().submit_code(agents_network::WASM_BINARY);
    env.clone()
        .deploy::<agents_network_client::AgentsNetworkClientProgram>(code_id, b"salt".to_vec())
        .new(DEPLOYER.into(), 1) // admin = deployer, initial_season = 1
        .await
        .unwrap()
}

/// Convenience helper: build a `RegisterAppReq` with harmless defaults.
pub fn mk_register_req(
    handle: &str,
    operator: u64,
    program_id: u64,
) -> agents_network_client::RegisterAppReq {
    use agents_network_client::{RegisterAppReq, Track};
    RegisterAppReq {
        handle: handle.to_string(),
        program_id: ActorId::from(program_id),
        operator: ActorId::from(operator),
        github_url: format!("https://github.com/{handle}"),
        skills_hash: [1u8; 32],
        skills_url: format!("https://example.com/{handle}/skills.json"),
        idl_hash: [2u8; 32],
        idl_url: format!("https://example.com/{handle}/agent.idl"),
        description: format!("{handle} does a thing"),
        track: Track::Services,
        contacts: None,
    }
}

pub fn mk_identity_card_req() -> agents_network_client::IdentityCardReq {
    use agents_network_client::IdentityCardReq;
    IdentityCardReq {
        who_i_am: "I am a bot".to_string(),
        what_i_do: "I do things".to_string(),
        how_to_interact: "Call me".to_string(),
        what_i_offer: "Things".to_string(),
        tags: vec!["tag1".to_string(), "tag2".to_string()],
    }
}

pub fn mk_announcement_req(title: &str) -> agents_network_client::AnnouncementReq {
    use agents_network_client::AnnouncementReq;
    AnnouncementReq {
        title: title.to_string(),
        body: format!("body of {title}"),
        tags: Vec::new(),
    }
}

pub fn empty_patch() -> agents_network_client::ApplicationPatch {
    use agents_network_client::ApplicationPatch;
    ApplicationPatch {
        description: None,
        skills_url: None,
        idl_url: None,
        contacts: None,
    }
}

pub fn empty_filter() -> agents_network_client::DiscoveryFilter {
    use agents_network_client::DiscoveryFilter;
    DiscoveryFilter {
        track: None,
        status: None,
    }
}
