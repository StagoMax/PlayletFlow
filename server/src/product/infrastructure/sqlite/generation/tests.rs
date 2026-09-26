use super::SqliteGenerationRepository;
use crate::product::application::generation::{
    resolve_generation_spec, GeneratedMediaStore, GenerationMonitor, GenerationMonitorOutcome,
    GenerationOutput, GenerationPoll, GenerationProvider, GenerationRequest, GenerationService,
    GenerationSubmission, GenerationWorker, GenerationWorkerOutcome, StoredGenerationOutput,
};
use crate::product::domain::{
    GenerationJob, GenerationJobId, GenerationStatus, MediaId, MediaKind, ProductError,
    ProductResult, ProjectId, ProposalId, StoryboardId,
};
use crate::product::infrastructure::sqlite::ProductDatabase;
use crate::product::infrastructure::WaitingForProviderAdapter;
use async_trait::async_trait;
use chrono::Duration;
use rusqlite::params;
use std::path::PathBuf;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use uuid::Uuid;

struct GenerationFixture {
    database: ProductDatabase,
    path: PathBuf,
    project_id: ProjectId,
    job_id: GenerationJobId,
}

impl GenerationFixture {
    fn new() -> Self {
        let path =
            std::env::temp_dir().join(format!("videoflow-generation-{}.sqlite", Uuid::new_v4()));
        let database = ProductDatabase::open(&path).unwrap();
        let fixture = Self {
            database,
            path,
            project_id: ProjectId::new(),
            job_id: GenerationJobId::new(),
        };
        fixture.seed_waiting_job();
        fixture
    }

    fn repository(&self) -> Arc<SqliteGenerationRepository> {
        Arc::new(SqliteGenerationRepository::new(self.database.clone()))
    }

    fn service(&self) -> GenerationService {
        GenerationService::new(self.repository())
    }

    async fn job(&self) -> GenerationJob {
        self.service()
            .get(self.project_id, self.job_id)
            .await
            .unwrap()
    }

    fn seed_waiting_job(&self) {
        let connection = self.database.connect().unwrap();
        let storyboard_id = StoryboardId::new();
        let proposal_id = ProposalId::new();
        let media_id = MediaId::new();
        let now = "2026-09-26T00:00:00+00:00";
        connection
            .execute(
                "INSERT INTO projects (id, name, revision, created_at, updated_at) \
                 VALUES (?1, 'Generation worker', 1, ?2, ?2)",
                params![self.project_id.to_string(), now],
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO storyboards \
                 (id, project_id, name, position, revision, created_at, updated_at) \
                 VALUES (?1, ?2, 'Shot', 'a', 1, ?3, ?3)",
                params![storyboard_id.to_string(), self.project_id.to_string(), now],
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO media_items \
                 (id, project_id, storyboard_id, kind, role, name, prompt, mime_type, status, revision, created_at, updated_at) \
                 VALUES (?1, ?2, ?3, 'image', 'keyframe', 'Frame', 'new prompt', 'image/webp', 'ready', 2, ?4, ?4)",
                params![
                    media_id.to_string(),
                    self.project_id.to_string(),
                    storyboard_id.to_string(),
                    now
                ],
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO change_proposals \
                 (id, project_id, storyboard_id, target_type, target_id, base_revision, before_value, proposed_value, \
                  summary, status, source_thread_id, source_turn_id, source_tool_call_id, revision, created_at, resolved_at) \
                 VALUES (?1, ?2, ?3, 'mediaPrompt', ?4, 1, 'old prompt', 'new prompt', 'summary', \
                         'applied', ?5, ?6, 'call', 3, ?7, ?7)",
                params![
                    proposal_id.to_string(),
                    self.project_id.to_string(),
                    storyboard_id.to_string(),
                    media_id.to_string(),
                    Uuid::new_v4().to_string(),
                    Uuid::new_v4().to_string(),
                    now
                ],
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO generation_jobs \
                 (id, project_id, storyboard_id, proposal_id, target_type, target_id, target_revision, \
                  generation_spec_json, status, attempt, created_at, updated_at) \
                 VALUES (?1, ?2, ?3, ?4, 'mediaPrompt', ?5, 2, ?6, 'waitingForProvider', 0, ?7, ?7)",
                params![
                    self.job_id.to_string(),
                    self.project_id.to_string(),
                    storyboard_id.to_string(),
                    proposal_id.to_string(),
                    media_id.to_string(),
                    serde_json::to_string(
                        &resolve_generation_spec(MediaKind::Image, None).unwrap()
                    )
                    .unwrap(),
                    now
                ],
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO product_outbox_events \
                 (id, project_id, event_type, payload_json, occurred_at) \
                 VALUES (?1, ?2, 'generation.requested', ?3, ?4)",
                params![
                    Uuid::new_v4().to_string(),
                    self.project_id.to_string(),
                    serde_json::json!({ "generationJobId": self.job_id }).to_string(),
                    now
                ],
            )
            .unwrap();
    }

