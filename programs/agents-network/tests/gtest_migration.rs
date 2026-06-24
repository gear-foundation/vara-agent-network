//! Admin migration route tests.

mod common;

use agents_network_client::{
    AgentsNetworkClient, Announcement, AnnouncementKind, AnnouncementMigrationEntry, AppStatus,
    Application, ApplicationMigrationEntry, IdentityCard, IdentityCardMigrationEntry,
    MigrationCounts, MigrationManifest, Participant, ParticipantMigrationEntry,
    ProgramReplacementMigrationEntry, Track, admin::Admin, board::Board, registry::Registry,
    review::Review,
};
use common::*;
use sails_rs::client::*;
use sails_rs::prelude::*;

fn checksum(byte: u8) -> [u8; 32] {
    [byte; 32]
}

fn xor(checksums: &[[u8; 32]]) -> [u8; 32] {
    let mut out = [0; 32];
    for checksum in checksums {
        for (left, right) in out.iter_mut().zip(checksum.iter()) {
            *left ^= *right;
        }
    }
    out
}

fn zero_counts() -> MigrationCounts {
    MigrationCounts {
        participants: 0,
        applications: 0,
        program_replacements: 0,
        identity_cards: 0,
        announcements: 0,
        reviewers: 0,
    }
}

fn manifest() -> MigrationManifest {
    MigrationManifest {
        source_program_id: ActorId::from(9_000u64),
        snapshot_block: 12_345,
        snapshot_hash: checksum(9),
        manifest_hash: checksum(10),
        schema_version: 1,
        old_indexer_cursor: "block:12345:event:99".to_string(),
    }
}

fn participant(wallet: u64, handle: &str) -> ParticipantMigrationEntry {
    ParticipantMigrationEntry {
        wallet: wallet.into(),
        participant: Participant {
            handle: handle.to_string(),
            github: format!("https://github.com/{handle}"),
            joined_at: 100,
            season_id: 1,
        },
    }
}

fn application_entry(
    program_id: u64,
    owner: u64,
    handle: &str,
    status: AppStatus,
) -> ApplicationMigrationEntry {
    ApplicationMigrationEntry {
        application: migrated_app(program_id, owner, handle, status),
    }
}

fn migrated_app(program_id: u64, owner: u64, handle: &str, status: AppStatus) -> Application {
    Application {
        program_id: program_id.into(),
        owner: owner.into(),
        handle: handle.to_string(),
        description: format!("{handle} migrated from v1"),
        track: Track::Services,
        github_url: format!("https://github.com/{handle}"),
        skills_hash: checksum(1),
        skills_url: format!("https://example.com/{handle}/skills.json"),
        idl_hash: checksum(2),
        idl_url: format!("https://example.com/{handle}/agent.idl"),
        contacts: None,
        registered_at: 200,
        season_id: 1,
        status,
    }
}

fn identity_card(app: u64) -> IdentityCardMigrationEntry {
    IdentityCardMigrationEntry {
        app: app.into(),
        card: IdentityCard {
            who_i_am: "Migrated service".to_string(),
            what_i_do: "Serve migrated callers".to_string(),
            how_to_interact: "Call the documented service route".to_string(),
            what_i_offer: "Stable migrated state".to_string(),
            tags: vec!["migrated".to_string()],
            updated_at: 300,
            season_id: 1,
        },
    }
}

fn announcement(app: u64, id: u64) -> AnnouncementMigrationEntry {
    AnnouncementMigrationEntry {
        app: app.into(),
        announcement: Announcement {
            id,
            title: "Migrated launch".to_string(),
            body: "Imported from the Season 1 snapshot".to_string(),
            tags: vec!["snapshot".to_string()],
            kind: AnnouncementKind::Invitation,
            posted_at: 301,
            season_id: 1,
        },
    }
}

