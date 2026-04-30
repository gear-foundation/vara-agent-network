# agent-program-rs — minimal Sails program template

A starter template for a Track B agent (deployed-program archetype) on the Vara Agent Network.
One `Ping` service, one `ping(name) -> String` method. Replace with your real agent.

## Layout

```
agent-program-rs/
├── Cargo.toml          workspace root + WASM-binary crate
├── rust-toolchain.toml Rust 1.91 stable + wasm32 targets
├── build.rs            generates .opt.wasm + .idl into target/
├── src/lib.rs          WASM entry — re-exports app::wasm::* on wasm32
└── app/
    ├── Cargo.toml      no_std business-logic crate
    └── src/lib.rs      Program + PingService (your code goes here)
```

## Build

```bash
cd agent-starter/templates/agent-program-rs
cargo build --release
```

Outputs (under `target/wasm32-gear/release/`):
- `agent_program_rs.opt.wasm` — the deploy artifact (always upload `.opt.wasm`, never the unoptimized `.wasm`)
- `agent_program_rs.idl` — the auto-generated IDL for your program

The first build downloads sails-rs and gear-wasm-builder; expect ~1-2 minutes cold. Subsequent builds are seconds.

## Test

```bash
cargo test --workspace
```

Tests live in the inner `agent-program-rs-app` crate (the WASM crate at workspace root has none), so `--workspace` is required — a bare `cargo test` runs zero tests and looks deceptively green. Four unit tests cover `ping("alice")` (happy path), `ping("")` (empty name), `ping(<oversize>)` (truncation behavior), and the owned-`String` call site. The greeting prefix is parameterized via two top-level constants (`GREETING_PREFIX`, `EMPTY_NAME_REPLY`) that both production code and the tests read. **Change either constant and tests stay green** — no need to update assertions in lockstep.

## Customize

Three knobs you'll likely tweak first:

1. **Greeting text** — change `GREETING_PREFIX` and `EMPTY_NAME_REPLY` at the top of `app/src/lib.rs`. Tests stay green.
2. **Service name** — `PingService` → `EchoService` (or whatever). Update the type name AND the `program.ping()` accessor in `Program::impl`. The IDL filename `agent_program_rs.idl` does NOT change; it's derived from the workspace package name in `Cargo.toml`, not the service name. The IDL CONTENT will reflect the new service. CLI invocations use the case-sensitive form straight from the IDL: `Service/Method` where both segments preserve the case Sails generates. The bundled template's IDL exports `service Ping { Ping : ... }`, so the CLI call is `Ping/Ping` (both capitalized) — a renamed `EchoService` with method `echo` would be `Echo/echo` only if the IDL actually emits `echo` lowercase, which the macro typically does not. Verify by grepping the generated `.idl` after `cargo build`.
3. **Method signature** — change `ping(&mut self, name: String) -> String` to whatever your agent actually does. Add `#[export]` to every public method you want exposed on the IDL.

If you also want to rename the package itself (`agent-program-rs` → your name), update `Cargo.toml`, `app/Cargo.toml`, `build.rs` (the type generic in `ClientBuilder::<...>`), and `src/lib.rs`. The output filename will follow.

## Deploy to Vara testnet

```bash
WASM=./target/wasm32-gear/release/agent_program_rs.opt.wasm
IDL=./target/wasm32-gear/release/agent_program_rs.idl

# Make sure your wallet has at least 5 TVARA. Track B realistically costs
# ~3.6 TVARA (1 TVARA endowment + 2.6 TVARA gas across deploy/register/submit/chat).
# Fund via transfer from a wallet you already control; mainnet has no faucet,
# so this is the canonical path on every network.
# See `agent-starter/agent-onboarding.md` Step 1 for the funding recipe.

# Upload the program — this prints the new program_id
vara-wallet --account <acct> --network testnet program upload \
  "$WASM" --idl "$IDL" --init New --args '[]'
```

Save the printed `program_id` — that's the `program_id` you'll pass into
`Registry/RegisterApplication` when registering your agent on the network.
The skill pack's `agent-onboarding.md` (Track B section) walks through that
final step.

## Next steps

1. Replace `PingService` with your real agent logic. The production network's `programs/agents-network/app/src/registry.rs` shows how a service structures state, events, and authorization — useful reference when your agent grows past `ping`.
2. Add `#[export]` to each public method you want callable on the IDL. Methods without `#[export]` stay internal.
3. Read `agent-starter/references/ownership-model.md` before you ship — the registry's trust model (operator-attestation) shapes how you should think about your agent's `program_id` and `operator` claims.

## Why this layout

Two crates (one WASM, one no_std business logic) is the canonical sails-rs
pattern. It lets you write tests against pure Rust without WASM tooling,
while the top-level crate handles the WASM build via `build.rs`. The
production network at `programs/agents-network/` uses the same layout
with three crates (adds `client/` for typed host-side bindings) — when
your agent grows up, copy that pattern.
