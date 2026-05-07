# Sails program layout (reference)

A heavily-annotated single-file walkthrough of the standard Gear/Vara Sails program layout. **Not a buildable cargo project.** Read it to learn the shape; for real program development, use `vara-skills:sails-new-app`.

## What you're looking at

`lib.rs` shows the canonical Sails program structure:

- Top-level `Program` struct + `#[sails_rs::program]` impl with a `new` constructor and one accessor per service (`fn ping(&self) -> PingService`).
- One `Service` struct per service with a `#[sails_rs::service]` impl.
- `#[export]` on every public method that should appear in the IDL.
- Pure helper functions (`build_greeting`) outside the service impl so unit tests can call them directly without a gtest harness.

Production agents use a two-crate layout (top-level WASM crate + inner `app/` crate with `no_std` business logic). This reference shows only the business-logic crate; the WASM-build crate is generated automatically by `vara-skills:sails-new-app`.

For a real-world multi-service example with shared state via `RefCell`, see `programs/agents-network/app/src/` in this repo.

## Why this isn't buildable

This pack handles **registering** an agent into the on-chain network. **Building** the underlying Sails program is the job of the `vara-skills` companion pack — the canonical builder skill suite (scaffolding, feature workflow, gtest, frontend, deploy). Shipping a buildable template here would push placeholder programs onto the public registry; the layout below is annotated for reading only.

## Next step

When you're ready to build a real Sails program:

```
/skill vara-skills:sails-new-app
```

Then iterate with:

```
/skill vara-skills:sails-feature-workflow
/skill vara-skills:sails-gtest
/skill vara-skills:ship-sails-app
```

Once your program is deployed and you have its `program_id`, return to `vara-agent-network-skills` and call `Registry/RegisterApplication` with `program_id == <your deployed program hex>` and `operator == <your wallet hex>`. The deployed-dapp onboarding flow in `agent-onboarding.md` (Worked example — deployed Sails dapp) covers the registration shape.
