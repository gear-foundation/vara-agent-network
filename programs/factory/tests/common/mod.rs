//! Shared test helpers. Each tests/*.rs is an independent binary, but this
//! module is pulled into each with `mod common;`.

#![allow(dead_code)]

use factory_client::FactoryClientCtors;
use sails_rs::client::*;
use sails_rs::gtest::*;
use sails_rs::prelude::*;

pub const ADMIN: u64 = 100;
pub const ALICE: u64 = 101;
pub const BOB: u64 = 102;
pub const CAROL: u64 = 103;
pub const MALLORY: u64 = 104;

pub const FUND: ValueUnit = 100_000_000_000_000;

pub fn init_system() -> System {
    let system = System::new();
    system.init_logger_with_default_filter("gwasm=error,gtest=error,sails_rs=error");
    // Admin needs extra headroom because `deploy()` transfers a slice of
    // its balance to the factory program for child-program ED costs.
    system.mint_to(ADMIN, FUND * 4);
    system.mint_to(ALICE, FUND);
    system.mint_to(BOB, FUND);
    system.mint_to(CAROL, FUND);
    system.mint_to(MALLORY, FUND);
    system
}

/// Deploy the factory program. `cooldown_blocks` is `Some(N)` to override the
/// default; `None` leaves the program-default in place.
///
/// After deploy, the factory's on-chain balance is topped up so that the
/// `create_program` syscall has enough VARA to seed the existential deposit
/// of newly-spawned child programs. On testnet/mainnet this is paid by the
/// voucher backend funding the factory once at deploy time.
pub async fn deploy(
    env: &GtestEnv,
    cooldown_blocks: Option<u32>,
) -> sails_rs::client::Actor<factory_client::FactoryClientProgram, GtestEnv> {
    let code_id = env.system().submit_code(factory::WASM_BINARY);
    let actor = env
        .clone()
        .deploy::<factory_client::FactoryClientProgram>(code_id, b"factory-salt".to_vec())
        .new(ADMIN.into(), cooldown_blocks)
        .await
        .unwrap();

    // Cover ED for spawned children. gtest blocks `mint_to` for program
    // addresses, so route the funding through `transfer` from the admin
    // wallet (which was minted FUND in `init_system` and burned a chunk on
    // deploy gas). Half of FUND is well above any realistic ED total in a
    // test, while leaving admin enough headroom for follow-on calls.
    env.system().transfer(ADMIN, actor.id(), FUND / 2, false);
    actor
}

/// Submit a child code blob for the factory to deploy from. Re-uses the
/// factory WASM itself — any valid Sails WASM works; tests don't depend on
/// init succeeding because the factory dispatches the init message
/// asynchronously and returns the program_id before init runs.
pub fn submit_child_code(env: &GtestEnv) -> sails_rs::CodeId {
    env.system().submit_code(factory::WASM_BINARY)
}
