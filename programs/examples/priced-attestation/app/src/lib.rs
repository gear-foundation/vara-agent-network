//! Priced attestation service — receiver-side reference for charging in Sails.
//!
//! Caller pays `flat_fee` per `Issue` call, gets a sequence-numbered `Receipt`.
//! Demonstrates the `pricing.md` combined refund block: value guard at the
//! top, anti-cheat self-loop reject, refund-on-error, overpayment refund.
//!
//! This first iteration is intentionally minimal — happy path + the two
//! refund branches. Idempotency (dedupe on `(caller, subject)`), `SetFee`,
//! and `WithdrawFees` land in the next iteration.

#![no_std]

extern crate alloc;

use sails_rs::cell::RefCell;
use sails_rs::gstd::{CommandReply, exec, msg};
use sails_rs::prelude::*;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/// Caller-supplied attestation type. Closed enum (additive-only post-v1).
#[derive(Encode, Decode, TypeInfo, Clone, Copy, Debug, PartialEq, Eq)]
#[codec(crate = sails_rs::scale_codec)]
#[scale_info(crate = sails_rs::scale_info)]
pub enum AttestationKind {
    /// Generic proof-of-action receipt.
    Action,
    /// Identity check receipt.
    Identity,
    /// Custom domain receipt — the caller's `subject` carries semantics.
    Custom,
}

/// Sequence-numbered attestation. Stable across retries once we add dedupe.
#[derive(Encode, Decode, TypeInfo, Clone, Debug, PartialEq, Eq)]
#[codec(crate = sails_rs::scale_codec)]
#[scale_info(crate = sails_rs::scale_info)]
pub struct Receipt {
    pub seq: u64,
    pub caller: ActorId,
    pub subject: [u8; 32],
    pub kind: AttestationKind,
    pub fee_paid: u128,
    pub issued_at: u64,
}

#[derive(Encode, Decode, TypeInfo, Clone, Debug, PartialEq, Eq)]
#[codec(crate = sails_rs::scale_codec)]
#[scale_info(crate = sails_rs::scale_info)]
pub enum Error {
    /// Owner-gated method called by a non-owner. Reserved for SetFee /
    /// WithdrawFees (next iteration).
    Unauthorized,
    /// `msg::value()` was less than `required_fee()`.
    InsufficientPayment,
    /// Self-loop attempt: program calling itself. Receiver-side anti-cheat per
    /// `agent-starter/references/pricing.md`.
    SelfLoop,
    /// Counter overflow — `next_seq` or `collected_fees` would wrap. Practically
    /// unreachable for any realistic fee/call volume but enumerated so callers
    /// see a typed error instead of a panic if it ever does.
    ArithmeticOverflow,
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

#[derive(Default)]
pub struct AttestState {
    pub owner: ActorId,
    pub flat_fee: u128,
    /// Monotonic receipt counter. First receipt has `seq = 1` so that
    /// `receipt_count()` returns the actual issued count. (`seq = 0` is
    /// reserved for "no receipts yet".)
    pub next_seq: u64,
    /// Accounting only — reflects fees the program accepted via `Issue`.
    /// Not authoritative chain balance: value can arrive via other paths
    /// (forced transfers, etc.) and `WithdrawFees` only draws against this
    /// counter, not against arbitrary balance.
    pub collected_fees: u128,
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

#[sails_rs::event]
#[derive(Encode, Decode, TypeInfo, Clone, Debug, PartialEq, Eq)]
#[codec(crate = sails_rs::scale_codec)]
#[scale_info(crate = sails_rs::scale_info)]
pub enum AttestEvent {
    ReceiptIssued {
        caller: ActorId,
        subject: [u8; 32],
        kind: AttestationKind,
        seq: u64,
        fee_paid: u128,
    },
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

pub struct AttestService<'a> {
    state: &'a RefCell<AttestState>,
}

impl<'a> AttestService<'a> {
    pub fn new(state: &'a RefCell<AttestState>) -> Self {
        Self { state }
    }
}

#[sails_rs::service(events = AttestEvent)]
impl<'a> AttestService<'a> {
    /// Pure read — current required fee.
    #[export]
    pub fn required_fee(&self) -> u128 {
        self.state.borrow().flat_fee
    }

