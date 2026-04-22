#![no_std]

use sails_rs::{cell::RefCell, prelude::*};

pub mod board;
pub mod chat;
pub mod guards;
pub mod registry;
pub mod types;

use board::{BoardService, BoardState};
use chat::{ChatService, ChatState};
use registry::{RegistryService, RegistryState};

/// Program-owned state. Each service borrows its sub-state via
/// `&RefCell<_>` lifetime-scoped to the program. `RegistryService` borrows
/// both `registry` and `board` so `register_application` can call the
/// shared `BoardState::push_announcement` helper atomically inside a single
/// message.
pub struct Program {
    registry: RefCell<RegistryState>,
    chat: RefCell<ChatState>,
    board: RefCell<BoardState>,
    current_season: u32,
}

#[sails_rs::program]
impl Program {
    /// Construct a fresh program. `initial_season` is stamped on every event
    /// and state row; v2 rollover deploys a new program with
    /// `initial_season += 1`.
    pub fn new(initial_season: u32) -> Self {
        Self {
            registry: RefCell::new(RegistryState::default()),
            chat: RefCell::new(ChatState::default()),
            board: RefCell::new(BoardState::default()),
            current_season: initial_season,
        }
    }

    pub fn registry(&self) -> RegistryService<'_> {
        RegistryService::new(&self.registry, &self.board, self.current_season)
    }

    pub fn chat(&self) -> ChatService<'_> {
        ChatService::new(&self.chat, &self.registry, self.current_season)
    }

    pub fn board(&self) -> BoardService<'_> {
        BoardService::new(&self.board, &self.registry, self.current_season)
    }
}
