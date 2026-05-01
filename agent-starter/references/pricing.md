# Pricing Guidance for Sails Programs on Vara

How to set `msg::value()` minimums in agent-built dapps. These are build-time conventions — the network doesn't enforce or check them.

**The question isn't "how much per call?" — it's "what value does the user get?"**

## Gas covers computation. Your fee covers the outcome.

Gas already pays validators for executing your program. Charging users again for the same computation is double-billing. Instead, charge for what the user actually receives:

| The user wants to... | The value is... | Fee model |
|---|---|---|
| Swap tokens | Getting tokens at a fair price | **Percentage of amount** |
| Post a bounty | Getting work done | **Percentage of bounty** |
| Get a random number | A verifiable result | **Flat fee per request** |
| Prove their identity | A cryptographic attestation | **Flat fee per attestation** |
| Register as a member | A permanent on-chain record | **One-time flat fee** |
| Monitor a data feed | Ongoing access to updates | **Subscription (time-based)** |
| Send a chat message | Nothing — it's network utility | **Free** |

This isn't theory. Every successful dapp uses one of these models:

- **Uniswap** charges 0.01%–1% per swap (percentage of value). Not 0.0005 ETH per call.
- **Chainlink oracles** charge per data request (flat fee). Uniform value per use.
- **ENS** charges $5–$640/year for domain registration (time-based subscription).
- **Jupiter** charges 0.06% on position open/close (percentage).
- **Polymarket** keeps most markets free; charges 0.1% taker fee on select markets only.
- **Aave** charges a percentage of borrow amount, not per `borrow()` call.

None of them charge "per state change."

## Two things gas doesn't do

If gas already covers execution, what's left for your fee?

1. **Quality anchoring.** A program that charges 0 signals "toy." A program that charges something — even a trivial amount — signals "this is built to last."
2. **User commitment.** Free services attract noise. A small charge filters out bots and tire-kickers. The user who pays 1 VARA to attest their identity values the attestation.

**At current VARA prices, neither of these is about revenue.** VARA trades at ~$0.00065. You'd need ~1,540 calls at 1 VARA to earn $1. Pricing on Vara today is signaling, not income.

## How to choose a model

Start with the outcome, not the code path:

```
What does the user GET?
    │
    ├─ Value proportional to an amount ──→ Percentage fee (e.g., 0.5% of swap/bounty)
    │
    ├─ Uniform value every time ─────────→ Flat fee per use (e.g., 1 VARA per random number)
    │
    ├─ Ongoing access over time ─────────→ Time-based (e.g., 10 VARA/month subscription)
    │
    ├─ One-time permanent record ────────→ Flat fee, operator-set (e.g., 50 VARA registration)
    │
    └─ Network utility / public good ────→ Free. Let vouchers handle gas.
```

### Percentage-based fee

When the value scales with an amount (swap size, bounty reward, escrow), take a cut:

```rust
const FEE_BASIS_POINTS: u128 = 50; // 0.5%

#[sails(export)]
impl MyService {
    pub fn create_bounty(&mut self, amount: u128, description: String) -> Result<Event, Error> {
        // User sends amount + fee. Fee is proportional to value.
        let fee = amount * FEE_BASIS_POINTS / 10_000;
        if msg::value() < amount + fee {
            return Err(Error::InsufficientPayment);
        }

        // amount goes to the bounty pool, fee stays with the program
        self.bounty_pool += amount;
        self.collected_fees += fee;

        Ok(Event::BountyCreated { amount, description })
    }
}
```

This is the same model Uniswap, Jupiter, and Aave use. The fee scales with usage — heavy users pay more, casual users pay less.

### Flat per-use fee

When every use provides the same value (randomness, attestation, name resolution), charge a fixed amount:

```rust
const ATTESTATION_FEE: u128 = 1_000_000_000_000; // 1 VARA

#[sails(export)]
impl MyService {
    pub fn attest(&mut self, subject: ActorId, claim: String) -> Result<Event, Error> {
        if msg::value() < ATTESTATION_FEE {
            return Err(Error::InsufficientPayment);
        }
        // ... issue attestation ...
    }
}
```

This is the Chainlink model. The value is uniform — a random number is a random number whether you're using it for a game or a lottery.

### Time-based (subscription)

When value is ongoing access, charge per period:

```rust
const MONTHLY_FEE: u128 = 10_000_000_000_000; // 10 VARA
const MS_PER_MONTH: u64 = 30 * 24 * 60 * 60 * 1000; // block_timestamp() is in ms

#[sails(export)]
impl MyService {
    pub fn subscribe(&mut self) -> Result<Event, Error> {
        if msg::value() < MONTHLY_FEE {
            return Err(Error::InsufficientPayment);
        }
        let expiry = exec::block_timestamp() + MS_PER_MONTH;
        self.subscribers.insert(msg::source(), expiry);
        Ok(Event::Subscribed { until: expiry })
    }
}
```

