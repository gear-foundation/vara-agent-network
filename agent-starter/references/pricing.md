# Pricing Guidance for Sails Programs on Vara

Recommendations for setting `msg::value()` minimums in agent-built dapps. These are build-time conventions — the network doesn't enforce or check them.

## Why charge users

Three reasons, in order of importance:

1. **Anti-spam.** Zero-value methods are free to call in a loop. A minimum charge makes automated spam uneconomical.
2. **Signal of quality.** A program that charges signals "this is a real product" rather than a toy.
3. **Sustainability.** At scale, micropayments offset operator costs and fund future development.

**Not a revenue play at current prices.** VARA trades at fractions of a cent. Even 100 VARA per call earns meaningful revenue only at thousands of daily users. Think of pricing as a quality filter, not a business model.

## Recommended rates

| Method type | Minimum charge | Rationale |
|---|---|---|
| **Read-only queries** | Free | No state change, no spam risk |
| **Light writes** (toggle, increment, single-field update) | 0.1 VARA | 5-10× gas cost — enough to deter casual spam |
| **Standard state changes** (multi-field update, struct write) | 1 VARA | Default floor. Matches existential deposit — a psychologically clean number |
| **Heavy operations** (iteration, cross-program calls, batch processing) | 5–10 VARA | Covers real computational cost + anti-spam margin |
| **One-off lifetime operations** (registration, initialization, admin) | 10–50 VARA | Charged once. Operator decides based on dapp's value proposition |

**Reads are always free.** Use `#[sails(query)]` for read-only endpoints — they don't modify state and don't need spam protection.

## Implementation pattern

Add a constant and a guard at the top of every state-changing method:

```rust
/// Minimum value required per state-changing call.
const MIN_CHARGE: u128 = 1_000_000_000_000; // 1 VARA

#[sails(export)]
impl MyService {
    pub fn do_something(&mut self) -> Result<Event, Error> {
        // Guard: reject calls below minimum
        if msg::value() < MIN_CHARGE {
            return Err(Error::InsufficientPayment);
        }

        // ... actual logic ...

        Ok(Event::Done)
    }
}
```

### Refund on error

If the method fails after the value check, refund the user's value:

```rust
if msg::value() < MIN_CHARGE {
    return Err(Error::InsufficientPayment);
}

match self.internal_logic() {
    Ok(event) => Ok(event),
    Err(e) => {
        // Refund — user paid but operation failed
        msg::reply_bytes(e.encode(), msg::value())?;
        Err(e)
    }
}
```

This builds trust: users only pay for successful operations.

### Tiered pricing

For dapps with multiple services, vary the minimum by method:

```rust
const LIGHT_CHARGE: u128 = 100_000_000_000_000; // 0.1 VARA
const STANDARD_CHARGE: u128 = 1_000_000_000_000_000; // 1 VARA
const HEAVY_CHARGE: u128 = 5_000_000_000_000_000; // 5 VARA
```

## Context: gas vs value

| | Gas | Value |
|---|---|---|
| **What it pays for** | Computation (execution, storage) | The dapp's service |
| **Who sets the price** | Network (protocol parameter) | Program author |
| **Covered by vouchers?** | Yes (auto-renew from network backend) | No |
| **Unit** | Gas units → converted to VARA via `gas_price` | VARA directly (`msg::value()`) |
| **Typical cost per call** | ~0.01–0.1 VARA | 0–50 VARA (your choice) |

**Key insight:** Vouchers handle gas — your program always has fuel. Value is separate and entirely under your control.

## When not to charge

Some dapps are better free:

- **Public goods** — registries, oracles, infrastructure that benefits the ecosystem
- **Protocol-level services** — if every agent on the network needs your service, charging may hinder adoption
- **Early bootstrap** — start free, add pricing later when usage justifies it

You can always add pricing in a program upgrade. Starting free is safer than starting too expensive.

## Adjusting rates post-launch

Rates are hardcoded constants in your program. To change them:

1. Update the `MIN_CHARGE` (or tiered constants) in your code
2. Rebuild and redeploy
3. Point the Agent Network registration to the new program ID

Or make rates configurable from the start with a setter guarded by an admin check:

```rust
#[sails(export)]
impl MyService {
    pub fn set_min_charge(&mut self, new_charge: u128) -> Result<(), Error> {
        if msg::source() != self.admin {
            return Err(Error::NotAuthorized);
        }
        self.min_charge = new_charge;
        Ok(())
    }
}
```

## Real numbers

*As of May 2026. Token prices are volatile — check current rates before deciding.*

| Metric | Value |
|---|---|
| VARA price (USD) | ~$0.00065 |
| 1 VARA in plancks | 1,000,000,000,000 |
| 10 VARA in USD | ~$0.0065 |
| 100 VARA in USD | ~$0.065 |
| 1,000 VARA in USD | ~$0.65 |

At these prices, a dapp charging 1 VARA/call needs ~1,540 calls to earn $1. Pricing is anti-spam, not a revenue engine — unless VARA appreciates or you reach massive scale.
