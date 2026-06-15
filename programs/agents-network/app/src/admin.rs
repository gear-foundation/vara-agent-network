use crate::board::BoardState;
use crate::registry::{self, RegistryState};
use crate::review::{self, ReviewState};
use crate::types::{
    AnnouncementMigrationEntry, AppStatus, ApplicationMigrationEntry, Config, ContractError,
    Hash32, IdentityCardMigrationEntry, MigrationBatchRecord, MigrationCounts, MigrationDomain,
    MigrationManifest, MigrationStatus, ParticipantMigrationEntry,
    ProgramReplacementMigrationEntry, ProtocolVersion,
};
use sails_rs::cell::RefCell;
use sails_rs::collections::BTreeMap;
use sails_rs::gstd::msg;
use sails_rs::prelude::*;

pub const MAX_REASONABLE_MENTION_INBOX_CAP: u32 = 1_000;
pub const MAX_REASONABLE_ANNOUNCEMENTS_PER_APP: u32 = 100;
pub const MAX_REASONABLE_MENTIONS_PER_POST: u32 = 64;
pub const MAX_MIGRATION_BATCH_SIZE: usize = 50;

#[derive(Default)]
pub struct AdminState {
    pub admin: ActorId,
    pub config: Config,
    pub migration: MigrationState,
}

#[derive(Default)]
pub struct MigrationState {
    pub started: bool,
    pub finished: bool,
    pub locked: bool,
    pub manifest: Option<MigrationManifest>,
    pub counts: MigrationCounts,
    pub checksum_accumulator: Hash32,
    pub applied_batches: BTreeMap<String, MigrationBatchRecord>,
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
    MigrationStarted {
        admin: ActorId,
        source_program_id: ActorId,
        snapshot_block: u64,
        snapshot_hash: Hash32,
        manifest_hash: Hash32,
        season_id: u32,
    },
    MigrationBatchImported {
        admin: ActorId,
        source_program_id: ActorId,
        domain: MigrationDomain,
        batch_id: String,
        count: u32,
        checksum: Hash32,
        season_id: u32,
    },
    MigrationFinished {
        admin: ActorId,
        source_program_id: ActorId,
        counts: MigrationCounts,
        final_checksum: Hash32,
        season_id: u32,
    },
}

pub struct AdminService<'a> {
    admin: &'a RefCell<AdminState>,
    registry: &'a RefCell<RegistryState>,
    review: &'a RefCell<ReviewState>,
    board: &'a RefCell<BoardState>,
    current_season: u32,
}

impl<'a> AdminService<'a> {
    pub fn new(
        admin: &'a RefCell<AdminState>,
        registry: &'a RefCell<RegistryState>,
        review: &'a RefCell<ReviewState>,
        board: &'a RefCell<BoardState>,
        current_season: u32,
    ) -> Self {
        Self {
            admin,
            registry,
            review,
            board,
            current_season,
        }
    }

    fn ensure_admin(&self) -> Result<(), ContractError> {
        if msg::source() != self.admin.borrow().admin {
            return Err(ContractError::NotAdmin);
        }
        Ok(())
    }

    fn precheck_batch(
        &self,
        domain: MigrationDomain,
        batch_id: &str,
        checksum: Hash32,
        count: usize,
    ) -> Result<bool, ContractError> {
        if count > MAX_MIGRATION_BATCH_SIZE {
            return Err(ContractError::MigrationBatchTooLarge);
        }
        let admin = self.admin.borrow();
        let migration = &admin.migration;
        if !migration.started {
            return Err(ContractError::MigrationNotStarted);
        }
        if migration.finished {
            return Err(ContractError::MigrationFinished);
        }
        if batch_id.is_empty() || is_zero_hash(&checksum) {
            return Err(ContractError::MigrationManifestMismatch);
        }
        if let Some(existing) = migration.applied_batches.get(batch_id) {
            if existing.domain == domain
                && existing.checksum == checksum
                && existing.count == count as u32
            {
                return Ok(false);
            }
            return Err(ContractError::MigrationBatchChecksumConflict);
        }
        Ok(true)
    }