    fn scalar(&self, sql: &str) -> i64 {
        self.database
            .connect()
            .unwrap()
            .query_row(sql, [], |row| row.get(0))
            .unwrap()
    }
}

impl Drop for GenerationFixture {
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

#[derive(Default)]
struct SuccessProvider {
    calls: AtomicUsize,
}

#[async_trait]
impl GenerationProvider for SuccessProvider {
    fn name(&self) -> &str {
        "test-provider"
    }

    async fn submit(&self, request: &GenerationRequest) -> ProductResult<GenerationSubmission> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        assert_eq!(request.prompt, "new prompt");
        Ok(GenerationSubmission::Pending {
            provider_job_id: format!("remote-{}", request.job.id),
        })
    }
}

struct FailingProvider;

#[async_trait]
impl GenerationProvider for FailingProvider {
    fn name(&self) -> &str {
        "failing-provider"
    }

    async fn submit(&self, _request: &GenerationRequest) -> ProductResult<GenerationSubmission> {
        Err(ProductError::External(
            "secret provider response that must not be persisted".into(),
        ))
    }
}

struct ImmediateImageProvider;

#[async_trait]
impl GenerationProvider for ImmediateImageProvider {
    fn name(&self) -> &str {
        "image-provider"
    }

    async fn submit(&self, request: &GenerationRequest) -> ProductResult<GenerationSubmission> {
        Ok(GenerationSubmission::Succeeded {
            provider_job_id: format!("image-{}", request.job.id),
            output: GenerationOutput {
                url: "https://provider.example/result.jpg".into(),
                kind: MediaKind::Image,
                mime_type: "image/jpeg".into(),
                width: Some(1920),
                height: Some(1080),
                duration_ms: None,
            },
        })
    }
}

struct TestMediaStore;

#[async_trait]
impl GeneratedMediaStore for TestMediaStore {
    async fn store(
        &self,
        job_id: GenerationJobId,
        output: &GenerationOutput,
    ) -> ProductResult<StoredGenerationOutput> {
        Ok(StoredGenerationOutput {
            object_key: format!("generated/{job_id}.jpg"),
            kind: output.kind,
            mime_type: output.mime_type.clone(),
            width: output.width,
            height: output.height,
            duration_ms: output.duration_ms,
        })
    }
}

struct CompletingProvider;

#[async_trait]
impl GenerationProvider for CompletingProvider {
    fn name(&self) -> &str {
        "test-provider"
    }

    async fn submit(&self, _request: &GenerationRequest) -> ProductResult<GenerationSubmission> {
        unreachable!("the completion provider is only used for polling")
    }

    async fn poll(&self, _job: &GenerationJob, kind: MediaKind) -> ProductResult<GenerationPoll> {
        Ok(GenerationPoll::Succeeded(GenerationOutput {
            url: "https://provider.example/result.jpg".into(),
            kind,
            mime_type: "image/jpeg".into(),
            width: Some(1920),
            height: Some(1080),
            duration_ms: None,
        }))
    }
}

#[tokio::test]
async fn unavailable_provider_defers_without_consuming_the_event_or_attempt() {
    let fixture = GenerationFixture::new();
    let worker = GenerationWorker::new(fixture.repository(), Arc::new(WaitingForProviderAdapter));

    let outcome = worker.run_once().await.unwrap();
    assert_eq!(
        outcome,
        GenerationWorkerOutcome::WaitingForProvider {
            job_id: fixture.job_id
        }
    );
    let job = fixture.job().await;
    assert_eq!(
        (job.status, job.attempt),
        (GenerationStatus::WaitingForProvider, 0)
    );
    assert_eq!(
        fixture.scalar(
            "SELECT COUNT(*) FROM product_outbox_events \
             WHERE event_type = 'generation.requested' AND published_at IS NULL"
        ),
        1
    );
}

