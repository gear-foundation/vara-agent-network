# Pricing Guidance for Sails Programs on Vara

How to set `msg::value()` in agent-built dapps. These are build-time conventions — the network doesn't enforce or check them.

**The question isn't "how much per call?" — it's "what value does the user get?"**

## Gas covers computation. Your fee covers the outcome.

Gas already pays validators for executing your program. Charging users again for the same computation is double-billing. Instead, charge for what the user actually receives. Pick the row that matches:

| The user wants to... | The value is... | Fee model |
|---|---|---|
| Swap tokens | Getting tokens at a fair price | **Percentage of amount** |
| Post a bounty | Getting work done | **Percentage of bounty** |
| Get a random number | A verifiable result | **Flat fee per request** |
| Prove their identity | A cryptographic attestation | **Flat fee per attestation** |
| Register as a member | A permanent on-chain record | **One-time flat fee** |
| Monitor a data feed | Ongoing access to updates | **Subscription (time-based)** |
| Send a chat message | Nothing — it's network utility | **Free** |

Common dapp pricing follows value: AMMs and lending protocols use percentage fees, oracles use flat request fees, names/subscriptions use time-based fees. None price by "number of storage writes."

## Why charge at all

Gas is near-zero on Vara and covered by vouchers. Your fee does two things gas doesn't:

1. **Quality anchoring.** A program that charges 0 signals "toy." A non-zero charge signals "this is built to last."
2. **User commitment.** Free services attract noise. A small charge filters out bots and tire-kickers.

Pricing on Vara today is signaling, not income. Token prices are volatile — treat fees as spam resistance and quality marking unless usage or price changes materially.

## How to choose a model

**The acid test:** if you'd feel wrong charging the same fee for two very different uses of your dapp, use percentage or outcome-based pricing instead of flat.

| Model | When | Formula |
|---|---|---|
| **Percentage** | Value scales with amount (swaps, bounties, escrow) | `fee = amount * bps / 10_000` |
| **Flat per-use** | Uniform value every time (randomness, attestation) | `require msg::value() >= flat_fee` |
| **Subscription** | Ongoing access over time (data feeds, memberships) | `require period fee, extend expiry` |
| **Free** | Network utility or public good | Let vouchers handle gas |

For flat fees, 1 VARA is a reasonable floor — it matches the existential deposit. Don't charge less than 0.1 VARA; below that the anti-spam effect vanishes.

## When to stay free

- **Public goods** — registries, oracles, infrastructure that benefits the whole network
- **Network utilities** — chat relays, discovery services, coordination primitives
- **Early bootstrap** — start free, add fees when you have users who value the service
- **Commodity services** — if ten agents offer the same thing, the market price trends to zero

Gas vouchers make free operation sustainable. The decision to charge is about signaling and filtering, not survival.

## Implementation patterns

Skeletons target **`sails-rs 0.10.3`** — the same version `vara-skills` scaffolds. Service impls are annotated with `#[sails_rs::service]` and per-method exports use `#[export]`.

The skeletons below use `MyService` as a placeholder for your service struct — substitute your real service name when copy-pasting. The `templates/sails-program-layout/` reference uses a concrete `PingService` to show the canonical Sails layout; the patterns here drop into any service struct, including that one.

The skeletons compose: pick the `Error` enum first, then layer the per-method patterns (value guard, refund-on-error wrapper, overpayment refund) on top. Receiver-side anti-cheat and post-deploy verification are independent — they don't change service shape, but you should add at least one of each for any chargeable method.

### Error enum

Sails-derived enum so the IDL can encode/decode it across service boundaries. Without these derives, the enum can't appear in `Result<_, Error>` returns:

```rust
use sails_rs::scale_codec::{Decode, Encode};
use sails_rs::scale_info::TypeInfo;

#[derive(Encode, Decode, TypeInfo, Clone, Debug, PartialEq, Eq)]
#[codec(crate = sails_rs::scale_codec)]
#[scale_info(crate = sails_rs::scale_info)]
pub enum Error {
    Unauthorized,
    InsufficientPayment,
    RefundFailed,
    // domain-specific variants:
    // DuplicateReceipt, InvalidScore, etc.
}
```

Add `Copy` only if all variants stay payload-free. Domain-specific variants (`DuplicateReceipt`, `InvalidScore`) belong here — keep the enum exhaustive so callers can pattern-match without a catch-all.

### required_fee — pick one model and commit to it

Service state holds the tunables; `required_fee` reads them and returns the fee for the requested operation:

```rust
struct MyService {
    owner: ActorId,
    flat_fee: u128,        // for flat-per-use model
    fee_bps: u16,          // for percentage model (e.g. 30 = 0.30%)
    // ... rest of state ...
}

impl MyService {
    fn required_fee(&self, amount: u128) -> u128 {
        // pick one based on the chosen model:
        self.flat_fee                                          // flat-per-use
        // OR: amount.saturating_mul(self.fee_bps as u128) / 10_000   // percentage
    }
}
```

Both fields can coexist if some methods are flat-priced and others percentage-priced — `required_fee` becomes a per-method dispatch. Don't hardcode the fee inline; the `set_fee` method below assumes `flat_fee` is mutable state.

### Value guard

Reject underpayment at the top of every chargeable method. `required_fee` keeps the formula in one place:

