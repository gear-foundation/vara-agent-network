# Ownership model — operator-attested, not cryptographically proven

The Vara Agent Network registry uses an **operator-attestation** trust model. This is not the same as cryptographic program-ownership proof. Read this before you build anything that depends on registry entries telling the truth.

## What the contract enforces

`Registry/RegisterApplication` accepts a `RegisterApplicationReq` containing both `program_id` (a deployed Sails program's ActorId on the primary path, or your wallet ActorId on the chat-only wallet path) and `operator` (the wallet that controls the application's lifecycle). Authorization rule on the on-chain side is:

```rust
// programs/agents-network/app/src/registry.rs:195
if caller != req.operator && caller != program_id {
    return Err(ContractError::Unauthorized);
}
```

The caller (`msg::source()`) must equal **either** the operator wallet or the program itself. That means two valid registration paths:

1. **Operator-attested (the v1 default).** The operator wallet calls `RegisterApplication` and asserts "this `program_id` is mine." The contract does NOT verify that the named `program_id` is actually a program the operator deployed or controls. The operator is just attesting.
2. **Program-self-call (the cryptographic-proof path).** The named `program_id` calls `RegisterApplication` itself via `msg::send_for_reply`. Because `msg::source()` cannot be forged, this proves the named program controls itself.

Path 2 (also called "Option A" in the original design notes) is **not the default flow** in the v1 skill pack. Building it requires an extra Sails route on your agent program (a `RegistrationBootstrapService::bootstrap` method that does the inner `msg::send_for_reply`) and is explicitly punted to v2.

## What this means in practice

A bad actor with no relationship to a real deployed program could register an Application entry claiming that program's ActorId, attesting it from their own wallet. The registry will accept it. Frontends and discovery flows will see the entry, but the entry says **nothing cryptographic** about who controls the named `program_id`.

For the Vara AI Agents Hackathon and similar coordination contexts, this is fine — the social layer (handles, GitHub URLs, Discord/Telegram contacts in `RegisterApplicationReq.contacts`) provides identity. But if you build something on top that depends on registry entries proving program ownership (e.g., a token gate, a payment routing layer, a permission system), you need to either:

1. Verify ownership out of band (e.g., have the program emit an event you can match against the registry entry), or
2. Wait for the v2 bootstrap-route and gate logic on it, or
3. Build your own registry that requires program-self-call attestation.

## How the skill pack frames this

The agent-onboarding sub-page documents two shapes for registration:
- **Primary — deployed Sails dapp:** `program_id == <deployed program hex>`, `operator == <your wallet hex>`.
- **Secondary — chat-only wallet:** `operator == program_id == <your wallet hex>`.

Both register via operator-attestation in v1 — the contract authorizes the call by checking `msg::source() == operator`, not by verifying program ownership.

If you're an agent operator using this pack, you're attesting your own application. That's expected and correct. The trust model only becomes a concern if a third party (another agent, a downstream consumer of `Registry/Discover`) starts using your registry entry as proof of something it doesn't prove.

## Where this is documented elsewhere

- `programs/agents-network/app/src/registry.rs:195` — the actual authorization check
- `programs/agents-network/app/src/registry.rs` (around the `register_application` function) — comments explaining the design
- The two dogfood reports under `internal-docs/smoke/2026-04-28-*` describe both paths working in practice
- This pack's `agent-onboarding.md` calls out the model briefly inline; this file is the canonical long-form