#[tokio::test]
async fn successful_dispatch_consumes_once_and_records_provider_identity() {
    let fixture = GenerationFixture::new();
    let provider = Arc::new(SuccessProvider::default());
    let worker = GenerationWorker::new(fixture.repository(), provider.clone());

    assert_eq!(
        worker.run_once().await.unwrap(),
        GenerationWorkerOutcome::Submitted {
            job_id: fixture.job_id
        }
    );
    assert_eq!(
        worker.run_once().await.unwrap(),
        GenerationWorkerOutcome::Idle
    );
    assert_eq!(provider.calls.load(Ordering::SeqCst), 1);
    let job = fixture.job().await;
    assert_eq!((job.status, job.attempt), (GenerationStatus::Running, 1));
    assert_eq!(job.provider.as_deref(), Some("test-provider"));
    assert!(job.provider_job_id.is_some());
    assert_eq!(
        fixture.scalar(
            "SELECT COUNT(*) FROM product_outbox_events \
             WHERE event_type = 'generation.requested' AND published_at IS NOT NULL"
        ),
        1
    );
}

#[tokio::test]
async fn synchronous_image_result_is_persisted_and_completes_the_job() {
    let fixture = GenerationFixture::new();
    let worker = GenerationWorker::new(fixture.repository(), Arc::new(ImmediateImageProvider))
        .with_media_store(Arc::new(TestMediaStore));

    assert_eq!(
        worker.run_once().await.unwrap(),
        GenerationWorkerOutcome::Succeeded {
            job_id: fixture.job_id
        }
    );
    let job = fixture.job().await;
    assert_eq!(job.status, GenerationStatus::Succeeded);
    assert_eq!(job.provider.as_deref(), Some("image-provider"));
    let result_media_id = job.result_media_id.expect("result media id");
    let result: (String, String, String, i64, i64) = fixture
        .database
        .connect()
        .unwrap()
        .query_row(
            "SELECT status, prompt, source_object_key, width, height FROM media_items WHERE id = ?1",
            [result_media_id.to_string()],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?)),
        )
        .unwrap();
    assert_eq!(
        result,
        (
            "ready".into(),
            "new prompt".into(),
            format!("generated/{}.jpg", fixture.job_id),
            1920,
            1080,
        )
    );
}

#[tokio::test]
async fn asynchronous_provider_result_is_polled_and_completes_the_job() {
    let fixture = GenerationFixture::new();
    let submitter =
        GenerationWorker::new(fixture.repository(), Arc::new(SuccessProvider::default()));
    assert!(matches!(
        submitter.run_once().await.unwrap(),
        GenerationWorkerOutcome::Submitted { .. }
    ));
    let monitor = GenerationMonitor::new(
        fixture.repository(),
        Arc::new(CompletingProvider),
        Arc::new(TestMediaStore),
    );

    assert_eq!(
        monitor.run_once().await.unwrap(),
        vec![GenerationMonitorOutcome::Succeeded {
            job_id: fixture.job_id
        }]
    );
    let job = fixture.job().await;
    assert_eq!(job.status, GenerationStatus::Succeeded);
    assert!(job.result_media_id.is_some());
}

