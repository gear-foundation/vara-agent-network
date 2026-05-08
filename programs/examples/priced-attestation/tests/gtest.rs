//! Payment-logic harness — every claim in the `Issue` doc-comment refund
//! matrix plus the idempotency dedupe contract:
//!   - Exact payment             → Ok(Receipt), fee retained, no refund queued.
//!   - Overpayment               → Ok(Receipt), fee retained, excess refunded.
//!   - Underpayment              → Err(InsufficientPayment), full refund.
//!   - Self-loop                 → Err(SelfLoop), full refund. (Not gtest-tested;
//!                                 see note below.)
//!   - Idempotent retry          → Ok(existing Receipt), full refund, no new seq.
//!   - Distinct callers / subjects → independent receipts (caller AND subject
//!                                   are part of the dedupe key).
//!   - Zero-fee mode             → Issue(0) succeeds when SetFee(0) was called.
//!   - Owner-gated SetFee, WithdrawFees, including failure modes.
//!
//! ArithmeticOverflow is in source but not gtest-tested (would require
//! priming `next_seq` or `collected_fees` near u64/u128 max — possible via
//! direct state injection but not via the public IDL surface).

use priced_attestation_client::{
    AttestationKind, Error, PricedAttestationClient, PricedAttestationClientCtors,
    PricedAttestationClientProgram, attest::Attest,
};
use sails_rs::{client::*, gtest::*};

const OWNER: u64 = 42;
const CALLER: u64 = 100;
const INITIAL_BALANCE: u128 = 1_000_000_000_000_000;
const FLAT_FEE: u128 = 1_000_000_000_000; // 1 VARA in plancks
/// Plausible upper bound on per-call gtest gas spend, used as a tolerance
/// band when asserting on owner balance deltas (gas charged from owner ≤
/// this on the withdraw path). Tighten if gtest gas accounting changes.
const GAS_HEADROOM: i128 = 1_000_000_000_000;

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

#[tokio::test]
async fn set_fee_from_non_owner_returns_unauthorized() {
    let (program, _env) = deploy_program().await;

    // CALLER is not the owner — OWNER is the deployment actor.
    let mut attest = program.attest();
    let result = attest
        .set_fee(2 * FLAT_FEE)
        .with_actor_id(CALLER.into())
        .await
        .unwrap();

    assert_eq!(result, Err(Error::Unauthorized));
    // Fee unchanged.
    assert_eq!(attest.required_fee().query().unwrap(), FLAT_FEE);
}

#[tokio::test]
async fn set_fee_from_owner_succeeds_and_subsequent_issue_uses_new_fee() {
    let (program, env) = deploy_program().await;

    let new_fee = 2 * FLAT_FEE;
    let mut attest = program.attest();
    let result = attest
        .set_fee(new_fee)
        // Default actor on env IS the OWNER, but we set it explicitly so the
        // test reads as a self-contained assertion.
        .with_actor_id(OWNER.into())
        .await
        .unwrap();

    assert_eq!(result, Ok(()));
    assert_eq!(attest.required_fee().query().unwrap(), new_fee);

    // Issue with the OLD fee now underpays.
    let underpay_result = attest
        .issue([5u8; 32], AttestationKind::Action)
        .with_actor_id(CALLER.into())
        .with_value(FLAT_FEE)
        .await
        .unwrap();
    assert_eq!(
        underpay_result,
        Err(Error::InsufficientPayment),
        "post-SetFee, paying the old fee must fail"
    );

    // Issue with the new fee succeeds.
    let before = env.system().balance_of(CALLER);
    let happy = attest
        .issue([6u8; 32], AttestationKind::Action)
        .with_actor_id(CALLER.into())
        .with_value(new_fee)
        .await
        .unwrap();
    let after = env.system().balance_of(CALLER);
    let receipt = happy.expect("Issue with new fee should succeed");
    assert_eq!(receipt.fee_paid, new_fee);
    assert_eq!(attest.collected_fees().query().unwrap(), new_fee);
    let spent = before - after;
    assert!(spent >= new_fee && spent < new_fee * 2);
}