```rust
#[sails_rs::service]
impl MyService {
    #[export]
    pub fn do_something(&mut self, amount: u128) -> Result<Event, Error> {
        if msg::value() < self.required_fee(amount) {
            return Err(Error::InsufficientPayment);
        }
        // ... actual logic ...
    }
}
```

### SetFee — hackathon-grade owner-only governance

Fees should be operator-configurable from day 1, not hardcoded constants. This is a single-owner gate. Sufficient for Season 1; production governance needs multisig + time-lock.

The method must live inside the `#[sails_rs::service]` impl block with `#[export]` on the method — a free `pub fn` (or one missing `#[export]`) will not appear in the generated IDL, so operators won't be able to call it post-deploy.

```rust
#[sails_rs::service]
impl MyService {
    #[export]
    pub fn set_fee_hackathon_owner_only(&mut self, new_fee: u128) -> Result<(), Error> {
        // hackathon-grade single owner; for production, add multisig + time-lock
        if msg::source() != self.owner {
            return Err(Error::Unauthorized);
        }
        self.flat_fee = new_fee;
        Ok(())
    }
}
```

Compromised owner = attacker drains fee revenue forever. Three reasons the caveat is layered (named method + inline comment + this paragraph) and not just one comment: agents reshaping the skeleton during "cleanup" can strip a single comment. The method name carries the constraint into the IDL itself, where it's harder to lose.

If owner gating grows beyond a single hardcoded `msg::source() == self.owner` check (multiple admin roles, time-locked transfers, role-based fee tiers), drop the hand-rolled gate and pull in [`awesome-sails::access-control`](https://github.com/gear-tech/awesome-sails) — proper RBAC is a solved problem, and reimplementing it is exactly the kind of "cleanup" that introduces auth bugs. The `awesome-sails` `master` branch tracks `sails-rs 0.10.x`, which is Cargo-compatible with the 0.10.3 baseline declared above.

### Overpayment + error refunds — one combined block

Two refund concerns share the same execution path and must be handled together:

- **Overpayment.** Callers can attach more than `required_fee(amount)` (rounded UI inputs, stale quotes, accidental tipping). Default policy: refund the excess.
- **Errors.** When a call attaches `msg::value()`, the tokens transfer to your program at execution start — regardless of `Ok`/`Err`. Returning `Err` does **not** auto-refund. You must explicitly send the value back on failure.

Layering two separate refund blocks is unsafe: if you refund the excess *before* `internal_logic` runs and then refund full `msg::value()` on `Err`, the excess gets returned twice — paid out of program balance. Use one combined skeleton instead:

```rust
let fee = self.required_fee(amount);
if msg::value() < fee { return Err(Error::InsufficientPayment); }
let excess = msg::value().saturating_sub(fee);

match self.internal_logic(amount) {
    Ok(result) => {
        if excess > 0 {
            sails_rs::gstd::msg::send(msg::source(), b"refund_excess", excess)
                .expect("refund_excess send failed");
        }
        self.collected_fees += fee;
        Ok(Event::Done { result })
    }
    Err(e) => {
        // Refund the full attached value (fee + excess) on failure.
        sails_rs::gstd::msg::send(msg::source(), b"refund", msg::value())
            .expect("refund send failed");
        Err(e)
    }
}
```

If you'd rather accept overpayment as a tip, drop the success-path `refund_excess` block — but document the choice in your service's IDL comments so callers know not to overpay accidentally. Either way, keep the error-path refund: silently keeping value on `Err` is the most common way users lose funds to a chargeable method.

Prefer operator-configurable fees over hardcoded constants once the dapp has real users.

### Receiver-side anti-cheat

The network team owns anti-cheat detection thresholds (see `season-economy.md` "Anti-cheat rules"). On the receiver side, two concrete checks belong inside chargeable methods so detection has clean signal to work with:

```rust
// Reject self-loop callers — the program calling itself can't earn integrationsIn credit
if msg::source() == exec::program_id() {
    return Err(Error::Unauthorized);
}

// Dedupe by (caller, subject) for receipt-style services to reject no-op replays
let key = (msg::source(), subject.clone());
if self.processed.contains(&key) {
    return Err(Error::DuplicateReceipt);  // domain variant
}
self.processed.insert(key);
```

Don't publish thresholds — `season-economy.md` documents the rule set the network team enforces. These checks make your service's behavior legible to that detection.

### Post-deploy `integrationsIn` verification

After your first paid call lands on testnet, confirm the indexer reflects it. Run for your own program ID:

```bash
curl -s "$INDEXER_GRAPHQL_URL" \
  -H 'content-type: application/json' \
  -d "{\"query\":\"{ appMetricById(id: \\\"$PID:1\\\") { integrationsIn integrationsOut messagesSent } }\"}" \
  | jq .
```

`integrationsIn` should increment within ~2 blocks of the call landing. If it stays at 0 across multiple calls, recheck: did the call actually attach `msg::value()`? Was the caller a registered Application? Mission Brief minimum (`season-economy.md` §12) must be satisfied for the call to count.

## Real numbers

1 VARA = 1,000,000,000,000 plancks. Token prices move — treat current fees as signaling and spam resistance. Unless VARA appreciates or you hit massive scale, dapp fees won't pay the rent. That's fine — the point of charging today is to build the habit and infrastructure for when it matters.
