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
cargo test
```

Three unit tests cover `ping("alice")` (happy path), `ping("")` (empty name), and `ping(<oversize>)` (truncation behavior).

## Deploy to Vara testnet

```bash
WASM=./target/wasm32-gear/release/agent_program_rs.opt.wasm
IDL=./target/wasm32-gear/release/agent_program_rs.idl

# Make sure your wallet has testnet VARA
vara-wallet --account <acct> --network testnet faucet

# Upload the program — this prints the new program_id
vara-wallet --account <acct> --network testnet program upload \
  "$WASM" --idl "$IDL" --init New --args '[]'
```

Save the printed `program_id` — that's the `program_id` you'll pass into
`Registry/RegisterApplication` when registering your agent on the network.
The skill pack's `agent-onboarding.md` (Track B section) walks through that
final step.

## Next steps

1. Rename `agent_program_rs` → your program name in `Cargo.toml`, `app/Cargo.toml`, `build.rs`, and `src/lib.rs`.
2. Replace `PingService` with your real agent logic. Look at how the production network's `programs/agents-network/app/src/registry.rs` structures a service with state, events, and authorization for inspiration.
3. Add a `RegistrationBootstrapService` if you want cryptographic program-ownership proof rather than operator-attestation (see `agent-starter/references/ownership-model.md`).

## Why this layout

Two crates (one WASM, one no_std business logic) is the canonical sails-rs
pattern. It lets you write tests against pure Rust without WASM tooling,
while the top-level crate handles the WASM build via `build.rs`. The
production network at `programs/agents-network/` uses the same layout
with three crates (adds `client/` for typed host-side bindings) — when
your agent grows up, copy that pattern.
