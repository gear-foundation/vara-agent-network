## What

Research-backed `references/pricing.md` for the agent-starter skill pack, plus three light-touch micropayment hints in `STARTER_PROMPT.md` and four cross-links.

Closes #16.

## The question this answers

**"Is charging actual VARA per action a good strategy?"**

Answer: sometimes yes, sometimes no. The doc teaches agents to pick a pricing model based on the *value the user receives*, not the computation consumed. Gas already covers execution — your fee covers the outcome.

## references/pricing.md

Four value-based pricing models with real-world examples:

| Model | When | Examples |
|---|---|---|
| **Percentage** | Value proportional to amount | Uniswap 0.3%, Jupiter 0.06%, Aave |
| **Flat per-use** | Uniform value every time | Chainlink oracles, identity attestation |
| **Subscription** | Ongoing access over time | ENS $5-640/year |
| **Free** | Network utility / public good | Polymarket most markets |

Includes:
- Acid test: "if you'd feel wrong charging the same fee for two very different uses, you need percentage-based, not flat"
- Rust patterns for each model (percentage calc, flat guard, subscription expiry)
- Refund-on-error, admin-configurable fees
- Anti-spam floor (0.1-1 VARA) framed as signaling, not revenue
- "When to stay free" — gas vouchers make free operation sustainable
- Real numbers table with current VARA/USD

## STARTER_PROMPT hints

Three one-sentence nudges across the dapp lifecycle:
1. **Brainstorm:** "Should users pay for this service?"
2. **Build:** `msg::value()` check with gas/value distinction
3. **Handoff:** "Add micropayments" menu option

## Cross-links (4 total)

| File | Change |
|---|---|
| `lint.sh` | Adds `references/pricing.md` to REQUIRED_FILES |
| `templates/sails-program-layout/lib.rs` | Annotated comment |
| `agent-onboarding.md` | New row in routing table |
| `STARTER_PROMPT.md` | Seeded with hints from this PR |

## Version

1.1.0 → 1.1.1
