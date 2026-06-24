//! Priced attestation service — receiver-side reference for charging in Sails.
//!
//! Caller pays `flat_fee` per `Issue` call, gets a sequence-numbered `Receipt`.
//! Demonstrates the combined refund block: value guard at the top, anti-cheat
//! self-loop reject, refund-on-error, overpayment refund.
//!
//! Idempotency: `Issue` deduplicates on `(caller, subject)`. A retry on the
//! same key returns the existing `Receipt` and refunds the full new payment
//! (no fee charge), so callers can blind-retry on RPC timeouts without
//! double-paying. `DuplicateRefunded` event distinguishes retries from
//! first-time issues so off-chain consumers can count both.

#![no_std]

extern crate alloc;

use sails_rs::cell::RefCell;
use sails_rs::collections::BTreeMap;
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

/// Sequence-numbered attestation. Stable across retries — `Issue` dedupes on
/// `(caller, subject)`, so retrying the same call returns the original
/// `Receipt` (same `seq`, `issued_at`, `fee_paid`) rather than minting a new
/// one.
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
    /// Owner-gated method called by a non-owner. Used by `SetFee` and
    /// `WithdrawFees`.
    Unauthorized,
    /// `msg::value()` was less than `required_fee()`.
    InsufficientPayment,
    /// Self-loop attempt: program calling itself.
    SelfLoop,
    /// Counter overflow — `next_seq` or `collected_fees` would wrap. Practically
    /// unreachable for any realistic fee/call volume but enumerated so callers
    /// see a typed error instead of a panic if it ever does.
    ArithmeticOverflow,
    /// `WithdrawFees` requested more than `collected_fees`. The withdraw
    /// counter is the source of truth for what the operator may draw — value
    /// arriving via paths other than `Issue` (forced transfers, etc.) is not
    /// withdrawable through this method.
    WithdrawExceedsCollected,
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
    ///
    /// Retained as an explicit `u64` field rather than derived from
    /// `receipts.len()` because Vara's wasm32 target makes `usize` 32-bit;
    /// we want the seq guarantee to hold beyond u32::MAX entries.
    pub next_seq: u64,
    /// Accounting only — reflects fees the program accepted via `Issue`.
    /// Not authoritative chain balance: value can arrive via other paths
    /// (forced transfers, etc.) and `WithdrawFees` only draws against this
    /// counter, not against arbitrary balance.
    pub collected_fees: u128,
    /// Idempotency dedupe: `(caller, subject) -> Receipt`. A retry on the
    /// same key returns the existing `Receipt` and refunds the full new
    /// payment via `DuplicateRefunded`, so callers can blind-retry on RPC
    /// timeouts without double-paying.
    pub receipts: BTreeMap<(ActorId, [u8; 32]), Receipt>,
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

