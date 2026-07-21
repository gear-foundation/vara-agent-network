#![no_std]

extern crate alloc;

use sails_rs::cell::RefCell;
use sails_rs::collections::BTreeMap;
use sails_rs::gstd::{exec, msg};
use sails_rs::prelude::*;
// `prog` lives in the underlying gstd crate; sails-rs::gstd only re-exports
// `exec` and `msg`. Pull the program-creation syscalls in directly.
use gstd::prog;

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/// Per-deployer minimum block gap between consecutive successful deploys.
/// Init-time default; admin can adjust via `set_cooldown`.
pub const DEFAULT_COOLDOWN_BLOCKS: u32 = 50;

/// Hard ceiling on the init payload bytes the factory will forward to
/// `create_program`. Keeps factory message-size bounded; any program needing
/// a larger init should chunk via post-deploy SendMessages.
pub const MAX_INIT_PAYLOAD_BYTES: u32 = 64 * 1024;

/// Hard cap on cooldown so admin can't lock the factory indefinitely by
/// fat-fingering a huge value.
pub const MAX_COOLDOWN_BLOCKS: u32 = 14_400; // ≈ 12 h at 3s blocks

/// Hard ceiling on `init_gas_limit` to keep one deployer from monopolising
/// the message-block gas allowance. Vara's per-message gas limit is around
/// 750 B at the time of writing; 100 B is comfortable for any realistic
/// Sails init while leaving headroom for factory's own bookkeeping.
pub const MAX_INIT_GAS_LIMIT: u64 = 100_000_000_000;

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

#[derive(Encode, Decode, TypeInfo, Clone, Debug, PartialEq, Eq)]
#[codec(crate = sails_rs::scale_codec)]
#[scale_info(crate = sails_rs::scale_info)]
pub enum FactoryError {
    /// Caller deployed too recently. `blocks_remaining` is how long until
    /// the next deploy is allowed for this deployer.
    Cooldown { blocks_remaining: u32 },
    /// `init_payload` exceeded `MAX_INIT_PAYLOAD_BYTES`.
    InitPayloadTooLarge,
    /// `init_gas_limit` exceeded `MAX_INIT_GAS_LIMIT` or was zero.
    InitGasLimitInvalid,
    /// `cooldown_blocks` exceeded `MAX_COOLDOWN_BLOCKS`.
    CooldownTooLarge,
    /// Caller is not the admin.
    NotAdmin,
    /// `gstd::prog::create_program` failed (e.g. unknown code_id, salt
    /// produced an existing program, or runtime rejected). Carries a stable
    /// short tag rather than the underlying error string for ABI hygiene.
    CreateProgramFailed,
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

#[derive(Default)]
pub struct FactoryState {
    pub admin: ActorId,
    pub cooldown_blocks: u32,
    pub last_deploy_block: BTreeMap<ActorId, u32>,
    pub total_deploys: u64,
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

#[sails_rs::event]
#[derive(Encode, Decode, TypeInfo, Clone, Debug, PartialEq, Eq)]
#[codec(crate = sails_rs::scale_codec)]
#[scale_info(crate = sails_rs::scale_info)]
pub enum FactoryEvent {
    /// A program was successfully created. Init message is in flight at
    /// emit time; subscribers should watch `program_id` for its init reply
    /// to know whether init succeeded.
    ProgramDeployed {
        deployer: ActorId,
        code_id: CodeId,
        program_id: ActorId,
        init_msg_id: MessageId,
        block: u32,
    },
    /// Admin transferred. Emitted by `transfer_admin`.
    AdminTransferred {
        old_admin: ActorId,
        new_admin: ActorId,
    },
    /// Cooldown updated. Emitted by `set_cooldown`.
    CooldownUpdated { old: u32, new: u32 },
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

pub struct DeployerService<'a> {
    state: &'a RefCell<FactoryState>,
}

impl<'a> DeployerService<'a> {
    pub fn new(state: &'a RefCell<FactoryState>) -> Self {
        Self { state }
    }