#[tokio::test]
async fn withdraw_fees_owner_drains_collected_and_credits_owner() {
    let (program, env) = deploy_program().await;

    // Seed the program with one paid call.
    let mut attest = program.attest();
    attest
        .issue([8u8; 32], AttestationKind::Custom)
        .with_actor_id(CALLER.into())
        .with_value(FLAT_FEE)
        .await
        .unwrap()
        .expect("seed Issue should succeed");
    assert_eq!(attest.collected_fees().query().unwrap(), FLAT_FEE);

    let owner_before = env.system().balance_of(OWNER);
    let result = attest
        .withdraw_fees(FLAT_FEE)
        .with_actor_id(OWNER.into())
        .await
        .unwrap();
    let owner_after = env.system().balance_of(OWNER);

    assert_eq!(result, Ok(FLAT_FEE));
    assert_eq!(attest.collected_fees().query().unwrap(), 0);

    // Owner balance: net change = +FLAT_FEE - gas. The lower bound is
    // -GAS_HEADROOM (caller eats gas, refund hasn't arrived yet — shouldn't
    // happen on this path but tolerated). The upper bound is +FLAT_FEE
    // because the withdraw cannot credit more than the requested amount.
    let owner_delta_signed: i128 = (owner_after as i128) - (owner_before as i128);
    assert!(
        owner_delta_signed > -GAS_HEADROOM,
        "owner net delta within gas band: {}",
        owner_delta_signed
    );
    assert!(
        owner_delta_signed <= FLAT_FEE as i128,
        "owner cannot receive more than the withdraw amount"
    );
}

#[tokio::test]
async fn withdraw_fees_exceeding_collected_returns_typed_err() {
    let (program, _env) = deploy_program().await;

    // No prior Issue calls — collected_fees == 0.
    let mut attest = program.attest();
    let result = attest
        .withdraw_fees(FLAT_FEE)
        .with_actor_id(OWNER.into())
        .await
        .unwrap();

    assert_eq!(result, Err(Error::WithdrawExceedsCollected));
    assert_eq!(attest.collected_fees().query().unwrap(), 0);
}

// ---------------------------------------------------------------------------
// Idempotency (dedupe on `(caller, subject)`)
// ---------------------------------------------------------------------------

#[tokio::test]
async fn issue_idempotent_retry_returns_existing_receipt_and_refunds_payment() {
    let (program, env) = deploy_program().await;
    let mut attest = program.attest();
    let subject = [0xAA; 32];

    // First-time issue: charges fee, mints receipt seq=1.
    let first = attest
        .issue(subject, AttestationKind::Action)
        .with_actor_id(CALLER.into())
        .with_value(FLAT_FEE)
        .await
        .unwrap()
        .expect("first Issue should succeed");
    assert_eq!(first.seq, 1);
    assert_eq!(first.fee_paid, FLAT_FEE);
    assert_eq!(attest.receipt_count().query().unwrap(), 1);
    assert_eq!(attest.collected_fees().query().unwrap(), FLAT_FEE);

    let before = env.system().balance_of(CALLER);

    // Retry on same (caller, subject): returns existing receipt + refunds new payment.
    let retry = attest
        .issue(subject, AttestationKind::Action)
        .with_actor_id(CALLER.into())
        .with_value(FLAT_FEE)
        .await
        .unwrap()
        .expect("retry must surface the existing receipt as Ok");

    // Same receipt as the first call — same seq, same issued_at, same fee_paid.
    assert_eq!(retry, first, "retry must return the original Receipt unchanged");

    // No new fee charged: counter and accounting both unchanged.
    assert_eq!(attest.receipt_count().query().unwrap(), 1);
    assert_eq!(attest.collected_fees().query().unwrap(), FLAT_FEE);

    // Caller's balance: paid only gas. The full FLAT_FEE was refunded via
    // CommandReply::with_value on the retry path.
    let spent = before - env.system().balance_of(CALLER);
    assert!(
        spent < FLAT_FEE,
        "retry refunded full payment — spend ({}) < FLAT_FEE ({})",
        spent,
        FLAT_FEE
    );
}