#[sails_rs::event]
#[derive(Encode, Decode, TypeInfo, Clone, Debug, PartialEq, Eq)]
#[codec(crate = sails_rs::scale_codec)]
#[scale_info(crate = sails_rs::scale_info)]
pub enum AttestEvent {
    /// First-time issuance for a `(caller, subject)` pair. Off-chain
    /// indexers count `integrationsIn` and revenue from this event.
    ReceiptIssued {
        caller: ActorId,
        subject: [u8; 32],
        kind: AttestationKind,
        seq: u64,
        fee_paid: u128,
    },
    /// Idempotent retry on a `(caller, subject)` already issued. The
    /// existing `Receipt` is reused and the full new payment is refunded.
    /// Distinct event so indexers can separate retries from new issues.
    DuplicateRefunded {
        caller: ActorId,
        subject: [u8; 32],
        refunded: u128,
    },
    FeeChanged {
        old: u128,
        new: u128,
    },
    FeesWithdrawn {
        to: ActorId,
        amount: u128,
        remaining_collected: u128,
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

    /// Owner-gate helper. Mirrors `programs/agents-network/app/src/admin.rs`
    /// `ensure_admin`. Used by `set_fee` and `withdraw_fees`.
    fn ensure_owner(&self) -> Result<(), Error> {
        if msg::source() != self.state.borrow().owner {
            return Err(Error::Unauthorized);
        }
        Ok(())
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
    /// Refund matrix:
    /// - Self-loop                 → `Err(SelfLoop)`,             full value refunded.
    /// - Idempotent retry          → `Ok(existing Receipt)`,      full value refunded (no fee charge).
    /// - Underpayment              → `Err(InsufficientPayment)`,  full value refunded.
    /// - ArithmeticOverflow        → `Err(ArithmeticOverflow)`,   full value refunded.
    /// - First-time + overpayment  → `Ok(Receipt)`,               excess refunded.
    /// - First-time + exact        → `Ok(Receipt)`,               no refund.
    ///
    /// Refunds are delivered via `CommandReply::with_value(...)` — the reply
    /// itself carries the refund. Per Gear/Sails semantics, a separate
    /// `msg::send_bytes` queued from a handler that returns `Err` does NOT
    /// fire (`gear-messaging-and-replies.md`: "outbound send and reply effects
    /// appear only after successful execution"). Bundling the refund into the
    /// reply is the canonical Sails pattern and works on Err, Ok, and the
    /// idempotent-retry-Ok path uniformly.
    ///
    /// The retry-Ok path returns the original `Receipt` (same `seq`,
    /// `issued_at`, `fee_paid`) and emits `DuplicateRefunded` instead of
    /// `ReceiptIssued`. Callers can blind-retry on RPC timeouts without
    /// double-paying — the retry is observably distinct from the original
    /// (different event), economically equivalent (full refund), and
    /// idempotent at the receipt level (same `seq` returned).
    #[export]
    pub fn issue(
        &mut self,
        subject: [u8; 32],
        kind: AttestationKind,
    ) -> CommandReply<Result<Receipt, Error>> {
        let value = msg::value();
        let source = msg::source();

        // --- Anti-cheat: reject self-loop callers.
        // Anti-cheat trumps idempotency: even if `(program_id, subject)` is in
        // the dedupe map, a self-loop call still rejects.
        if source == exec::program_id() {
            return CommandReply::new(Err(Error::SelfLoop)).with_value(value);
        }

        // Two paths inside one borrow scope: idempotent retry vs first-time
        // issue. Early returns inside the block drop the borrow before
        // constructing the refund.
        enum Path {
            Retry(Receipt),
            New(Receipt, u128),
        }
        let path = {
            let mut state = self.state.borrow_mut();

            // --- Idempotent retry: key already issued. Reuse existing.
            if let Some(existing) = state.receipts.get(&(source, subject)) {
                Path::Retry(existing.clone())
            } else {
                // --- First-time issue: value guard + overflow-checked bumps.
                let fee = state.flat_fee;
                if value < fee {
                    return CommandReply::new(Err(Error::InsufficientPayment))
                        .with_value(value);
                }
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

                let receipt = Receipt {
                    seq: next_seq,
                    caller: source,
                    subject,
                    kind,
                    fee_paid: fee,
                    issued_at: exec::block_timestamp(),
                };
                state.receipts.insert((source, subject), receipt.clone());
                Path::New(receipt, fee)
            }
        };

        // emit_event is a `&mut self` method on the macro-generated
        // Exposure; it can't run inside the state borrow above, so the path
        // enum threads the result out and we emit + reply here.
        match path {
            Path::Retry(receipt) => {
                self.emit_event(AttestEvent::DuplicateRefunded {
                    caller: source,
                    subject,
                    refunded: value,
                })
                .expect("emit DuplicateRefunded failed");
                // Return the original receipt; refund the entire new payment.
                CommandReply::new(Ok(receipt)).with_value(value)
            }
            Path::New(receipt, fee) => {
                self.emit_event(AttestEvent::ReceiptIssued {
                    caller: source,
                    subject,
                    kind,
                    seq: receipt.seq,
                    fee_paid: fee,
                })
                .expect("emit ReceiptIssued failed");
                let excess = value - fee;
                CommandReply::new(Ok(receipt)).with_value(excess)
            }
        }
    }

    /// Owner-gated. Adjust `flat_fee`. Emits `FeeChanged { old, new }` only
    /// when the value actually changes (no-op set is silent).
    ///
    /// Plain `msg::source() == owner` gate. For production multi-admin /
    /// time-locked control, swap in `awesome-sails::access-control`.
    #[export]
    pub fn set_fee(&mut self, new_fee: u128) -> Result<(), Error> {
        self.ensure_owner()?;
        let old = {
            let mut state = self.state.borrow_mut();
            let old = state.flat_fee;
            if new_fee == old {
                return Ok(());
            }
            state.flat_fee = new_fee;
            old
        };
        self.emit_event(AttestEvent::FeeChanged { old, new: new_fee })
            .expect("emit FeeChanged failed");
        Ok(())
    }

    /// Owner-gated. Withdraw `amount` planks from `collected_fees` to the
    /// owner. Returns the amount withdrawn on success.
    ///
    /// Draws against the `collected_fees` accounting counter, NOT against
    /// arbitrary chain balance. Value that arrived via paths other than
    /// `Issue` (forced transfers, etc.) is intentionally outside this
    /// method's scope.
    #[export]
    pub fn withdraw_fees(&mut self, amount: u128) -> Result<u128, Error> {
        self.ensure_owner()?;
        let (owner, remaining) = {
            let mut state = self.state.borrow_mut();
            if amount > state.collected_fees {
                return Err(Error::WithdrawExceedsCollected);
            }
            state.collected_fees -= amount;
            (state.owner, state.collected_fees)
        };
        // Outbound send on the success path of an Ok-returning method —
        // outbound effects flush normally. The CommandReply::with_value
        // refund-on-Err rule is specific to value-bearing inbound flows; here
        // there's no inbound value to refund.
        if amount > 0 {
            msg::send_bytes(owner, [], amount).expect("withdraw send failed");
        }
        self.emit_event(AttestEvent::FeesWithdrawn {
            to: owner,
            amount,
            remaining_collected: remaining,
        })
        .expect("emit FeesWithdrawn failed");
        Ok(amount)
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
                receipts: BTreeMap::new(),
            }),
        }
    }

    pub fn attest(&self) -> AttestService<'_> {
        AttestService::new(&self.state)
    }
}
