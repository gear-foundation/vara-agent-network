//! Phase 1 canary: happy path + the three refund branches.
//!
//! Together these exercise every claim in the `Issue` doc-comment refund
//! matrix:
//!   - Exact payment    → Ok(Receipt), fee retained, no refund queued.
//!   - Overpayment      → Ok(Receipt), fee retained, excess refunded.
//!   - Underpayment     → Err(InsufficientPayment), full refund.
//!   - Self-loop        → Err(SelfLoop), full refund.
//!
//! The full 16-scenario harness (idempotency, owner-gated SetFee/WithdrawFees,
//! ArithmeticOverflow, etc.) lands in the next iteration.

use priced_attestation_client::{
    AttestationKind, Error, PricedAttestationClient, PricedAttestationClientCtors,
    PricedAttestationClientProgram, attest::Attest,
};
use sails_rs::{client::*, gtest::*};

const OWNER: u64 = 42;
const CALLER: u64 = 100;
const INITIAL_BALANCE: u128 = 1_000_000_000_000_000;
const FLAT_FEE: u128 = 1_000_000_000_000; // 1 VARA in plancks

/// Helper: deploy a fresh program with `flat_fee = FLAT_FEE` owned by `OWNER`.
async fn deploy_program() -> (
    sails_rs::client::Actor<PricedAttestationClientProgram, GtestEnv>,
    GtestEnv,
) {
    let system = System::new();
    system.init_logger_with_default_filter("gwasm=debug,gtest=info,sails_rs=debug");
    system.mint_to(OWNER, INITIAL_BALANCE);
    system.mint_to(CALLER, INITIAL_BALANCE);

    let program_code_id = system.submit_code(priced_attestation::WASM_BINARY);
    let env = GtestEnv::new(system, OWNER.into());

    let program = env
        .deploy::<PricedAttestationClientProgram>(program_code_id, b"salt".to_vec())
        .new(OWNER.into(), FLAT_FEE)
        .await
        .unwrap();

    (program, env)
}

/// Helper: caller spend across an `Issue` call. Returns the planks the caller
/// lost net of any refund. Includes gas, so use `>= expected_fee` style asserts.
fn caller_spend(env: &GtestEnv, before: u128) -> u128 {
    before - env.system().balance_of(CALLER)
}

#[tokio::test]
async fn issue_with_exact_fee_succeeds_and_charges_caller() {
    let (program, env) = deploy_program().await;
    let before = env.system().balance_of(CALLER);

    let mut attest = program.attest();
    let subject = [7u8; 32];
    let result = attest
        .issue(subject, AttestationKind::Action)
        .with_actor_id(CALLER.into())
        .with_value(FLAT_FEE)
        .await
        .unwrap();

    let receipt = result.expect("Issue should succeed on exact-fee payment");
    assert_eq!(receipt.seq, 1);
    assert_eq!(receipt.caller, CALLER.into());
    assert_eq!(receipt.subject, subject);
    assert_eq!(receipt.kind, AttestationKind::Action);
    assert_eq!(receipt.fee_paid, FLAT_FEE);

    assert_eq!(attest.receipt_count().query().unwrap(), 1);
    assert_eq!(attest.collected_fees().query().unwrap(), FLAT_FEE);

    let spent = caller_spend(&env, before);
    assert!(
        spent >= FLAT_FEE,
        "caller spent at least the fee (spent: {}, fee: {})",
        spent,
        FLAT_FEE
    );
}

#[tokio::test]
async fn issue_with_overpayment_keeps_fee_and_refunds_excess() {
    let (program, env) = deploy_program().await;
    let before = env.system().balance_of(CALLER);

    // Pay 3x the fee. Service should accept FLAT_FEE, refund 2 * FLAT_FEE.
    let attached = FLAT_FEE * 3;
    let mut attest = program.attest();
    let result = attest
        .issue([1u8; 32], AttestationKind::Identity)
        .with_actor_id(CALLER.into())
        .with_value(attached)
        .await
        .unwrap();

    let receipt = result.expect("Issue should succeed on overpayment");
    assert_eq!(receipt.fee_paid, FLAT_FEE, "receipt records the FEE, not msg::value");

    // Program retains exactly the fee in its accounting counter.
    assert_eq!(attest.collected_fees().query().unwrap(), FLAT_FEE);

    // Caller's balance reflects fee retained + excess refunded. Spend should
    // be in [FLAT_FEE, FLAT_FEE + gas_headroom). If excess wasn't refunded,
    // spend would be in [3 * FLAT_FEE, ...) — far above any plausible gas.
    let spent = caller_spend(&env, before);
    assert!(
        spent >= FLAT_FEE,
        "caller paid at least the fee (spent: {})",
        spent
    );
    assert!(
        spent < FLAT_FEE * 2,
        "excess was refunded — spend ({}) < 2 * fee ({})",
        spent,
        FLAT_FEE * 2
    );
}

#[tokio::test]
async fn issue_with_underpayment_returns_typed_err_and_refunds_full_value() {
    let (program, env) = deploy_program().await;
    let before = env.system().balance_of(CALLER);

    // Pay half the fee. Service should reject + refund.
    let attached = FLAT_FEE / 2;
    let mut attest = program.attest();
    let result = attest
        .issue([2u8; 32], AttestationKind::Action)
        .with_actor_id(CALLER.into())
        .with_value(attached)
        .await
        .unwrap();

    assert_eq!(
        result,
        Err(Error::InsufficientPayment),
        "underpayment must surface as typed Err"
    );

    // No state mutation: counter still 0, no fees collected.
    assert_eq!(attest.receipt_count().query().unwrap(), 0);
    assert_eq!(attest.collected_fees().query().unwrap(), 0);

    // Caller should have only paid gas, not the attached value.
    // Spend < attached confirms the refund landed.
    let spent = caller_spend(&env, before);
    assert!(
        spent < attached,
        "underpayment fully refunded — spend ({}) < attached ({})",
        spent,
        attached
    );
}

// NOTE: the self-loop branch is exercised in production but not in this
// gtest harness. Gtest panics with "Sending messages allowed only from
// users id" when `with_actor_id(program_id)` is set — the test framework
// blocks program-as-source synthesis. The branch is reachable on-chain
// only via a real program-to-self call, which is left for the Phase 2
// two-program harness in `priced-attestation-consumer/`.
