use crate::registry::RegistryState;
use crate::types::{AppStatus, Config, ContractError};
use sails_rs::cell::RefCell;
use sails_rs::gstd::msg;
use sails_rs::prelude::*;

pub const MAX_REASONABLE_MENTION_INBOX_CAP: u32 = 1_000;
pub const MAX_REASONABLE_ANNOUNCEMENTS_PER_APP: u32 = 100;
pub const MAX_REASONABLE_MENTIONS_PER_POST: u32 = 64;

#[derive(Default)]
pub struct AdminState {
    pub admin: ActorId,
    pub config: Config,
}

#[sails_rs::event]
#[derive(Encode, Decode, TypeInfo, Clone, Debug, PartialEq, Eq)]
#[codec(crate = sails_rs::scale_codec)]
#[scale_info(crate = sails_rs::scale_info)]
pub enum AdminEvent {
    AdminTransferred {
        old_admin: ActorId,
        new_admin: ActorId,
        season_id: u32,
    },
    ConfigUpdated {
        admin: ActorId,
        config: Config,
        season_id: u32,
    },
    Paused {
        admin: ActorId,
        season_id: u32,
    },
    Unpaused {
        admin: ActorId,
        season_id: u32,
    },
    ApplicationStatusChanged {
        admin: ActorId,
        program_id: ActorId,
        old_status: AppStatus,
        new_status: AppStatus,
        season_id: u32,
    },
}

pub struct AdminService<'a> {
    admin: &'a RefCell<AdminState>,
    registry: &'a RefCell<RegistryState>,
    current_season: u32,
}

impl<'a> AdminService<'a> {
    pub fn new(
        admin: &'a RefCell<AdminState>,
        registry: &'a RefCell<RegistryState>,
        current_season: u32,
    ) -> Self {
        Self {
            admin,
            registry,
            current_season,
        }
    }

    fn ensure_admin(&self) -> Result<(), ContractError> {
        if msg::source() != self.admin.borrow().admin {
            return Err(ContractError::NotAdmin);
        }
        Ok(())
    }
}

#[sails_rs::service(events = AdminEvent)]
impl<'a> AdminService<'a> {
    #[export]
    pub fn get_admin(&self) -> ActorId {
        self.admin.borrow().admin
    }

    #[export]
    pub fn get_config(&self) -> Config {
        self.admin.borrow().config.clone()
    }

    #[export(unwrap_result)]
    pub fn transfer_admin(&mut self, new_admin: ActorId) -> Result<(), ContractError> {
        self.ensure_admin()?;
        let old_admin = {
            let mut admin = self.admin.borrow_mut();
            let old_admin = admin.admin;
            admin.admin = new_admin;
            old_admin
        };

        self.emit_event(AdminEvent::AdminTransferred {
            old_admin,
            new_admin,
            season_id: self.current_season,
        })
        .expect("emit AdminTransferred failed");

        Ok(())
    }

    #[export(unwrap_result)]
    pub fn update_config(&mut self, new_config: Config) -> Result<(), ContractError> {
        self.ensure_admin()?;
        validate_config(&new_config)?;
        let admin_id = self.admin.borrow().admin;

        {
            let mut admin = self.admin.borrow_mut();
            admin.config = new_config.clone();
        }

        self.emit_event(AdminEvent::ConfigUpdated {
            admin: admin_id,
            config: new_config,
            season_id: self.current_season,
        })
        .expect("emit ConfigUpdated failed");

        Ok(())
    }

    #[export(unwrap_result)]
    pub fn pause(&mut self) -> Result<(), ContractError> {
        self.ensure_admin()?;
        let admin_id = self.admin.borrow().admin;
        self.admin.borrow_mut().config.paused = true;
        self.emit_event(AdminEvent::Paused {
            admin: admin_id,
            season_id: self.current_season,
        })
        .expect("emit Paused failed");
        Ok(())
    }

    #[export(unwrap_result)]
    pub fn unpause(&mut self) -> Result<(), ContractError> {
        self.ensure_admin()?;
        let admin_id = self.admin.borrow().admin;
        self.admin.borrow_mut().config.paused = false;
        self.emit_event(AdminEvent::Unpaused {
            admin: admin_id,
            season_id: self.current_season,
        })
        .expect("emit Unpaused failed");
        Ok(())
    }

    #[export(unwrap_result)]
    pub fn set_application_status(
        &mut self,
        program_id: ActorId,
        new_status: AppStatus,
    ) -> Result<(), ContractError> {
        self.ensure_admin()?;
        let admin_id = self.admin.borrow().admin;
        let old_status = {
            let mut registry = self.registry.borrow_mut();
            let app = registry
                .applications
                .get_mut(&program_id)
                .ok_or(ContractError::UnknownApplication)?;
            let old_status = app.status;
            app.status = new_status;
            old_status
        };

        self.emit_event(AdminEvent::ApplicationStatusChanged {
            admin: admin_id,
            program_id,
            old_status,
            new_status,
            season_id: self.current_season,
        })
        .expect("emit ApplicationStatusChanged failed");

        Ok(())
    }
}

pub fn validate_config(config: &Config) -> Result<(), ContractError> {
    if config.mention_inbox_cap == 0
        || config.max_announcements_per_app == 0
        || config.max_mentions_per_post > MAX_REASONABLE_MENTIONS_PER_POST
        || config.mention_inbox_cap > MAX_REASONABLE_MENTION_INBOX_CAP
        || config.max_announcements_per_app > MAX_REASONABLE_ANNOUNCEMENTS_PER_APP
    {
        return Err(ContractError::ConfigInvalid);
    }

    Ok(())
}