This is the ENS model. Users pay once for a period of access, not per call.

### The anti-spam floor

For services that choose flat fees, 1 VARA is a reasonable floor on Vara:
- It matches the existential deposit — a psychologically clean number
- At $0.00065, it's negligible for real users but non-zero cost for bots
- It's the minimum value `vara-wallet` displays cleanly by default

**Do not charge less than 0.1 VARA.** Below that, the anti-spam effect vanishes and you're just adding complexity for no benefit.

## Implementation patterns

### Value guard (all models)

```rust
#[sails(export)]
impl MyService {
    pub fn do_something(&mut self, amount: u128) -> Result<Event, Error> {
        // Guard: reject calls with insufficient value
        if msg::value() < self.required_fee(amount) {
            return Err(Error::InsufficientPayment);
        }
        // ... actual logic ...
    }
}

impl MyService {
    fn required_fee(&self, amount: u128) -> u128 {
        // Percentage model:
        amount * self.fee_bps / 10_000
        // Or flat:
        // self.flat_fee
    }
}
```

### Refund on error

In Sails, the framework sends the reply from your return value — `Ok(event)` or `Err(error)`. Calling `msg::reply_bytes()` manually inside a `#[sails(export)]` method conflicts with this. The clean pattern: **validate value first, do work second, charge only on success.**

```rust
#[sails(export)]
impl MyService {
    pub fn do_something(&mut self, amount: u128) -> Result<Event, Error> {
        // Step 1: Validate payment
        let fee = self.required_fee(amount);
        if msg::value() < fee {
            return Err(Error::InsufficientPayment);
        }

        // Step 2: Do the work (may fail, but user hasn't been "charged" yet —
        //         just lost gas, same as any failed transaction)
        let result = self.internal_logic(amount)?;

        // Step 3: Collect fee only on success
        self.collected_fees += fee;

        Ok(Event::Done { result })
    }
}
```

This is the Uniswap model: you pay gas for failed transactions, but you only pay the dapp fee when the operation succeeds. Gas vouchers on Vara make this palatable — failed attempts cost almost nothing.

### Making fees configurable

Don't hardcode fees. Let the operator adjust them without redeploying:

```rust
#[sails(export)]
impl MyService {
    pub fn set_fee_bps(&mut self, new_bps: u128) -> Result<(), Error> {
        if msg::source() != self.admin {
            return Err(Error::NotAuthorized);
        }
        self.fee_bps = new_bps;
        Ok(())
    }
}
```

## When to stay free

Some dapps are better without fees:

- **Public goods** — registries, oracles, infrastructure that benefits the whole network
- **Network utilities** — chat relays, discovery services, coordination primitives
- **Early bootstrap** — start free, add fees when you have users who value the service
- **Commodity services** — if ten agents offer the same thing, the market price trends to zero anyway

Gas vouchers make free operation sustainable — your program always has fuel. The decision to charge is about signaling and filtering, not survival.

## Is charging per action a good strategy?

**Sometimes. Not always.** 

Flat per-action pricing works when every action delivers uniform value:
- Randomness oracle: every `get_random()` call returns the same quality of randomness
- Identity attestation: every `attest()` call produces the same kind of proof
- Name resolution: every `resolve()` call returns the same kind of answer

It works poorly when value varies:
- Swaps: a $10 swap and a $10,000 swap pay the same flat fee — unfair to small users
- Bounties: a 10 VARA bounty and a 10,000 VARA bounty pay the same flat fee — leaves money on the table
- Escrow: the fee should scale with the amount held, not the number of `deposit()` calls

**The acid test:** If you'd feel wrong charging the same fee for two very different uses of your dapp, you need a percentage or outcome-based model instead.

## Real numbers

*As of May 2026. Token prices are volatile — check current rates before deciding.*

| Metric | Value |
|---|---|
| VARA price (USD) | ~$0.00065 |
| 1 VARA in plancks | 1,000,000,000,000 |
| 10 VARA in USD | ~$0.0065 |
| 100 VARA in USD | ~$0.065 |
| 1,000 VARA in USD | ~$0.65 |

At these prices: pricing is signaling, not revenue. Unless VARA appreciates or you hit massive scale, your dapp's fees won't pay the rent. That's fine — the point of charging today is to build the habit and the infrastructure for when it matters.
