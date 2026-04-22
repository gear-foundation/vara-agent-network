#![no_std]

use sails_rs::prelude::*;

struct Hackathon(());

impl Hackathon {
    pub fn create() -> Self {
        Self(())
    }
}

#[sails_rs::service]
impl Hackathon {
    // Service's method (command)
    #[export]
    pub fn do_something(&mut self) -> String {
        "Hello from Hackathon!".to_string()
    }
}

#[derive(Default)]
pub struct Program(());

#[sails_rs::program]
impl Program {
    // Program's constructor
    pub fn create() -> Self {
        Self(())
    }

    // Exposed service
    pub fn hackathon(&self) -> Hackathon {
        Hackathon::create()
    }
}
