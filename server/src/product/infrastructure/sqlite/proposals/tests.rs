use super::SqliteProposalRepository;
use crate::product::application::proposals::{CreateProposal, ProposalService};
use crate::product::domain::{
    AssetBindingId, AssetId, AssetSectionId, GenerationStatus, MediaId, ProductError, ProjectId,
    ProposalSource, ProposalStatus, ProposalTarget, StoryboardId,
};
use crate::product::infrastructure::sqlite::ProductDatabase;
use rusqlite::params;
use std::path::PathBuf;
use std::sync::Arc;
use uuid::Uuid;

struct ProposalFixture {
    database: ProductDatabase,
    path: PathBuf,
    project_id: ProjectId,
    storyboard_id: StoryboardId,
    media_id: MediaId,
    binding_id: AssetBindingId,
}

impl ProposalFixture {
    fn new() -> Self {
        let path =
            std::env::temp_dir().join(format!("videoflow-proposals-{}.sqlite", Uuid::new_v4()));
        let database = ProductDatabase::open(&path).unwrap();
        let fixture = Self {
            database,
            path,
            project_id: ProjectId::new(),
            storyboard_id: StoryboardId::new(),
            media_id: MediaId::new(),
            binding_id: AssetBindingId::new(),
        };
        fixture.seed();
        fixture
    }

    fn service(&self) -> ProposalService {
        ProposalService::new(Arc::new(SqliteProposalRepository::new(
            self.database.clone(),
        )))
    }

    fn command(
        &self,
        target: ProposalTarget,
        proposed_value: &str,
        tool_call_id: &str,
    ) -> CreateProposal {
        CreateProposal {
            project_id: self.project_id,
            storyboard_id: self.storyboard_id,
            target,
            proposed_value: proposed_value.into(),
            summary: "AI suggested a focused change".into(),
            source: ProposalSource {
                thread_id: Uuid::new_v4(),
                turn_id: Uuid::new_v4(),
                tool_call_id: tool_call_id.into(),
            },
        }
    }

    fn seed(&self) {
        let connection = self.database.connect().unwrap();
        let now = "2026-09-26T00:00:00Z";
        let asset_id = AssetId::new();
        let section_id = AssetSectionId::new();
        connection
            .execute(
                "INSERT INTO projects (id, name, revision, created_at, updated_at) \
                 VALUES (?1, 'Proposal project', 1, ?2, ?2)",
                params![self.project_id.to_string(), now],
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO storyboards \
                 (id, project_id, name, position, revision, created_at, updated_at) \
                 VALUES (?1, ?2, 'Opening', 'a', 1, ?3, ?3)",
                params![
                    self.storyboard_id.to_string(),
                    self.project_id.to_string(),
                    now
                ],
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO storyboard_scripts (storyboard_id, text, revision, updated_at) \
                 VALUES (?1, 'original script', 1, ?2)",
                params![self.storyboard_id.to_string(), now],
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO media_items \
                 (id, project_id, storyboard_id, kind, role, name, prompt, mime_type, width, height, \
                  status, revision, created_at, updated_at) \
                 VALUES (?1, ?2, ?3, 'image', 'keyframe', 'Frame', 'original media prompt', \
                         'image/webp', 1920, 1080, 'ready', 1, ?4, ?4)",
                params![
                    self.media_id.to_string(),
                    self.project_id.to_string(),
                    self.storyboard_id.to_string(),
                    now
                ],
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO assets \
                 (id, project_id, kind, name, canonical_prompt, revision, created_at, updated_at) \
                 VALUES (?1, ?2, 'character', 'Hero', 'canonical hero', 1, ?3, ?3)",
                params![asset_id.to_string(), self.project_id.to_string(), now],
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO asset_sections \
                 (id, project_id, storyboard_id, name, kind, position, revision, created_at, updated_at) \
                 VALUES (?1, ?2, ?3, 'People', 'character', 'a', 1, ?4, ?4)",
                params![
                    section_id.to_string(),
                    self.project_id.to_string(),
                    self.storyboard_id.to_string(),
                    now
                ],
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO asset_bindings \
                 (id, project_id, storyboard_id, section_id, asset_id, position, revision, \
                  created_at, updated_at) \
                 VALUES (?1, ?2, ?3, ?4, ?5, 'a', 1, ?6, ?6)",
                params![
                    self.binding_id.to_string(),
                    self.project_id.to_string(),
                    self.storyboard_id.to_string(),
                    section_id.to_string(),
                    asset_id.to_string(),
                    now
                ],
            )
            .unwrap();
    }

