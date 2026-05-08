# priced-attestation

A buildable, tested receiver-side reference for charging fees in a Sails program. Caller pays a flat fee per `Issue` call, gets a sequence-numbered `Receipt`. Designed as the canonical concrete form of the skeletons in [`agent-starter/references/pricing.md`](../../../agent-starter/references/pricing.md) — copy `app/src/lib.rs` into your own scaffolded crate and adapt the domain logic.

## Hackathon scoring caveat (read first)

> **Wallet-signed paid calls earn the outgoing leaderboard slice. Program-side outbound calls do not.**
>
> Per `agent-starter/references/season-economy.md` line 39, a deployed program calling `msg::send` to another program produces zero `integrationsOutProgramInitiated` credit due to a chain-level limitation. The receiver-side `integrationsIn` IS credited normally — that is what this example earns. To earn the outgoing slice on the caller side, the operator wallet (not the program) makes the paid call via `vara-wallet`. The companion `priced-attestation-consumer` example (Phase 2) demonstrates the program-side caller pattern with this caveat re-asserted in its README and tests.

## What this example demonstrates

- **Value guard** at the top of `Issue` — reject `msg::value() < required_fee()` with a typed `Err(InsufficientPayment)` and refund the full inbound value via `CommandReply::with_value`.
- **Anti-cheat self-loop reject** — reject `msg::source() == exec::program_id()` with `Err(SelfLoop)` and full refund.
- **Overflow-checked counter bumps** — `next_seq` and `collected_fees` use `checked_add`; an overflow surfaces as `Err(ArithmeticOverflow)` with full refund instead of silent saturation.
- **Combined refund block** — success path refunds excess via `CommandReply::with_value(excess)` atomically with the `Ok(Receipt)` reply. No separate `msg::send_bytes` (which would not fire on Err returns per Gear/Sails reply semantics).
- **Plain owner gate** — `owner: ActorId` set in the constructor. Reserved for `SetFee` / `WithdrawFees` in the next iteration. For production multi-admin / time-locked control, swap in `awesome-sails::access-control` (see `pricing.md`'s "Upgrading to RBAC" section).

## Refund matrix

| Branch                            | Reply                                | Refund delivered    |
| --------------------------------- | ------------------------------------ | ------------------- |
| Underpayment                      | `Err(InsufficientPayment)`           | full `msg::value()` |
| Self-loop (program calls itself)  | `Err(SelfLoop)`                      | full `msg::value()` |
| Counter overflow                  | `Err(ArithmeticOverflow)`            | full `msg::value()` |
| Success + exact payment           | `Ok(Receipt)`, `ReceiptIssued` event | none                |
| Success + overpayment             | `Ok(Receipt)`, `ReceiptIssued` event | excess only         |

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

Seven payment-logic scenarios pass green:

- `issue_with_exact_fee_succeeds_and_charges_caller` — `Ok(Receipt)`, fee retained, balance delta == fee.
- `issue_with_overpayment_keeps_fee_and_refunds_excess` — `Ok(Receipt)`, balance delta < 2x fee (excess refunded).
- `issue_with_underpayment_returns_typed_err_and_refunds_full_value` — `Err(InsufficientPayment)`, balance delta < attached value (full refund).
- `set_fee_from_non_owner_returns_unauthorized` — `Err(Unauthorized)`, fee unchanged.
- `set_fee_from_owner_succeeds_and_subsequent_issue_uses_new_fee` — `Ok(())`, `FeeChanged` event, post-set old fee underpays, new fee succeeds.
- `withdraw_fees_owner_drains_collected_and_credits_owner` — `Ok(amount)`, `collected_fees == 0` after, owner balance increased.
- `withdraw_fees_exceeding_collected_returns_typed_err` — `Err(WithdrawExceedsCollected)`, no state change.

The self-loop branch is exercised in production but **not** in this gtest harness — `gtest::System` panics with *"Sending messages allowed only from users id"* when `with_actor_id(program_id)` is set. The two-program harness in the Phase 2 consumer example covers that path.

## Scope of this iteration

Receiver-side fee mechanics are complete: `Issue` (with all refund branches), `SetFee` (owner-gated fee adjustment), `WithdrawFees` (owner-gated draw against `collected_fees`). Reserved for the next iteration:

- Idempotency: dedupe on `(caller, subject)` keyed `BTreeMap<(ActorId, [u8; 32]), Receipt>` so retries return the existing receipt and refund the new payment.
- 9 additional gtest scenarios (idempotency cross-caller, idempotency same-subject distinct-callers, zero-fee mode, very-large-fee overflow boundaries) per the plan.

## License

MIT.
