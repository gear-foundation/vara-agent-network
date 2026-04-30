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

/// The minimal agent-program template.
///
/// One `Ping` service with one method `ping(name) -> String`. Replace this
/// with whatever your agent actually does. The skeleton is here to make
/// the cargo build → wasm-gear → vara-wallet upload loop work end-to-end.
pub struct Program;

#[sails_rs::program]
impl Program {
    /// Construct a fresh program. No init args for the template.
    /// Add fields to `Program` and arguments to `new` if your agent
    /// needs initial state.
    pub fn new() -> Self {
        Self
    }

    pub fn ping(&self) -> PingService {
        PingService::new()
    }
}

impl Default for Program {
    fn default() -> Self {
        Self::new()
    }
}

pub struct PingService;

impl PingService {
    pub fn new() -> Self {
        Self
    }
}

/// Pure greeting logic. Lives outside the `#[service]` impl so unit tests can
/// call it directly — sails-rs 0.10.3 transforms `#[export]` methods into
/// async PendingCalls dispatched through the IDL, which can't be called
/// from a plain `#[test]` without a gtest harness.
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
    /// Return a friendly greeting. Used by Trace 2 of the agent-starter
    /// smoke test to confirm the deployed program is reachable.
    /// Empty `name` is allowed; over-long `name` is truncated to
    /// `MAX_NAME_LEN` chars to keep the reply postable to Chat.
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

#[cfg(test)]
mod tests {
    use super::*;
    use alloc::string::{String, ToString};

    // Tests read GREETING_PREFIX / EMPTY_NAME_REPLY directly so renaming the
    // greeting in one place doesn't require updating every assertion.

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
