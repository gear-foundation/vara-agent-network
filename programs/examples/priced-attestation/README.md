# priced-attestation

A buildable, tested receiver-side reference for charging fees in a Sails program. Caller pays a flat fee per `Issue` call, gets a sequence-numbered `Receipt`. Designed as the canonical concrete form of the skeletons in [`agent-starter/references/pricing.md`](../../../agent-starter/references/pricing.md) — copy `app/src/lib.rs` into your own scaffolded crate and adapt the domain logic.

## Hackathon scoring caveat (read first)

> **Wallet-signed paid calls earn the outgoing leaderboard slice. Program-side outbound calls do not.**
>
> Per `agent-starter/references/season-economy.md` line 39, a deployed program calling `msg::send` to another program produces zero `integrationsOutProgramInitiated` credit due to a chain-level limitation. The receiver-side `integrationsIn` IS credited normally — that is what this example earns. To earn the outgoing slice on the caller side, the operator wallet (not the program) makes the paid call via `vara-wallet`. The companion `priced-attestation-consumer` example (Phase 2) demonstrates the program-side caller pattern with this caveat re-asserted in its README and tests.

## What this example demonstrates

- **Value guard** at the top of `Issue` — reject `msg::value() < required_fee()` with a typed `Err(InsufficientPayment)` and refund the full inbound value via `CommandReply::with_value`.
- **Anti-cheat self-loop reject** — reject `msg::source() == exec::program_id()` with `Err(SelfLoop)` and full refund.
- **Idempotency dedupe on `(caller, subject)`** — a retry on the same key returns the existing `Receipt` and refunds the full new payment via `DuplicateRefunded`. Callers can blind-retry on RPC timeouts without double-paying. Distinct event from `ReceiptIssued` so off-chain indexers can count both.
- **Overflow-checked counter bumps** — `next_seq` and `collected_fees` use `checked_add`; an overflow surfaces as `Err(ArithmeticOverflow)` with full refund instead of silent saturation.
- **Combined refund block** — success path refunds excess via `CommandReply::with_value(excess)` atomically with the `Ok(Receipt)` reply. No separate `msg::send_bytes` (which would not fire on Err returns per Gear/Sails reply semantics).
- **Owner-gated SetFee / WithdrawFees** — plain `msg::source() == self.owner` gate via private `ensure_owner()` helper. For production multi-admin / time-locked control, swap in `awesome-sails::access-control` (see `pricing.md`'s "Upgrading to RBAC" section).

## Refund matrix

| Branch                            | Reply                                  | Refund delivered    |
| --------------------------------- | -------------------------------------- | ------------------- |
| Self-loop (program calls itself)  | `Err(SelfLoop)`                        | full `msg::value()` |
| Idempotent retry                  | `Ok(existing Receipt)`, `DuplicateRefunded` event | full `msg::value()` |
| Underpayment                      | `Err(InsufficientPayment)`             | full `msg::value()` |
| Counter overflow                  | `Err(ArithmeticOverflow)`              | full `msg::value()` |
| First-time + exact payment        | `Ok(Receipt)`, `ReceiptIssued` event   | none                |
| First-time + overpayment          | `Ok(Receipt)`, `ReceiptIssued` event   | excess only         |

Refunds are bundled into the reply via `CommandReply<Result<Receipt, Error>>::with_value(amount)`. This is the canonical Sails-rs 0.10 pattern. A separate `msg::send_bytes` queued from a handler that returns `Err` does **not** fire — outbound side effects only flush on successful execution per `gear-messaging-and-replies.md`.

## Building

```bash
cargo build --release
```

Produces `target/wasm32-gear/release/priced_attestation.opt.wasm` and `priced_attestation.idl`.

## Testing

```bash
cargo test --release
```

Twelve payment-logic scenarios pass green:

**Refund branches (`Issue`):**
- `issue_with_exact_fee_succeeds_and_charges_caller` — `Ok(Receipt)`, fee retained, balance delta == fee.
- `issue_with_overpayment_keeps_fee_and_refunds_excess` — `Ok(Receipt)`, balance delta < 2x fee (excess refunded).
- `issue_with_underpayment_returns_typed_err_and_refunds_full_value` — `Err(InsufficientPayment)`, full refund.

**Idempotency dedupe:**
- `issue_idempotent_retry_returns_existing_receipt_and_refunds_payment` — same `(caller, subject)` twice; second returns the original `Receipt` (same seq) and refunds full new payment. `collected_fees` unchanged.
- `issue_distinct_callers_same_subject_get_distinct_receipts` — caller is part of the dedupe key.
- `issue_same_caller_distinct_subjects_get_distinct_receipts` — subject is part of the dedupe key.
- `issue_idempotent_retry_with_overpayment_refunds_full_payment` — retry path refunds the entire `msg::value()`, not just the excess (no fee charge on retry).
- `issue_with_zero_fee_mode_accepts_zero_payment` — `SetFee(0)` then zero-value `Issue` succeeds.

**Owner-gated mutations:**
- `set_fee_from_non_owner_returns_unauthorized` — `Err(Unauthorized)`, fee unchanged.
- `set_fee_from_owner_succeeds_and_subsequent_issue_uses_new_fee` — `Ok(())`, `FeeChanged` event, post-set old fee underpays, new fee succeeds.
- `withdraw_fees_owner_drains_collected_and_credits_owner` — `Ok(amount)`, `collected_fees == 0` after, owner balance increased.
- `withdraw_fees_exceeding_collected_returns_typed_err` — `Err(WithdrawExceedsCollected)`, no state change.

The self-loop branch is exercised in production but **not** in this gtest harness — `gtest::System` panics with *"Sending messages allowed only from users id"* when `with_actor_id(program_id)` is set. The two-program harness in the Phase 2 consumer example covers that path. `Err(ArithmeticOverflow)` is similarly in source but not gtest-tested (would require priming counters near `u64::MAX` / `u128::MAX`, possible via direct state injection but not via the public IDL surface).

## Scope of this iteration

Receiver-side fee mechanics complete: `Issue` (with all refund branches and idempotency dedupe), `SetFee` (owner-gated fee adjustment), `WithdrawFees` (owner-gated draw against `collected_fees`). The Phase 2 consumer example (`programs/examples/priced-attestation-consumer/`) is the natural next step — it will cover the program-side caller pattern and exercise the self-loop branch via a real two-program harness.

## License

MIT.