    /// Pure read — number of receipts issued so far.
    #[export]
    pub fn receipt_count(&self) -> u64 {
        // next_seq starts at 0; first receipt bumps it to 1.
        // count == next_seq.
        self.state.borrow().next_seq
    }

    /// Pure read — total fees accepted via `Issue`. See state docs for the
    /// "accounting only, not chain balance" caveat.
    #[export]
    pub fn collected_fees(&self) -> u128 {
        self.state.borrow().collected_fees
    }

    /// Issue an attestation. Caller must attach `msg::value() >= required_fee()`.
    ///
    /// Refund matrix (per `agent-starter/references/pricing.md`):
    /// - Underpayment      → `Err(InsufficientPayment)`,  full value refunded.
    /// - Self-loop         → `Err(SelfLoop)`,             full value refunded.
    /// - ArithmeticOverflow → `Err(ArithmeticOverflow)`,  full value refunded.
    /// - Success + overpay → `Ok(Receipt)`,               excess refunded.
    /// - Success + exact   → `Ok(Receipt)`,               no refund.
    ///
    /// Refunds are delivered via `CommandReply::with_value(...)` — the reply
    /// itself carries the refund. Per Gear/Sails semantics, a separate
    /// `msg::send_bytes` queued from a handler that returns `Err` does NOT
    /// fire (`gear-messaging-and-replies.md`: "outbound send and reply effects
    /// appear only after successful execution"). Bundling the refund into the
    /// reply is the canonical Sails pattern and works on both Err and Ok paths.
    #[export]
    pub fn issue(
        &mut self,
        subject: [u8; 32],
        kind: AttestationKind,
    ) -> CommandReply<Result<Receipt, Error>> {
        let value = msg::value();
        let source = msg::source();

        // --- Anti-cheat: reject self-loop callers (pricing.md anti-cheat block).
        if source == exec::program_id() {
            return CommandReply::new(Err(Error::SelfLoop)).with_value(value);
        }

        // --- Value guard (pricing.md value-guard skeleton).
        let fee = self.state.borrow().flat_fee;
        if value < fee {
            return CommandReply::new(Err(Error::InsufficientPayment)).with_value(value);
        }

        // --- Overflow-checked counter bumps. Refund full inbound value if the
        // counter would wrap — practically unreachable but enumerated so the
        // caller sees a typed error instead of silent saturation.
        let excess = value - fee;
        let seq = {
            let mut state = self.state.borrow_mut();
            let next_seq = match state.next_seq.checked_add(1) {
                Some(n) => n,
                None => {
                    return CommandReply::new(Err(Error::ArithmeticOverflow))
                        .with_value(value);
                }
            };
            let new_collected = match state.collected_fees.checked_add(fee) {
                Some(c) => c,
                None => {
                    return CommandReply::new(Err(Error::ArithmeticOverflow))
                        .with_value(value);
                }
            };
            state.next_seq = next_seq;
            state.collected_fees = new_collected;
            next_seq
        };

        let receipt = Receipt {
            seq,
            caller: source,
            subject,
            kind,
            fee_paid: fee,
            issued_at: exec::block_timestamp(),
        };

        let _ = self.emit_event(AttestEvent::ReceiptIssued {
            caller: source,
            subject,
            kind,
            seq,
            fee_paid: fee,
        });

        // --- Success path: refund excess via the reply's value. excess == 0
        // is fine — with_value(0) is a no-op from the chain's perspective.
        CommandReply::new(Ok(receipt)).with_value(excess)
    }
}

// ---------------------------------------------------------------------------
// Program
// ---------------------------------------------------------------------------

pub struct Program {
    state: RefCell<AttestState>,
}

#[sails_rs::program]
impl Program {
    /// Construct the program. `owner` will be the address authorized to call
    /// `SetFee` and `WithdrawFees` (next iteration). `flat_fee` is the per-call
    /// fee in plancks.
    pub fn new(owner: ActorId, flat_fee: u128) -> Self {
        Self {
            state: RefCell::new(AttestState {
                owner,
                flat_fee,
                next_seq: 0,
                collected_fees: 0,
            }),
        }
    }

    pub fn attest(&self) -> AttestService<'_> {
        AttestService::new(&self.state)
    }
}
