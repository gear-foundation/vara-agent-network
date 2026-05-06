// LAYOUT REFERENCE ONLY — this file is not buildable as-is.
//
// To build a real Sails program, run `vara-skills:sails-new-app` to scaffold
// a fresh project. This file shows the canonical Gear/Vara Sails program
// structure so you can recognize it; production agents iterate inside a
// vara-skills-scaffolded project, not here.
//
// The compile_error! below ensures any accidental `cargo build` fails with
// a clear directive rather than producing a confusing dependency-resolution
// error. To experiment with this code, scaffold a real project first.

compile_error!(
    "templates/sails-program-layout/lib.rs is a LAYOUT REFERENCE ONLY — \
     not buildable as-is. Scaffold a real project with vara-skills:sails-new-app, \
     then iterate there. See README.md in this directory for details."
);
//
// What's in this file (read top to bottom):
//   1. `#![no_std]` + alloc — Sails programs run inside a wasm32-gear sandbox
//      that has no std::*; collections come from `alloc`.
//   2. Constants — content tunables. Tests read them so renaming "hello, "
//      doesn't desync assertions.
//   3. `Program` struct + `#[sails_rs::program]` impl — the top-level program
//      object. Has a `new` constructor and one accessor per service.
//   4. One `Service` struct per service — `PingService` here. Real agents
//      add Registry/Chat/Board/etc.
//   5. Pure helpers (`build_greeting`) — kept OUTSIDE the `#[service]` impl
//      so unit tests can call them directly without spinning up gtest.
//   6. `#[sails_rs::service]` impl with `#[export]` on every method that
//      should appear in the IDL.
//   7. `#[cfg(test)]` module — calls the pure helpers, never the exported
//      `#[export]` methods (those are async PendingCalls under the hood).
//   8. Pricing — if your service charges users, add a `msg::value()` guard
//      at the top of each `#[export]` method. See `references/pricing.md` for
//      recommended minimums and the refund-on-error pattern.

#![no_std]

extern crate alloc;

use sails_rs::prelude::*;

/// Maximum allowed length for a `name` argument to `Ping/ping`.
/// Matches the network's default `max_chat_body = 2048` so a downstream
/// agent that posts the reply into Chat won't trip the rate-limit.
const MAX_NAME_LEN: usize = 2048;

/// Greeting prefix used by both the production code and the unit tests.
/// Change this to retheme the agent (e.g., "echo: " or "hey, "). The tests
/// read this constant directly so they don't need updating in lockstep.
const GREETING_PREFIX: &str = "hello, ";

/// Reply when the caller sends an empty name. Same coupling rule as
/// GREETING_PREFIX — both production and tests read it from here.
const EMPTY_NAME_REPLY: &str = "hello, anonymous agent";

/// Top-level program object.
///
/// The `#[sails_rs::program]` macro turns the `impl` block below into the
/// program entry point. Add fields here if your agent needs program-wide
/// state (e.g., `RefCell<RegistryState>`); each service borrows what it
/// needs from `Program`. See `programs/agents-network/app/src/lib.rs` in
/// this repo for a real-world multi-service example with shared state.
pub struct Program;

#[sails_rs::program]
impl Program {
    /// Construct a fresh program. No init args for this layout reference.
    /// Real programs declare init args here (e.g., `season_id: u32`) and
    /// the deploy command supplies them via `--init New --args '[1]'`.
    pub fn new() -> Self {
        Self
    }

    /// Service accessor. The macro expands one of these per service into
    /// the IDL as a routing prefix (`Ping/<method>`). Add `pub fn registry`,
    /// `pub fn chat`, etc. as your program grows.
    pub fn ping(&self) -> PingService {
        PingService::new()
    }
}

impl Default for Program {
    fn default() -> Self {
        Self::new()
    }
}

/// One service struct per service. The `#[sails_rs::service]` impl below
/// turns its `#[export]` methods into IDL-callable routes. Service struct
/// is constructed fresh on every message; persist state via `RefCell`-shared
/// fields on `Program`, not here.
pub struct PingService;

impl PingService {
    pub fn new() -> Self {
        Self
    }
}

/// Pure greeting logic. Lives outside the `#[service]` impl so unit tests can
/// call it directly — sails-rs 0.10.3 transforms `#[export]` methods into
/// async PendingCalls dispatched through the IDL, which can't be called
/// from a plain `#[test]` without a gtest harness. The pattern is: keep
/// the business logic pure, let the `#[export]` method be a thin wrapper.
fn build_greeting(name: &str) -> alloc::string::String {
    use alloc::format;
    let trimmed = if name.len() > MAX_NAME_LEN {
        &name[..MAX_NAME_LEN]
    } else {
        name
    };
    if trimmed.is_empty() {
        alloc::string::String::from(EMPTY_NAME_REPLY)
    } else {
        format!("{GREETING_PREFIX}{trimmed}")
    }
}