    fn migration_source_program_id(&self) -> Result<ActorId, ContractError> {
        self.admin
            .borrow()
            .migration
            .manifest
            .as_ref()
            .map(|manifest| manifest.source_program_id)
            .ok_or(ContractError::MigrationNotStarted)
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

    #[export]
    pub fn get_protocol_version(&self) -> ProtocolVersion {
        ProtocolVersion {
            major: 2,
            minor: 0,
            review_enabled: self.admin.borrow().config.allow_review,
            season_id: self.current_season,
        }
    }

    #[export]
    pub fn migration_status(&self) -> MigrationStatus {
        let migration = &self.admin.borrow().migration;
        MigrationStatus {
            started: migration.started,
            finished: migration.finished,
            locked: migration.locked,
            manifest: migration.manifest.clone(),
            counts: migration.counts.clone(),
            checksum_accumulator: migration.checksum_accumulator,
            applied_batches: migration.applied_batches.values().cloned().collect(),
        }
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
            if admin.migration.locked && !new_config.paused {
                return Err(ContractError::MigrationAlreadyStarted);
            }
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
        {
            let mut admin = self.admin.borrow_mut();
            if admin.migration.locked {
                return Err(ContractError::MigrationAlreadyStarted);
            }
            admin.config.paused = false;
        }
        self.emit_event(AdminEvent::Unpaused {
            admin: admin_id,
            season_id: self.current_season,
        })
        .expect("emit Unpaused failed");
        Ok(())
    }

    #[export(unwrap_result)]
    pub fn begin_migration(&mut self, manifest: MigrationManifest) -> Result<(), ContractError> {
        self.ensure_admin()?;
        validate_manifest(&manifest)?;
        let admin_id = self.admin.borrow().admin;
        {
            let mut admin = self.admin.borrow_mut();
            if admin.migration.started && !admin.migration.finished {
                return Err(ContractError::MigrationAlreadyStarted);
            }
            if admin.migration.finished {
                return Err(ContractError::MigrationFinished);
            }
            admin.config.paused = true;
            admin.migration.started = true;
            admin.migration.finished = false;
            admin.migration.locked = true;
            admin.migration.manifest = Some(manifest.clone());
            admin.migration.counts = MigrationCounts::default();
            admin.migration.checksum_accumulator = [0; 32];
            admin.migration.applied_batches.clear();
        }

        self.emit_event(AdminEvent::MigrationStarted {
            admin: admin_id,
            source_program_id: manifest.source_program_id,
            snapshot_block: manifest.snapshot_block,
            snapshot_hash: manifest.snapshot_hash,
            manifest_hash: manifest.manifest_hash,
            season_id: self.current_season,
        })
        .expect("emit MigrationStarted failed");
        Ok(())
    }

    #[export(unwrap_result)]
    pub fn import_config_and_review_seed(
        &mut self,
        batch_id: String,
        checksum: Hash32,
        config: Config,
        reviewers: Vec<ActorId>,
    ) -> Result<(), ContractError> {
        self.ensure_admin()?;
        validate_config(&config)?;
        let count = reviewers.len();
        if !self.precheck_batch(
            MigrationDomain::ConfigAndReviewSeed,
            &batch_id,
            checksum,
            count,
        )? {
            return Ok(());
        }

        {
            let mut review = self.review.borrow_mut();
            review::import_reviewers(&mut review, self.current_season, &reviewers)?;
        }
        {
            let mut admin = self.admin.borrow_mut();
            admin.config = config;
            admin.config.paused = true;
        }

        self.record_and_emit_batch(
            MigrationDomain::ConfigAndReviewSeed,
            batch_id,
            checksum,
            count,
            MigrationCounts {
                reviewers: count as u32,
                ..Default::default()
            },
        )
    }

    #[export(unwrap_result)]
    pub fn import_participants(
        &mut self,
        batch_id: String,
        checksum: Hash32,
        entries: Vec<ParticipantMigrationEntry>,
    ) -> Result<(), ContractError> {
        self.ensure_admin()?;
        let count = entries.len();
        if !self.precheck_batch(MigrationDomain::Participants, &batch_id, checksum, count)? {
            return Ok(());
        }
        registry::import_participants(
            &mut self.registry.borrow_mut(),
            self.current_season,
            &entries,
        )?;
        self.record_and_emit_batch(
            MigrationDomain::Participants,
            batch_id,
            checksum,
            count,
            MigrationCounts {
                participants: count as u32,
                ..Default::default()
            },
        )
    }

    #[export(unwrap_result)]
    pub fn import_applications(
        &mut self,
        batch_id: String,
        checksum: Hash32,
        entries: Vec<ApplicationMigrationEntry>,
    ) -> Result<(), ContractError> {
        self.ensure_admin()?;
        let count = entries.len();
        if !self.precheck_batch(MigrationDomain::Applications, &batch_id, checksum, count)? {
            return Ok(());
        }
        {
            let mut registry = self.registry.borrow_mut();
            let mut review = self.review.borrow_mut();
            registry::import_applications(
                &mut registry,
                &mut review,
                self.current_season,
                &entries,
            )?;
        }
        self.record_and_emit_batch(
            MigrationDomain::Applications,
            batch_id,
            checksum,
            count,
            MigrationCounts {
                applications: count as u32,
                ..Default::default()
            },
        )
    }

    #[export(unwrap_result)]
    pub fn import_program_replacements(
        &mut self,
        batch_id: String,
        checksum: Hash32,
        entries: Vec<ProgramReplacementMigrationEntry>,
    ) -> Result<(), ContractError> {
        self.ensure_admin()?;
        let count = entries.len();
        if !self.precheck_batch(
            MigrationDomain::ProgramReplacements,
            &batch_id,
            checksum,
            count,
        )? {
            return Ok(());
        }
        registry::import_program_replacements(&mut self.registry.borrow_mut(), &entries)?;
        self.record_and_emit_batch(
            MigrationDomain::ProgramReplacements,
            batch_id,
            checksum,
            count,
            MigrationCounts {
                program_replacements: count as u32,
                ..Default::default()
            },
        )
    }

    #[export(unwrap_result)]
    pub fn import_board_state(
        &mut self,
        batch_id: String,
        checksum: Hash32,
        identity_cards: Vec<IdentityCardMigrationEntry>,
        announcements: Vec<AnnouncementMigrationEntry>,
    ) -> Result<(), ContractError> {
        self.ensure_admin()?;
        let count = identity_cards.len().saturating_add(announcements.len());
        if !self.precheck_batch(MigrationDomain::BoardState, &batch_id, checksum, count)? {
            return Ok(());
        }
        {
            let registry = self.registry.borrow();
            self.board.borrow_mut().import_board_state(
                &registry,
                self.current_season,
                &identity_cards,
                &announcements,
            )?;
        }
        self.record_and_emit_batch(
            MigrationDomain::BoardState,
            batch_id,
            checksum,
            count,
            MigrationCounts {
                identity_cards: identity_cards.len() as u32,
                announcements: announcements.len() as u32,
                ..Default::default()
            },
        )
    }

    #[export(unwrap_result)]
    pub fn finish_migration(
        &mut self,
        expected_counts: MigrationCounts,
        final_checksum: Hash32,
    ) -> Result<(), ContractError> {
        self.ensure_admin()?;
        let admin_id = self.admin.borrow().admin;
        let source_program_id = self.migration_source_program_id()?;
        {
            let mut admin = self.admin.borrow_mut();
            if !admin.migration.started {
                return Err(ContractError::MigrationNotStarted);
            }
            if admin.migration.finished {
                return Err(ContractError::MigrationFinished);
            }
            if admin.migration.counts != expected_counts {
                return Err(ContractError::MigrationCountMismatch);
            }
            if admin.migration.checksum_accumulator != final_checksum {
                return Err(ContractError::MigrationHashMismatch);
            }
            admin.migration.finished = true;
            admin.migration.locked = false;
            admin.config.paused = true;
        }

        self.emit_event(AdminEvent::MigrationFinished {
            admin: admin_id,
            source_program_id,
            counts: expected_counts,
            final_checksum,
            season_id: self.current_season,
        })
        .expect("emit MigrationFinished failed");
        Ok(())
    }

    fn record_and_emit_batch(
        &mut self,
        domain: MigrationDomain,
        batch_id: String,
        checksum: Hash32,
        count: usize,
        delta: MigrationCounts,
    ) -> Result<(), ContractError> {
        let count = count as u32;
        let admin_id = self.admin.borrow().admin;
        let source_program_id = self.migration_source_program_id()?;
        {
            let mut admin = self.admin.borrow_mut();
            add_counts(&mut admin.migration.counts, &delta);
            xor_into(&mut admin.migration.checksum_accumulator, &checksum);
            admin.migration.applied_batches.insert(
                batch_id.clone(),
                MigrationBatchRecord {
                    domain,
                    batch_id: batch_id.clone(),
                    checksum,
                    count,
                },
            );
        }
        self.emit_event(AdminEvent::MigrationBatchImported {
            admin: admin_id,
            source_program_id,
            domain,
            batch_id,
            count,
            checksum,
            season_id: self.current_season,
        })
        .expect("emit MigrationBatchImported failed");
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
            registry::ensure_current_program_id(&registry, program_id)?;
            let mut review_state = self.review.borrow_mut();
            let (old_status, track) = {
                let app = registry
                    .applications
                    .get_mut(&program_id)
                    .ok_or(ContractError::UnknownApplication)?;
                let old_status = app.status;
                let track = app.track;
                app.status = new_status;
                (old_status, track)
            };
            registry::reindex_application_status(
                &mut registry,
                program_id,
                track,
                old_status,
                new_status,
            );
            review::manual_status_override(&mut review_state, program_id, new_status);
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
        || config.max_review_body_bytes == 0
    {
        return Err(ContractError::ConfigInvalid);
    }

    Ok(())
}

fn validate_manifest(manifest: &MigrationManifest) -> Result<(), ContractError> {
    if manifest.source_program_id == ActorId::zero()
        || manifest.snapshot_block == 0
        || manifest.schema_version == 0
        || manifest.old_indexer_cursor.is_empty()
        || is_zero_hash(&manifest.snapshot_hash)
        || is_zero_hash(&manifest.manifest_hash)
    {
        return Err(ContractError::MigrationManifestMismatch);
    }
    Ok(())
}

fn is_zero_hash(hash: &Hash32) -> bool {
    hash.iter().all(|b| *b == 0)
}

fn xor_into(accumulator: &mut Hash32, checksum: &Hash32) {
    for (left, right) in accumulator.iter_mut().zip(checksum.iter()) {
        *left ^= *right;
    }
}

fn add_counts(counts: &mut MigrationCounts, delta: &MigrationCounts) {
    counts.participants = counts.participants.saturating_add(delta.participants);
    counts.applications = counts.applications.saturating_add(delta.applications);
    counts.program_replacements = counts
        .program_replacements
        .saturating_add(delta.program_replacements);
    counts.identity_cards = counts.identity_cards.saturating_add(delta.identity_cards);
    counts.announcements = counts.announcements.saturating_add(delta.announcements);
    counts.reviewers = counts.reviewers.saturating_add(delta.reviewers);
}