#[tokio::test]
async fn migration_is_admin_only_and_hard_locks_user_writes() {
    let system = init_system();
    let env = GtestEnv::new(system, DEPLOYER.into());
    let program = deploy(&env).await;

    program
        .admin()
        .begin_migration(manifest())
        .with_actor_id(ALICE.into())
        .await
        .unwrap_err();

    program
        .admin()
        .begin_migration(manifest())
        .with_actor_id(DEPLOYER.into())
        .await
        .unwrap();

    let status = program.admin().migration_status().await.unwrap();
    assert!(status.started);
    assert!(status.locked);
    assert!(!status.finished);
    assert!(program.admin().get_config().await.unwrap().paused);

    program
        .registry()
        .register_participant("alice".to_string(), "https://github.com/alice".to_string())
        .with_actor_id(ALICE.into())
        .await
        .unwrap_err();

    program
        .admin()
        .unpause()
        .with_actor_id(DEPLOYER.into())
        .await
        .unwrap_err();

    let mut config = program.admin().get_config().await.unwrap();
    config.paused = false;
    program
        .admin()
        .update_config(config)
        .with_actor_id(DEPLOYER.into())
        .await
        .unwrap_err();
}

#[tokio::test]
async fn migration_batches_are_idempotent_and_conflicts_fail() {
    let system = init_system();
    let env = GtestEnv::new(system, DEPLOYER.into());
    let program = deploy(&env).await;

    program
        .admin()
        .begin_migration(manifest())
        .with_actor_id(DEPLOYER.into())
        .await
        .unwrap();

    let entries = vec![participant(ALICE, "alice")];
    program
        .admin()
        .import_participants(
            "participants-0001".to_string(),
            checksum(1),
            entries.clone(),
        )
        .with_actor_id(DEPLOYER.into())
        .await
        .unwrap();
    program
        .admin()
        .import_participants("participants-0001".to_string(), checksum(1), entries)
        .with_actor_id(DEPLOYER.into())
        .await
        .unwrap();

    let status = program.admin().migration_status().await.unwrap();
    assert_eq!(status.counts.participants, 1);
    assert_eq!(status.applied_batches.len(), 1);

    program
        .admin()
        .import_participants(
            "participants-0001".to_string(),
            checksum(2),
            vec![participant(BOB, "bob")],
        )
        .with_actor_id(DEPLOYER.into())
        .await
        .unwrap_err();

    program
        .admin()
        .import_participants(
            "participants-0002".to_string(),
            checksum(3),
            vec![participant(BOB, "alice")],
        )
        .with_actor_id(DEPLOYER.into())
        .await
        .unwrap_err();
}

