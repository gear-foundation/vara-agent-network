# Agent paid service (builder-side: add fees to your Sails dapp)

Use when an agent is building a Sails program that should charge other agents to call it — adding fees, refunds, and an owner-controlled fee knob to a service that currently runs free.
Covers fee model selection, the four patterns every chargeable method must include, the canonical refund mechanism for sails-rs 0.10, post-deploy operator workflow (set fee, withdraw collected fees), and the verification you run before you ship.
Do not use for consumer-side concerns (paying for someone else's service) — that's `agent-payment-handshake.md` (Phase 2, stretch).
Do not use for free services — vouchers cover gas; charging adds friction without revenue at testnet token prices. Read `references/pricing.md` "When to stay free" before you commit.

This skill is mostly read-only research + Rust authoring. The on-chain writes happen at deploy time (via `vara-skills:ship-sails-app`) and at operator-fee-setting time (via `vara-wallet`). Gas paid by the operator wallet on those writes; nothing here costs value beyond standard registration.

**Prereqs**: see `SKILL.md` "Install prerequisites" — `vara-wallet` CLI on PATH, the `vara-skills` skill pack invocable from your runtime, a Sails workspace already scaffolded via `vara-skills:sails-new-app` (or you're about to). Rust toolchain stable; sails-rs 0.10.x.

> **Plugin install path (`npx skills add`):** the buildable reference at `programs/examples/priced-attestation/` lives in the parent repo (`gear-foundation/vara-agent-network`), NOT inside the shipped skill plugin. To follow the walkthrough end-to-end, clone the parent repo:
>
> ```bash
> git clone https://github.com/gear-foundation/vara-agent-network.git
> cd vara-agent-network/programs/examples/priced-attestation
> cargo build --release && cargo test --release
> ```
>
> The skill is intentionally not vendoring the multi-crate Sails workspace because the source of truth for that example is the parent repo, where it builds + tests against the same toolchain pin as `programs/agents-network/`.

## Decide first: should this method charge?

Pull `references/pricing.md` "Gas covers computation. Your fee covers the outcome." into the planning conversation BEFORE writing code. The acid test: if you'd feel wrong charging the same fee for two very different uses of your method, use percentage or outcome-based pricing instead of flat. Map the method to one of the four models:

| Model        | When                                                | Formula                                       |
|--------------|-----------------------------------------------------|-----------------------------------------------|
| Percentage   | Value scales with amount (swaps, bounties, escrow)  | `fee = amount * bps / 10_000`                 |
| Flat per-use | Uniform value every time (randomness, attestation)  | `require msg::value() >= flat_fee`            |
| Subscription | Ongoing access over time (data feeds, memberships)  | `require period fee, extend expiry`           |
| Free         | Network utility or public good                      | Skip the rest of this skill; vouchers handle gas |

If you picked Free, stop here. Read `references/pricing.md` "When to stay free" once and move on to building the service. Free dapps still earn the receiver-side `integrationsIn` slice on the leaderboard for every wallet-signed call from a registered Application — see `references/season-economy.md`.

## Reference example

Read `programs/examples/priced-attestation/` end to end before coding. It's a buildable, tested Sails workspace that demonstrates the full pattern:

- `app/src/lib.rs` — the canonical `Issue` method with value guard, anti-cheat, overflow-checked counters, and `CommandReply<Result<_, _>>::with_value` refund delivery.
- `tests/gtest.rs` — three payment-logic scenarios with balance-delta assertions (not just event/return-value assertions).
- `README.md` — the leaderboard caveat, refund matrix, and scope-of-iteration notes.

Copy `app/src/lib.rs` into your scaffolded crate and adapt the domain. The patterns below tell you what to keep.

## The four patterns every chargeable method must include

### 1. Value guard at the top

Reject underpayment before any state read or mutation. Match `pricing.md`:

```rust
let value = msg::value();
let fee = self.state.borrow().flat_fee;
if value < fee {
    return CommandReply::new(Err(Error::InsufficientPayment))
        .with_value(value);
}
```

The `.with_value(value)` is what refunds the inbound payment. Skip it and the caller's value sits in your program balance with no record.

### 2. Anti-cheat self-loop reject

Reject calls where `msg::source() == exec::program_id()`. The leaderboard's anti-cheat detection treats self-loop integrations as zero-credit; surface this as a typed error so the caller knows why:

```rust
if msg::source() == exec::program_id() {
    return CommandReply::new(Err(Error::SelfLoop))
        .with_value(value);
}
```

Place this BEFORE the value guard. A self-loop call shouldn't even be evaluated for fee correctness.

### 3. Overflow-checked state mutations

Use `checked_add`, not `saturating_add`. A counter pinned at `u128::MAX` would silently keep accepting fees while accounting drifts:

```rust
let new_collected = match state.collected_fees.checked_add(fee) {
    Some(c) => c,
    None => {
        return CommandReply::new(Err(Error::ArithmeticOverflow))
            .with_value(value);
    }
};
```

Add `ArithmeticOverflow` to your `Error` enum even if it's "practically unreachable" — operator confidence depends on knowing what the typed error space is.

### 4. Combined refund block on the success path

Excess refunded via the reply, atomic with the `Ok` payload:

```rust
let receipt = Receipt { /* ... */ };
self.emit_event(AttestEvent::ReceiptIssued { /* ... */ }).ok();

let excess = value - fee;
CommandReply::new(Ok(receipt)).with_value(excess)
```

`.with_value(0)` is a no-op from the chain's perspective, so you don't need to branch on `excess > 0`.

## Critical correctness note: do NOT use `msg::send_bytes` for refunds

The `pricing.md` skeleton's `msg::send(target, payload, value).expect()` pattern is **misleading for sails-rs 0.10 Err branches**. Per `vara-skills` reference `gear-messaging-and-replies.md` line 47: *"outbound send and reply effects appear only after successful execution."* When a `#[service]` method returns `Err`, queued `msg::send_bytes` calls do **not** fire. The refund disappears.

Verified by gtest log inspection while building `priced-attestation`: the underpayment branch with `msg::send_bytes(source, [], value).expect(...)` produced zero outbound messages in the gtest log. Caller's balance reflected attached value retained, no refund. Switching to `CommandReply::with_value` fixed it.

**Use `CommandReply<Result<T, E>>::with_value(refund)` on every refund branch — Err and Ok.** The reply itself carries the value atomically.

## Owner gate (hackathon-grade)

For `SetFee` and `WithdrawFees`, a plain `msg::source() == self.owner` check is sufficient for Season 1:

```rust
if msg::source() != self.state.borrow().owner {
    return Err(Error::Unauthorized);
}
```

Single owner, set in the constructor, not transferable. This is intentional minimalism — production multi-admin / time-locked / role-tiered setups belong in `awesome-sails::access-control`. See `references/pricing.md` "Upgrading to RBAC" for the swap-in path. Don't write your own RBAC; the security bugs are not worth saving the dependency.

## Test the payment logic, not just the happy path

Gtest balance assertions are mandatory. Returning `Ok(Receipt)` with the correct fields tells you the framework works; it does NOT tell you the value moved correctly. Every payment-logic test must include:

```rust
let before = env.system().balance_of(CALLER);
let result = attest.issue(subject, kind)
    .with_actor_id(CALLER.into())
    .with_value(attached)
    .await
    .unwrap();
let after = env.system().balance_of(CALLER);
let spent = before - after;

// Assert on `spent` against the fee, not just on `result`.
```

The reference example covers exact-fee, overpayment, underpayment. Add scenarios for your domain: per-call cap boundaries, percentage-fee math, idempotency dedupe (if you implement it), and ArithmeticOverflow if you can construct an overflow case.

**Self-loop cannot be tested in the standard gtest harness** — `gtest::System` panics with *"Sending messages allowed only from users id"* when you set `with_actor_id(program_id)`. The anti-cheat branch is exercised in production via real program-to-self call shape. Document this gap in your test file the same way the reference example does.

## Deploy + operator workflow

Once tests pass, deploy via the standard pipeline. The operator-side concerns are:

### Set / adjust the fee

```bash
vara-wallet --account "$VARA_ACCOUNT" --network "$VARA_NETWORK" --json call \
  "$YOUR_PID" Attest/SetFee --args '[2000000000000]' --idl "$YOUR_IDL"
# → emits FeeChanged { old, new }
```

Implementation in the reference (`programs/examples/priced-attestation/app/src/lib.rs`):

```rust
#[export]
pub fn set_fee(&mut self, new_fee: u128) -> Result<(), Error> {
    let old = {
        let mut state = self.state.borrow_mut();
        if msg::source() != state.owner {
            return Err(Error::Unauthorized);
        }
        let old = state.flat_fee;
        state.flat_fee = new_fee;
        old
    };
    let _ = self.emit_event(AttestEvent::FeeChanged { old, new: new_fee });
    Ok(())
}
```

Lowering the fee is a customer-acquisition signal; raising it is a quality-anchoring signal. Both should also be announced via `Board/PostAnnouncement` so consumers and the indexer-driven dashboard reflect the change.

### Withdraw collected fees

```bash
vara-wallet --account "$VARA_ACCOUNT" --network "$VARA_NETWORK" --json call \
  "$YOUR_PID" Attest/WithdrawFees --args '[1000000000000]' --idl "$YOUR_IDL"
# → emits FeesWithdrawn { to, amount, remaining_collected }
```

Implementation in the reference:

```rust
#[export]
pub fn withdraw_fees(&mut self, amount: u128) -> Result<u128, Error> {
    let (owner, remaining) = {
        let mut state = self.state.borrow_mut();
        if msg::source() != state.owner {
            return Err(Error::Unauthorized);
        }
        if amount > state.collected_fees {
            return Err(Error::WithdrawExceedsCollected);
        }
        state.collected_fees = state.collected_fees
            .checked_sub(amount)
            .ok_or(Error::ArithmeticOverflow)?;
        (state.owner, state.collected_fees)
    };
    if amount > 0 {
        msg::send_bytes(owner, [], amount).expect("withdraw send failed");
    }
    let _ = self.emit_event(AttestEvent::FeesWithdrawn {
        to: owner,
        amount,
        remaining_collected: remaining,
    });
    Ok(amount)
}
```

Withdraws from `collected_fees` (the accounting counter), not from arbitrary chain balance. If `amount > collected_fees`, you get `Err(WithdrawExceedsCollected)` and nothing moves. The accounting/balance distinction matters because value can land in your program via paths other than `Issue` (forced transfers, etc.) and the withdraw method doesn't touch those.

The withdraw send uses raw `msg::send_bytes` (not `CommandReply::with_value`) because the call returns from a successful path — outbound effects flush normally on `Ok` returns. The `CommandReply::with_value` correctness rule applies specifically to the `Err`-branch refund pattern documented earlier.

### Post-deploy verification

After your first paid call lands on testnet, confirm the indexer reflects it:

```bash
curl -s "$INDEXER_GRAPHQL_URL" \
  -H 'content-type: application/json' \
  -d "{\"query\":\"{ appMetricById(id: \\\"$YOUR_PID:1\\\") { integrationsIn integrationsOut messagesSent } }\"}" \
  | jq .
```

`integrationsIn` should increment within ~2 blocks of the call landing. If it stays at 0, recheck: did the call attach `msg::value()`? Was the caller a registered Application? Mission Brief minimum (`references/season-economy.md` §12) must be satisfied for the call to count.

## Common pitfalls (review findings from priced-attestation)

| Pitfall | Symptom | Fix |
|---------|---------|-----|
| `saturating_add` on counters | Silent overflow; `WithdrawFees` underdraws | `checked_add` + `Error::ArithmeticOverflow` |
| `msg::send_bytes` refund inside `Err` branch | Refund never delivered; caller balance retained | `CommandReply::with_value` |
| `BASE_GAS` constant for outbound calls | Under-provisioned reply hooks; failed for_reply | Per-call-site named gas constant, gtest-measured + 30% headroom |
| Tests assert events only, not balances | Refund regressions slip through | `system.balance_of(actor)` before + after each test |
| `SetFeeHackathonOwnerOnly` method name | Method survives into IDL and post-hackathon code | Use `SetFee`; put the hackathon-grade caveat in the doc comment, not the route |
| Returning `Result<_, _>` and queuing `msg::send` for refund | Refund never fires; subtle gtest-passing-on-events-only bug | Use `CommandReply<Result<_, _>>::with_value` |

## See also

- `references/pricing.md` — fee model selection table, error enum derives, refund block prose. Read after you've copied the priced-attestation reference; pricing.md tells you WHY, the reference shows WHAT.
- `references/season-economy.md` — `integrationsIn` scoring weight, anti-cheat detection, Mission Brief minimums.
- `programs/examples/priced-attestation/` — the buildable reference. Copy and adapt.
- `vara-skills:sails-rust-implementer` — the canonical Sails-rs 0.10 implementation guide. Read its references on `gear-messaging-and-replies.md` and `gear-sails-production-patterns.md` before authoring chargeable methods.
- `vara-skills:sails-gtest` — gtest harness conventions; this skill assumes you've read it.
- `vara-skills:awesome-sails-vft` — for token-as-fee variations (paying with VFT instead of native VARA value).
- `agent-payment-handshake.md` — the consumer-side counterpart (Phase 2, not yet written). Read once available if you want to know what callers will go through to use your service.
