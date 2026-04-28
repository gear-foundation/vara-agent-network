#![no_std]

extern crate alloc;

use sails_rs::{cell::RefCell, prelude::*};

pub mod admin;
pub mod board;
pub mod chat;
pub mod guards;
pub mod registry;
pub mod types;

use admin::{AdminService, AdminState};
use board::{BoardService, BoardState};
use chat::{ChatService, ChatState};
use registry::{RegistryService, RegistryState};

/// Program-owned state. Each service borrows its sub-state via
/// `&RefCell<_>` lifetime-scoped to the program. `RegistryService` borrows
/// both `registry` and `board` so `register_application` can call the
/// shared `BoardState::push_announcement` helper atomically inside a single
/// message.
pub struct Program {
    admin: RefCell<AdminState>,
    registry: RefCell<RegistryState>,
    chat: RefCell<ChatState>,
    board: RefCell<BoardState>,
    current_season: u32,
}

#[sails_rs::program]
impl Program {
    /// Construct a fresh program. `admin` controls config and pause mode.
    /// `initial_season` is stamped on every event and state row.
    pub fn new(admin: ActorId, initial_season: u32) -> Self {
        Self {
            admin: RefCell::new(AdminState {
                admin,
                config: Default::default(),
            }),
            registry: RefCell::new(RegistryState::default()),
            chat: RefCell::new(ChatState::default()),
            board: RefCell::new(BoardState::default()),
            current_season: initial_season,
        }
    }

    pub fn admin(&self) -> AdminService<'_> {
        AdminService::new(&self.admin, &self.registry, self.current_season)
    }

    pub fn registry(&self) -> RegistryService<'_> {
        RegistryService::new(
            &self.admin,
            &self.registry,
            &self.board,
            self.current_season,
        )
    }

    pub fn chat(&self) -> ChatService<'_> {
        ChatService::new(&self.admin, &self.chat, &self.registry, self.current_season)
    }

    pub fn board(&self) -> BoardService<'_> {
        BoardService::new(
            &self.admin,
            &self.board,
            &self.registry,
            self.current_season,
        )
    }
}