#[tokio::test]
async fn migration_imports_state_rebuilds_indexes_and_finishes_locked() {
    let system = init_system();
    let env = GtestEnv::new(system, DEPLOYER.into());
    let program = deploy(&env).await;

    program
        .admin()
        .begin_migration(manifest())
        .with_actor_id(DEPLOYER.into())
        .await
        .unwrap();

    let mut config = program.admin().get_config().await.unwrap();
    config.review_rate_limit_ms = 0;
    program
        .admin()
        .import_config_and_review_seed(
            "seed-0001".to_string(),
            checksum(11),
            config,
            vec![CAROL.into()],
        )
        .with_actor_id(DEPLOYER.into())
        .await
        .unwrap();
    assert!(program.review().is_reviewer(CAROL.into()).await.unwrap());

    program
        .admin()
        .import_applications(
            "apps-0001".to_string(),
            checksum(12),
            vec![application_entry(
                STUB_PROGRAM_BETA,
                ALICE,
                "alpha-live",
                AppStatus::Live,
            )],
        )
        .with_actor_id(DEPLOYER.into())
        .await
        .unwrap();

    let summary = program
        .review()
        .get_review_summary(STUB_PROGRAM_BETA.into())
        .await
        .unwrap()
        .expect("migrated app should initialize review summary");
    assert_eq!(summary.pending_submission_revision, Some(1));
    assert_eq!(summary.total_comment_count, 0);

    let migrated = program
        .registry()
        .get_application(STUB_PROGRAM_BETA.into())
        .await
        .unwrap()
        .expect("migrated app should be readable");
    assert_eq!(migrated.program_id, ActorId::from(STUB_PROGRAM_BETA));
    assert_eq!(migrated.status, AppStatus::Live);

    program
        .admin()
        .import_program_replacements(
            "replacements-0001".to_string(),
            checksum(13),
            vec![ProgramReplacementMigrationEntry {
                old_program_id: STUB_PROGRAM_ALPHA.into(),
                new_program_id: STUB_PROGRAM_BETA.into(),
                replacement_count: 1,
            }],
        )
        .with_actor_id(DEPLOYER.into())
        .await
        .unwrap();
    assert_eq!(
        program
            .registry()
            .resolve_current_program_id(STUB_PROGRAM_ALPHA.into())
            .await
            .unwrap(),
        ActorId::from(STUB_PROGRAM_BETA)
    );

    program
        .admin()
        .import_board_state(
            "board-0001".to_string(),
            checksum(14),
            vec![identity_card(STUB_PROGRAM_BETA)],
            vec![announcement(STUB_PROGRAM_BETA, 7)],
        )
        .with_actor_id(DEPLOYER.into())
        .await
        .unwrap();
    assert_eq!(
        program
            .board()
            .list_identity_cards(None, 10)
            .await
            .unwrap()
            .items
            .len(),
        1
    );
    assert_eq!(
        program
            .board()
            .list_announcements(None, 10)
            .await
            .unwrap()
            .items[0]
            .1
            .id,
        7
    );

    let expected = MigrationCounts {
        participants: 0,
        applications: 1,
        program_replacements: 1,
        identity_cards: 1,
        announcements: 1,
        reviewers: 1,
    };
    let final_checksum = xor(&[checksum(11), checksum(12), checksum(13), checksum(14)]);

    program
        .admin()
        .finish_migration(expected.clone(), checksum(99))
        .with_actor_id(DEPLOYER.into())
        .await
        .unwrap_err();
    program
        .admin()
        .finish_migration(expected.clone(), final_checksum)
        .with_actor_id(DEPLOYER.into())
        .await
        .unwrap();

    let status = program.admin().migration_status().await.unwrap();
    assert!(status.finished);
    assert!(!status.locked);
    assert!(program.admin().get_config().await.unwrap().paused);

    program
        .admin()
        .import_participants(
            "participants-after-finish".to_string(),
            checksum(15),
            vec![participant(BOB, "bob")],
        )
        .with_actor_id(DEPLOYER.into())
        .await
        .unwrap_err();

    program
        .admin()
        .unpause()
        .with_actor_id(DEPLOYER.into())
        .await
        .unwrap();
    let new_post_id = program
        .board()
        .post_announcement(
            STUB_PROGRAM_BETA.into(),
            mk_announcement_req("post-migration"),
        )
        .with_actor_id(ALICE.into())
        .await
        .unwrap();
    assert_eq!(new_post_id, 8);
}

#[tokio::test]
async fn migration_rejects_wrong_season_and_orphan_rows() {
    let system = init_system();
    let env = GtestEnv::new(system, DEPLOYER.into());
    let program = deploy(&env).await;

    program
        .admin()
        .begin_migration(manifest())
        .with_actor_id(DEPLOYER.into())
        .await
        .unwrap();

    let mut wrong_participant = participant(ALICE, "alice");
    wrong_participant.participant.season_id = 2;
    program
        .admin()
        .import_participants(
            "wrong-season-participant".to_string(),
            checksum(21),
            vec![wrong_participant],
        )
        .with_actor_id(DEPLOYER.into())
        .await
        .unwrap_err();

    let mut wrong_app = application_entry(STUB_PROGRAM_BETA, ALICE, "alpha-live", AppStatus::Live);
    wrong_app.application.season_id = 2;
    program
        .admin()
        .import_applications(
            "wrong-season-app".to_string(),
            checksum(22),
            vec![wrong_app],
        )
        .with_actor_id(DEPLOYER.into())
        .await
        .unwrap_err();

    program
        .admin()
        .import_applications(
            "apps-0001".to_string(),
            checksum(23),
            vec![application_entry(
                STUB_PROGRAM_BETA,
                ALICE,
                "alpha-live",
                AppStatus::Live,
            )],
        )
        .with_actor_id(DEPLOYER.into())
        .await
        .unwrap();

    let mut wrong_card = identity_card(STUB_PROGRAM_BETA);
    wrong_card.card.season_id = 2;
    program
        .admin()
        .import_board_state(
            "wrong-season-card".to_string(),
            checksum(24),
            vec![wrong_card],
            vec![],
        )
        .with_actor_id(DEPLOYER.into())
        .await
        .unwrap_err();

    let mut wrong_announcement = announcement(STUB_PROGRAM_BETA, 7);
    wrong_announcement.announcement.season_id = 2;
    program
        .admin()
        .import_board_state(
            "wrong-season-announcement".to_string(),
            checksum(25),
            vec![],
            vec![wrong_announcement],
        )
        .with_actor_id(DEPLOYER.into())
        .await
        .unwrap_err();

    program
        .admin()
        .import_board_state(
            "orphan-card".to_string(),
            checksum(26),
            vec![identity_card(STUB_PROGRAM_GAMMA)],
            vec![],
        )
        .with_actor_id(DEPLOYER.into())
        .await
        .unwrap_err();

    program
        .admin()
        .import_program_replacements(
            "zero-replacement-count".to_string(),
            checksum(27),
            vec![ProgramReplacementMigrationEntry {
                old_program_id: STUB_PROGRAM_ALPHA.into(),
                new_program_id: STUB_PROGRAM_BETA.into(),
                replacement_count: 0,
            }],
        )
        .with_actor_id(DEPLOYER.into())
        .await
        .unwrap_err();
}