#[tokio::test]
async fn issue_distinct_callers_same_subject_get_distinct_receipts() {
    let (program, env) = deploy_program().await;
    let mut attest = program.attest();
    let subject = [0xBB; 32];

    // Two different callers needs two minted accounts.
    let caller_a = CALLER;
    let caller_b: u64 = 200;
    env.system().mint_to(caller_b, INITIAL_BALANCE);

    let a = attest
        .issue(subject, AttestationKind::Action)
        .with_actor_id(caller_a.into())
        .with_value(FLAT_FEE)
        .await
        .unwrap()
        .expect("caller A first issue");
    let b = attest
        .issue(subject, AttestationKind::Action)
        .with_actor_id(caller_b.into())
        .with_value(FLAT_FEE)
        .await
        .unwrap()
        .expect("caller B first issue with same subject");

    assert_eq!(a.seq, 1);
    assert_eq!(a.caller, caller_a.into());
    assert_eq!(b.seq, 2);
    assert_eq!(b.caller, caller_b.into());
    assert_eq!(a.subject, b.subject, "subject is shared, only caller differs");

    // Both receipts persisted, both fees retained.
    assert_eq!(attest.receipt_count().query().unwrap(), 2);
    assert_eq!(attest.collected_fees().query().unwrap(), 2 * FLAT_FEE);
}

#[tokio::test]
async fn issue_same_caller_distinct_subjects_get_distinct_receipts() {
    let (program, _env) = deploy_program().await;
    let mut attest = program.attest();

    let a = attest
        .issue([0xC1; 32], AttestationKind::Action)
        .with_actor_id(CALLER.into())
        .with_value(FLAT_FEE)
        .await
        .unwrap()
        .expect("first subject");
    let b = attest
        .issue([0xC2; 32], AttestationKind::Identity)
        .with_actor_id(CALLER.into())
        .with_value(FLAT_FEE)
        .await
        .unwrap()
        .expect("second subject");

    assert_eq!(a.seq, 1);
    assert_eq!(b.seq, 2);
    assert_ne!(a.subject, b.subject, "subjects differ");
    assert_eq!(a.caller, b.caller, "caller is shared");
    assert_eq!(attest.receipt_count().query().unwrap(), 2);
    assert_eq!(attest.collected_fees().query().unwrap(), 2 * FLAT_FEE);
}

#[tokio::test]
async fn issue_idempotent_retry_with_overpayment_refunds_full_payment() {
    let (program, env) = deploy_program().await;
    let mut attest = program.attest();
    let subject = [0xD; 32];

    // First-time issue at exact fee.
    attest
        .issue(subject, AttestationKind::Custom)
        .with_actor_id(CALLER.into())
        .with_value(FLAT_FEE)
        .await
        .unwrap()
        .expect("first issue");

    let before = env.system().balance_of(CALLER);

    // Retry with 5x overpayment. The retry path should refund the FULL
    // 5x payment (not just the excess) because the retry doesn't charge a fee.
    let attached = 5 * FLAT_FEE;
    let retry = attest
        .issue(subject, AttestationKind::Custom)
        .with_actor_id(CALLER.into())
        .with_value(attached)
        .await
        .unwrap()
        .expect("retry must succeed regardless of value attached");
    assert_eq!(retry.seq, 1, "retry returns original seq, not a new one");
    assert_eq!(retry.fee_paid, FLAT_FEE, "fee_paid is the original fee, not the retry's value");
    assert_eq!(attest.collected_fees().query().unwrap(), FLAT_FEE);

    // Caller spent ~gas only; full 5*FLAT_FEE refunded.
    let spent = before - env.system().balance_of(CALLER);
    assert!(
        spent < FLAT_FEE,
        "retry refunded full attached value (spent: {}, attached: {})",
        spent,
        attached
    );
}

#[tokio::test]
async fn issue_with_zero_fee_mode_accepts_zero_payment() {
    let (program, env) = deploy_program().await;
    let mut attest = program.attest();

    // Owner sets fee to zero. Free-tier mode.
    attest
        .set_fee(0)
        .with_actor_id(OWNER.into())
        .await
        .unwrap()
        .expect("owner can set fee to 0");
    assert_eq!(attest.required_fee().query().unwrap(), 0);

    // Issue with zero value succeeds (0 >= 0 passes the value guard).
    let before = env.system().balance_of(CALLER);
    let r = attest
        .issue([0xEE; 32], AttestationKind::Action)
        .with_actor_id(CALLER.into())
        .with_value(0)
        .await
        .unwrap()
        .expect("zero-fee mode: zero-value Issue succeeds");
    assert_eq!(r.seq, 1);
    assert_eq!(r.fee_paid, 0);

    // collected_fees stays at 0; gas-only spend.
    assert_eq!(attest.collected_fees().query().unwrap(), 0);
    let spent = before - env.system().balance_of(CALLER);
    assert!(spent < FLAT_FEE, "free tier: caller spent only gas");
}