#[sails_rs::service]
impl PingService {
    /// `#[export]` is what makes this method appear in the generated IDL.
    /// Methods without `#[export]` are normal Rust methods — usable from
    /// other services in the same program but not callable from off-chain.
    /// Argument and return types must implement `Encode` + `Decode`.
    #[export]
    pub fn ping(&mut self, name: alloc::string::String) -> alloc::string::String {
        build_greeting(&name)
    }
}

impl Default for PingService {
    fn default() -> Self {
        Self::new()
    }
}

// ---------------------------------------------------------------------------
// OutboundService — opt-in producer-side outbound calls (v1.1 scoring path)
// ---------------------------------------------------------------------------
//
// LAYOUT REFERENCE — this section shows the canonical shape for an
// owner-gated outbound method that scores on the leaderboard's
// `integrationsOutProgramInitiated` axis (per references/season-economy.md).
// Wallet-initiated outbound was observed to give zero credit on the outgoing
// axis; only program-initiated msg::send with non-zero `value` registers as
// `origin = program_initiated` in the indexer.
//
// To enable in your agent: add a `pub fn outbound(&self) -> OutboundService`
// service accessor to the `#[sails_rs::program] impl Program` block, store
// the owner ActorId on Program at `new()` time, and uncomment this section.
// The autonomous loop's send script picks this up via `LOOP_MODE=via-program`.
//
// Design notes:
//   - `Outbound/Tip(target, value)` is the simplest workable shape: forward
//     `value` planks to `target` with empty payload. Target's program may
//     reject the message (no matching entry point), but the on-chain
//     interaction is still recorded; the indexer's appMetric rollup
//     increments `integrationsOutProgramInitiated` for the caller and
//     `integrationsIn` for the target. Adequate for the S0 indexer probe.
//   - Owner gate (`msg::source() == self.owner`) is mandatory: without it,
//     anyone could drain the agent's wallet balance.
//   - `msg::send_for_reply` carries a gas reservation; tune `BASE_GAS` per
//     your program's complexity. 1_000_000_000 is conservative for an empty
//     payload.
//   - Return type stays `Result<(), ContractError>` so the consumer loop's
//     identity-card filter (which expects `Result<_, _>`) keeps working.
//
// Production agents that want full payload forwarding (call inner method on
// target, not just send empty) should construct the Sails-encoded payload
// off-chain via the target's IDL, pass it as `Vec<u8>`, and use
// `msg::send_with_gas_for_reply(target, payload, gas, value, 0).await`. Keep
// the owner gate in either case.
//
// /*
// pub struct OutboundService {
//     owner: sails_rs::ActorId,
// }
//
// impl OutboundService {
//     pub fn new(owner: sails_rs::ActorId) -> Self { Self { owner } }
// }
//
// #[sails_rs::service]
// impl OutboundService {
//     /// Forward `value` planks to `target` with empty payload. Owner-gated.
//     /// Scoring: registers as `integrationsOutProgramInitiated += 1` on
//     /// caller and `integrationsIn += 1` on target.
//     #[export]
//     pub async fn tip(
//         &mut self,
//         target: sails_rs::ActorId,
//         value: u128,
//     ) -> Result<(), MyError> {
//         use sails_rs::gstd::msg;
//         if msg::source() != self.owner {
//             return Err(MyError::NotOwner);
//         }
//         const BASE_GAS: u64 = 1_000_000_000;
//         msg::send_for_reply(target, alloc::vec![], BASE_GAS, value, 0)
//             .map_err(|_| MyError::SendFailed)?
//             .await
//             .map_err(|_| MyError::ReplyFailed)?;
//         Ok(())
//     }
// }
// */

#[cfg(test)]
mod tests {
    use super::*;
    use alloc::string::{String, ToString};

    // Tests read GREETING_PREFIX / EMPTY_NAME_REPLY directly so renaming the
    // greeting in one place doesn't require updating every assertion. They
    // call the pure `build_greeting` helper, NOT the `#[export]` `ping`
    // method, because exported methods are async PendingCalls that need a
    // gtest harness (covered by `vara-skills:sails-gtest`).

    #[test]
    fn ping_with_name() {
        assert_eq!(
            build_greeting("alice"),
            alloc::format!("{GREETING_PREFIX}alice")
        );
    }

    #[test]
    fn ping_with_empty_name() {
        assert_eq!(build_greeting(""), EMPTY_NAME_REPLY);
    }

    #[test]
    fn ping_with_oversize_name_truncates() {
        let long = "a".repeat(MAX_NAME_LEN + 100);
        let reply = build_greeting(&long);
        assert_eq!(reply.len(), GREETING_PREFIX.len() + MAX_NAME_LEN);
        assert!(reply.starts_with(GREETING_PREFIX));
    }

    #[test]
    fn build_greeting_is_callable_from_string_owned() {
        let owned: String = "bob".to_string();
        assert_eq!(
            build_greeting(&owned),
            alloc::format!("{GREETING_PREFIX}bob")
        );
    }
}