#[tokio::test]
async fn migration_preserves_max_replacement_count_for_collapsed_aliases() {
    let system = init_system();
    let env = GtestEnv::new(system, DEPLOYER.into());
    let program = deploy(&env).await;

    program
        .admin()
        .begin_migration(manifest())
        .with_actor_id(DEPLOYER.into())
        .await
        .unwrap();
    program
        .admin()
        .import_applications(
            "apps-0001".to_string(),
            checksum(31),
            vec![application_entry(
                STUB_PROGRAM_BETA,
                ALICE,
                "alpha-live",
                AppStatus::Building,
            )],
        )
        .with_actor_id(DEPLOYER.into())
        .await
        .unwrap();
    program
        .admin()
        .import_program_replacements(
            "replacements-0001".to_string(),
            checksum(32),
            vec![
                ProgramReplacementMigrationEntry {
                    old_program_id: STUB_PROGRAM_ALPHA.into(),
                    new_program_id: STUB_PROGRAM_BETA.into(),
                    replacement_count: 8,
                },
                ProgramReplacementMigrationEntry {
                    old_program_id: STUB_PROGRAM_GAMMA.into(),
                    new_program_id: STUB_PROGRAM_BETA.into(),
                    replacement_count: 1,
                },
            ],
        )
        .with_actor_id(DEPLOYER.into())
        .await
        .unwrap();

    program
        .admin()
        .finish_migration(
            MigrationCounts {
                participants: 0,
                applications: 1,
                program_replacements: 2,
                identity_cards: 0,
                announcements: 0,
                reviewers: 0,
            },
            xor(&[checksum(31), checksum(32)]),
        )
        .with_actor_id(DEPLOYER.into())
        .await
        .unwrap();
    program
        .admin()
        .unpause()
        .with_actor_id(DEPLOYER.into())
        .await
        .unwrap();
}

#[tokio::test]
async fn migration_rejects_too_large_batches_and_bad_finish_counts() {
    let system = init_system();
    let env = GtestEnv::new(system, DEPLOYER.into());
    let program = deploy(&env).await;

    program
        .admin()
        .begin_migration(manifest())
        .with_actor_id(DEPLOYER.into())
        .await
        .unwrap();

    let entries = (0..51u64)
        .map(|i| participant(300 + i, &format!("bulk-{i:02}")))
        .collect();
    program
        .admin()
        .import_participants("too-large".to_string(), checksum(20), entries)
        .with_actor_id(DEPLOYER.into())
        .await
        .unwrap_err();

    program
        .admin()
        .finish_migration(zero_counts(), checksum(20))
        .with_actor_id(DEPLOYER.into())
        .await
        .unwrap_err();
}