#[tokio::test]
async fn failed_submission_can_be_replayed_once_then_dispatched_again() {
    let fixture = GenerationFixture::new();
    let failing_worker = GenerationWorker::new(fixture.repository(), Arc::new(FailingProvider));
    assert_eq!(
        failing_worker.run_once().await.unwrap(),
        GenerationWorkerOutcome::Failed {
            job_id: fixture.job_id
        }
    );
    let failed = fixture.job().await;
    assert_eq!(
        (failed.status, failed.attempt),
        (GenerationStatus::Failed, 1)
    );
    assert_eq!(
        failed.error.as_deref(),
        Some("generation provider submission failed")
    );
    assert!(!failed.error.unwrap().contains("secret"));

    let service = fixture.service();
    for _ in 0..2 {
        let retried = service
            .retry(
                fixture.project_id,
                fixture.job_id,
                "generation-retry-key".into(),
            )
            .await
            .unwrap();
        assert_eq!(
            (retried.status, retried.attempt),
            (GenerationStatus::WaitingForProvider, 1)
        );
    }
    assert_eq!(
        fixture.scalar(
            "SELECT COUNT(*) FROM product_outbox_events WHERE event_type = 'generation.requested'"
        ),
        2,
        "idempotent replay must not enqueue another request"
    );

    let success = Arc::new(SuccessProvider::default());
    let worker = GenerationWorker::new(fixture.repository(), success.clone());
    assert!(matches!(
        worker.run_once().await.unwrap(),
        GenerationWorkerOutcome::Submitted { .. }
    ));
    let running = fixture.job().await;
    assert_eq!(
        (running.status, running.attempt),
        (GenerationStatus::Running, 2)
    );
    assert_eq!(success.calls.load(Ordering::SeqCst), 1);

    let not_retryable = service
        .retry(
            fixture.project_id,
            fixture.job_id,
            "another-retry-key".into(),
        )
        .await
        .unwrap_err();
    assert!(matches!(
        not_retryable,
        ProductError::Conflict {
            code: "GENERATION_NOT_RETRYABLE",
            ..
        }
    ));
}

#[tokio::test]
async fn stale_queued_claim_is_recovered_after_worker_interruption() {
    let fixture = GenerationFixture::new();
    fixture
        .database
        .connect()
        .unwrap()
        .execute(
            "UPDATE generation_jobs SET status = 'queued', updated_at = '2020-01-01T00:00:00+00:00' \
             WHERE id = ?1",
            [fixture.job_id.to_string()],
        )
        .unwrap();
    let provider = Arc::new(SuccessProvider::default());
    let worker = GenerationWorker::new(fixture.repository(), provider.clone())
        .with_claim_timeout(Duration::seconds(1));

    assert!(matches!(
        worker.run_once().await.unwrap(),
        GenerationWorkerOutcome::Submitted { .. }
    ));
    assert_eq!(fixture.job().await.status, GenerationStatus::Running);
    assert_eq!(provider.calls.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn retry_rejects_a_job_when_its_bound_target_revision_changed() {
    let fixture = GenerationFixture::new();
    let worker = GenerationWorker::new(fixture.repository(), Arc::new(FailingProvider));
    assert!(matches!(
        worker.run_once().await.unwrap(),
        GenerationWorkerOutcome::Failed { .. }
    ));
    fixture
        .database
        .connect()
        .unwrap()
        .execute(
            "UPDATE media_items SET prompt = 'newer prompt', revision = revision + 1",
            [],
        )
        .unwrap();

    let error = fixture
        .service()
        .retry(
            fixture.project_id,
            fixture.job_id,
            "changed-target-retry".into(),
        )
        .await
        .unwrap_err();
    assert!(matches!(
        error,
        ProductError::Conflict {
            code: "GENERATION_TARGET_CHANGED",
            ..
        }
    ));
    assert_eq!(fixture.job().await.status, GenerationStatus::Failed);
    assert_eq!(
        fixture.scalar(
            "SELECT COUNT(*) FROM product_outbox_events WHERE event_type = 'generation.requested'"
        ),
        1
    );
}

#[tokio::test]
async fn stale_waiting_job_is_cancelled_without_calling_the_provider() {
    let fixture = GenerationFixture::new();
    fixture
        .database
        .connect()
        .unwrap()
        .execute("UPDATE media_items SET revision = revision + 1", [])
        .unwrap();
    let provider = Arc::new(SuccessProvider::default());
    let worker = GenerationWorker::new(fixture.repository(), provider.clone());

    assert_eq!(
        worker.run_once().await.unwrap(),
        GenerationWorkerOutcome::Idle
    );
    assert_eq!(provider.calls.load(Ordering::SeqCst), 0);
    let job = fixture.job().await;
    assert_eq!(job.status, GenerationStatus::Cancelled);
    assert_eq!(job.attempt, 0);
    assert_eq!(
        job.error.as_deref(),
        Some("generation target changed before submission")
    );
    assert_eq!(
        fixture.scalar(
            "SELECT COUNT(*) FROM product_outbox_events \
             WHERE event_type = 'generation.requested' AND published_at IS NOT NULL"
        ),
        1
    );
}