    fn scalar_i64(&self, sql: &str) -> i64 {
        self.database
            .connect()
            .unwrap()
            .query_row(sql, [], |row| row.get(0))
            .unwrap()
    }
}

impl Drop for ProposalFixture {
    fn drop(&mut self) {
        for path in [
            self.path.clone(),
            PathBuf::from(format!("{}-wal", self.path.display())),
            PathBuf::from(format!("{}-shm", self.path.display())),
        ] {
            let _ = std::fs::remove_file(path);
        }
    }
}

#[tokio::test]
async fn script_apply_is_atomic_and_idempotent_without_generation() {
    let fixture = ProposalFixture::new();
    let service = fixture.service();
    let proposal = service
        .create(fixture.command(
            ProposalTarget::Script {
                storyboard_id: fixture.storyboard_id,
            },
            "AI revised script",
            "script-call",
        ))
        .await
        .unwrap();
    assert_eq!(
        (proposal.before_value.as_str(), proposal.base_revision),
        ("original script", 1)
    );

    let first = service
        .apply(
            fixture.project_id,
            proposal.id,
            1,
            1,
            "apply-script-001".into(),
        )
        .await
        .unwrap();
    let replay = service
        .apply(
            fixture.project_id,
            proposal.id,
            1,
            1,
            "apply-script-001".into(),
        )
        .await
        .unwrap();
    assert_eq!(first, replay);
    assert_eq!(first.proposal.status, ProposalStatus::Applied);
    assert_eq!(first.proposal.revision, 3);
    assert_eq!(first.target.revision, 2);
    assert!(first.generation_job.is_none());

    let connection = fixture.database.connect().unwrap();
    let script: (String, i64) = connection
        .query_row(
            "SELECT text, revision FROM storyboard_scripts WHERE storyboard_id = ?1",
            [fixture.storyboard_id.to_string()],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .unwrap();
    assert_eq!(script, ("AI revised script".into(), 2));
    assert_eq!(
        fixture.scalar_i64("SELECT COUNT(*) FROM generation_jobs"),
        0
    );
    assert_eq!(
        fixture.scalar_i64(
            "SELECT COUNT(*) FROM product_outbox_events WHERE event_type = 'proposal.applied'"
        ),
        1
    );
}

#[tokio::test]
async fn rejecting_an_ai_script_proposal_never_changes_the_formal_script() {
    let fixture = ProposalFixture::new();
    let service = fixture.service();
    let proposal = service
        .create(fixture.command(
            ProposalTarget::Script {
                storyboard_id: fixture.storyboard_id,
            },
            "AI text that still needs confirmation",
            "reject-script-call",
        ))
        .await
        .unwrap();

    let rejected = service
        .reject(
            fixture.project_id,
            proposal.id,
            proposal.revision,
            1,
            "reject-script-001".into(),
        )
        .await
        .unwrap();
    assert_eq!(rejected.status, ProposalStatus::Rejected);

    let script: (String, i64) = fixture
        .database
        .connect()
        .unwrap()
        .query_row(
            "SELECT text, revision FROM storyboard_scripts WHERE storyboard_id = ?1",
            [fixture.storyboard_id.to_string()],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .unwrap();
    assert_eq!(script, ("original script".into(), 1));
}

#[tokio::test]
async fn media_and_binding_apply_create_exactly_one_generation_job() {
    let fixture = ProposalFixture::new();
    let service = fixture.service();
    let media = service
        .create(fixture.command(
            ProposalTarget::MediaPrompt {
                media_id: fixture.media_id,
            },
            "new media prompt",
            "media-call",
        ))
        .await
        .unwrap();
    let applied = service
        .apply(fixture.project_id, media.id, 1, 1, "apply-media-001".into())
        .await
        .unwrap();
    assert_eq!(
        applied.generation_job.as_ref().unwrap().status,
        GenerationStatus::WaitingForProvider
    );
    service
        .apply(fixture.project_id, media.id, 1, 1, "apply-media-001".into())
        .await
        .unwrap();

    let binding = service
        .create(fixture.command(
            ProposalTarget::AssetBindingPrompt {
                binding_id: fixture.binding_id,
            },
            "storyboard-specific hero",
            "binding-call",
        ))
        .await
        .unwrap();
    assert_eq!(binding.before_value, "canonical hero");
    service
        .apply(
            fixture.project_id,
            binding.id,
            1,
            1,
            "apply-binding-001".into(),
        )
        .await
        .unwrap();

    let connection = fixture.database.connect().unwrap();
    let media_prompt: (String, i64) = connection
        .query_row(
            "SELECT prompt, revision FROM media_items WHERE id = ?1",
            [fixture.media_id.to_string()],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .unwrap();
    let binding_prompt: (String, i64) = connection
        .query_row(
            "SELECT prompt_override, revision FROM asset_bindings WHERE id = ?1",
            [fixture.binding_id.to_string()],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .unwrap();
    assert_eq!(media_prompt, ("new media prompt".into(), 2));
    assert_eq!(binding_prompt, ("storyboard-specific hero".into(), 2));
    assert_eq!(
        fixture.scalar_i64("SELECT COUNT(*) FROM generation_jobs"),
        2
    );
    assert_eq!(
        fixture.scalar_i64(
            "SELECT COUNT(*) FROM product_outbox_events WHERE event_type = 'generation.requested'"
        ),
        2
    );
}

#[tokio::test]
async fn stale_target_marks_proposal_conflicted_without_overwriting_user_work() {
    let fixture = ProposalFixture::new();
    let service = fixture.service();
    let proposal = service
        .create(fixture.command(
            ProposalTarget::Script {
                storyboard_id: fixture.storyboard_id,
            },
            "AI version",
            "conflict-call",
        ))
        .await
        .unwrap();
    fixture
        .database
        .connect()
        .unwrap()
        .execute(
            "UPDATE storyboard_scripts SET text = 'human version', revision = 2 \
             WHERE storyboard_id = ?1",
            [fixture.storyboard_id.to_string()],
        )
        .unwrap();

    let error = service
        .apply(
            fixture.project_id,
            proposal.id,
            1,
            1,
            "apply-conflict-001".into(),
        )
        .await
        .expect_err("stale proposal must not apply");
    assert!(matches!(
        error,
        ProductError::RevisionConflict {
            expected: 1,
            actual: 2
        }
    ));
    let conflicted = service.get(fixture.project_id, proposal.id).await.unwrap();
    assert_eq!(
        (conflicted.status, conflicted.revision),
        (ProposalStatus::Conflicted, 2)
    );
    let rejected = service
        .reject(
            fixture.project_id,
            proposal.id,
            2,
            2,
            "reject-conflict-001".into(),
        )
        .await
        .unwrap();
    assert_eq!(rejected.status, ProposalStatus::Rejected);
    let script: String = fixture
        .database
        .connect()
        .unwrap()
        .query_row(
            "SELECT text FROM storyboard_scripts WHERE storyboard_id = ?1",
            [fixture.storyboard_id.to_string()],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(script, "human version");
}

#[tokio::test]
async fn missing_target_expires_proposal_and_source_creation_is_idempotent() {
    let fixture = ProposalFixture::new();
    let service = fixture.service();
    let command = fixture.command(
        ProposalTarget::MediaPrompt {
            media_id: fixture.media_id,
        },
        "new prompt",
        "expire-call",
    );
    let first = service.create(command.clone()).await.unwrap();
    let replay = service.create(command.clone()).await.unwrap();
    assert_eq!(first.id, replay.id);
    let mut changed = command;
    changed.proposed_value = "different proposal".into();
    assert!(matches!(
        service.create(changed).await.unwrap_err(),
        ProductError::Conflict {
            code: "PROPOSAL_SOURCE_REUSED",
            ..
        }
    ));

    fixture
        .database
        .connect()
        .unwrap()
        .execute(
            "UPDATE media_items SET deleted_at = ?1 WHERE id = ?2",
            params!["2026-09-26T01:00:00Z", fixture.media_id.to_string()],
        )
        .unwrap();
    let expired = service.get(fixture.project_id, first.id).await.unwrap();
    assert_eq!(expired.status, ProposalStatus::Expired);
    assert!(expired.resolved_at.is_some());
}