    fn ensure_admin(&self) -> Result<(), FactoryError> {
        if msg::source() != self.state.borrow().admin {
            return Err(FactoryError::NotAdmin);
        }
        Ok(())
    }
}

#[sails_rs::service(events = FactoryEvent)]
impl<'a> DeployerService<'a> {
    /// Deploy a new program from a previously uploaded `code_id`.
    ///
    /// The caller (`msg::source()`) is recorded as the logical deployer.
    /// `msg::source()` of the new program's init handler will be this
    /// factory program — agent programs MUST accept their admin/owner
    /// `ActorId` in `init_payload` rather than reading `msg::source()`.
    ///
    /// `user_salt` controls the deterministic program ID — combined with
    /// the deployer's `ActorId`, it forms the salt passed to the runtime.
    /// Two different deployers passing the same `user_salt` get different
    /// program IDs. The same deployer must vary `user_salt` between deploys
    /// of the same code; otherwise the runtime rejects with `CreateProgramFailed`.
    ///
    /// `init_gas_limit` is the gas budget reserved for the new program's
    /// init handler. The default-gas variant (`create_program_bytes_delayed`)
    /// dispatches init with `gas_limit=0`, which makes any non-trivial init
    /// trap immediately — so we always use the explicit-gas variant. Sails
    /// program inits typically need 2-10 billion gas; pass a generous
    /// `init_gas_limit` to avoid out-of-gas at init time. Capped at
    /// `MAX_INIT_GAS_LIMIT`.
    ///
    /// v1: init `value` is hardcoded to 0 — any program needing init value
    /// must wait for v2.
    #[export(unwrap_result)]
    pub fn deploy(
        &mut self,
        code_id: CodeId,
        user_salt: [u8; 16],
        init_payload: Vec<u8>,
        init_gas_limit: u64,
    ) -> Result<ActorId, FactoryError> {
        if init_payload.len() > MAX_INIT_PAYLOAD_BYTES as usize {
            return Err(FactoryError::InitPayloadTooLarge);
        }
        if init_gas_limit == 0 || init_gas_limit > MAX_INIT_GAS_LIMIT {
            return Err(FactoryError::InitGasLimitInvalid);
        }

        let deployer = msg::source();
        let now = exec::block_height();

        // Cooldown: bookkeeping checked + updated atomically before the
        // create_program syscall so a runtime rejection still consumes
        // the deployer's cooldown slot. This is intentional — without it,
        // a cheap revert path (bad code_id, salt collision) could be used
        // to bypass the per-deployer rate limit by burning the factory's
        // gas without tripping the cooldown.
        {
            let mut state = self.state.borrow_mut();
            if let Some(&last) = state.last_deploy_block.get(&deployer) {
                let elapsed = now.saturating_sub(last);
                if elapsed < state.cooldown_blocks {
                    return Err(FactoryError::Cooldown {
                        blocks_remaining: state.cooldown_blocks - elapsed,
                    });
                }
            }
            state.last_deploy_block.insert(deployer, now);
            state.total_deploys = state.total_deploys.saturating_add(1);
        }

        // Salt = deployer.0 (32 bytes) || user_salt (16 bytes). Predictable
        // program ID for clients (no in-program nonce). Same deployer +
        // same user_salt + same code_id → same program_id, which the
        // runtime rejects on second attempt. That's the user's
        // responsibility to vary.
        let mut salt = [0u8; 48];
        let deployer_bytes: [u8; 32] = deployer.into();
        salt[..32].copy_from_slice(&deployer_bytes);
        salt[32..].copy_from_slice(&user_salt);

        // Fire-and-forget: dispatch init message with an explicit gas
        // budget, return immediately with the new program_id. The
        // non-`_with_gas` variant dispatches init at `gas_limit=0`, which
        // traps the new program before its init handler can run a single
        // instruction — so we always go through the explicit-gas path.
        let (init_msg_id, program_id) = prog::create_program_bytes_with_gas_delayed(
            code_id,
            salt,
            init_payload,
            init_gas_limit,
            0,
            0,
        )
        .map_err(|_| FactoryError::CreateProgramFailed)?;

        self.emit_event(FactoryEvent::ProgramDeployed {
            deployer,
            code_id,
            program_id,
            init_msg_id,
            block: now,
        })
        .expect("emit ProgramDeployed failed");

        Ok(program_id)
    }

    /// Set the per-deployer cooldown in blocks. Admin only.
    #[export(unwrap_result)]
    pub fn set_cooldown(&mut self, blocks: u32) -> Result<(), FactoryError> {
        self.ensure_admin()?;
        if blocks > MAX_COOLDOWN_BLOCKS {
            return Err(FactoryError::CooldownTooLarge);
        }

        let old = {
            let mut state = self.state.borrow_mut();
            let old = state.cooldown_blocks;
            state.cooldown_blocks = blocks;
            old
        };

        self.emit_event(FactoryEvent::CooldownUpdated { old, new: blocks })
            .expect("emit CooldownUpdated failed");
        Ok(())
    }

    /// Transfer admin rights. Admin only.
    #[export(unwrap_result)]
    pub fn transfer_admin(&mut self, new_admin: ActorId) -> Result<(), FactoryError> {
        self.ensure_admin()?;

        let old_admin = {
            let mut state = self.state.borrow_mut();
            let old = state.admin;
            state.admin = new_admin;
            old
        };

        self.emit_event(FactoryEvent::AdminTransferred {
            old_admin,
            new_admin,
        })
        .expect("emit AdminTransferred failed");
        Ok(())
    }

    // -- queries (read-only) -------------------------------------------------

    #[export]
    pub fn admin(&self) -> ActorId {
        self.state.borrow().admin
    }

    #[export]
    pub fn cooldown(&self) -> u32 {
        self.state.borrow().cooldown_blocks
    }

    #[export]
    pub fn total_deploys(&self) -> u64 {
        self.state.borrow().total_deploys
    }

    #[export]
    pub fn last_deploy_block(&self, deployer: ActorId) -> Option<u32> {
        self.state.borrow().last_deploy_block.get(&deployer).copied()
    }

    /// First block at which `deployer` may deploy again. If the deployer
    /// has never deployed, returns 0.
    #[export]
    pub fn next_eligible_block(&self, deployer: ActorId) -> u32 {
        let state = self.state.borrow();
        match state.last_deploy_block.get(&deployer) {
            Some(&last) => last.saturating_add(state.cooldown_blocks),
            None => 0,
        }
    }
}

// ---------------------------------------------------------------------------
// Program
// ---------------------------------------------------------------------------

pub struct Program {
    state: RefCell<FactoryState>,
}

#[sails_rs::program]
impl Program {
    /// `admin` controls cooldown updates and admin transfer. If
    /// `cooldown_blocks` is `None`, `DEFAULT_COOLDOWN_BLOCKS` is used.
    pub fn new(admin: ActorId, cooldown_blocks: Option<u32>) -> Self {
        Self {
            state: RefCell::new(FactoryState {
                admin,
                cooldown_blocks: cooldown_blocks
                    .unwrap_or(DEFAULT_COOLDOWN_BLOCKS)
                    .min(MAX_COOLDOWN_BLOCKS),
                last_deploy_block: BTreeMap::new(),
                total_deploys: 0,
            }),
        }
    }

    pub fn deployer(&self) -> DeployerService<'_> {
        DeployerService::new(&self.state)
    }
}
