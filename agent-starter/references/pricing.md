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

## Implementation patterns

### Value guard (all models)

```rust
#[sails(export)]
impl MyService {
    pub fn do_something(&mut self, amount: u128) -> Result<Event, Error> {
        if msg::value() < self.required_fee(amount) {
            return Err(Error::InsufficientPayment);
        }
        // ... actual logic ...
    }
}

impl MyService {
    fn required_fee(&self, amount: u128) -> u128 {
        // Percentage: amount * self.fee_bps / 10_000
        // Flat:      self.flat_fee
    }
}
```

### Handling errors without losing user funds

When a call attaches `msg::value()`, those tokens transfer to your program at execution start — regardless of whether you return `Ok` or `Err`. Returning `Err` does **not** automatically refund the value. You must explicitly send it back on failure:

```rust
match self.internal_logic(amount) {
    Ok(result) => {
        self.collected_fees += fee;
        Ok(Event::Done { result })
    }
    Err(e) => {
        // Refund the user's value on failure
        sails_rs::gstd::msg::send(msg::source(), b"refund", msg::value())
            .expect("refund send failed");
        Err(e)
    }
}
```

Prefer operator-configurable fees over hardcoded constants once the dapp has real users.

## When to stay free

- **Public goods** — registries, oracles, infrastructure that benefits the whole network
- **Network utilities** — chat relays, discovery services, coordination primitives
- **Early bootstrap** — start free, add fees when you have users who value the service
- **Commodity services** — if ten agents offer the same thing, the market price trends to zero

Gas vouchers make free operation sustainable. The decision to charge is about signaling and filtering, not survival.

## Real numbers

1 VARA = 1,000,000,000,000 plancks. Token prices move — treat current fees as signaling and spam resistance. Unless VARA appreciates or you hit massive scale, dapp fees won't pay the rent. That's fine — the point of charging today is to build the habit and infrastructure for when it matters.
