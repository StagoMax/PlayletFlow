mod catalog;
mod input_resolver;
mod worker;

pub use catalog::{generation_models, resolve_generation_spec, GenerationModel};
pub use input_resolver::MediaGenerationInputResolver;
pub use worker::{
    GenerationMonitor, GenerationMonitorOutcome, GenerationWorker, GenerationWorkerOutcome,
};

use super::idempotency::IdempotencyContext;
use crate::product::domain::{
    GenerationJob, GenerationJobId, GenerationOptions, MediaId, MediaKind, OutboxEventId,
    ProductError, ProductResult, ProjectId, ResolvedGenerationInput, StoryboardId,
};
use async_trait::async_trait;
use chrono::{DateTime, Duration, Utc};
use serde::Serialize;
use std::sync::Arc;

#[derive(Clone, Debug)]
pub struct RetryGenerationJob {
    pub project_id: ProjectId,
    pub job_id: GenerationJobId,
    pub idempotency: IdempotencyContext,
}

#[derive(Clone, Debug)]
pub struct RequestMediaGeneration {
    pub project_id: ProjectId,
    pub storyboard_id: StoryboardId,
    pub media_id: MediaId,
    pub prompt: String,
    pub expected_revision: i64,
    pub generation_options: Option<GenerationOptions>,
    pub idempotency: IdempotencyContext,
}

#[derive(Clone, Debug)]
pub struct RequestMediaGenerationInput {
    pub project_id: ProjectId,
    pub storyboard_id: StoryboardId,
    pub media_id: MediaId,
    pub prompt: String,
    pub expected_revision: i64,
    pub generation_options: Option<GenerationOptions>,
    pub idempotency_key: String,
}

#[derive(Clone, Debug)]
pub struct ClaimedGenerationJob {
    pub event_id: OutboxEventId,
    pub request: GenerationRequest,
}

#[derive(Clone, Debug)]
pub struct GenerationRequest {
    pub job: GenerationJob,
    pub prompt: String,
    pub kind: MediaKind,
    pub inputs: Vec<ResolvedGenerationInput>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum GenerationSubmission {
    Pending {
        provider_job_id: String,
    },
    Succeeded {
        provider_job_id: String,
        output: GenerationOutput,
    },
}

impl GenerationSubmission {
    pub fn provider_job_id(&self) -> &str {
        match self {
            Self::Pending { provider_job_id }
            | Self::Succeeded {
                provider_job_id, ..
            } => provider_job_id,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct GenerationOutput {
    pub url: String,
    pub kind: MediaKind,
    pub mime_type: String,
    pub width: Option<i64>,
    pub height: Option<i64>,
    pub duration_ms: Option<i64>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum GenerationPoll {
    Pending,
    Succeeded(GenerationOutput),
    Failed,
}

#[derive(Clone, Debug, PartialEq)]
pub struct RunningGenerationJob {
    pub job: GenerationJob,
    pub kind: MediaKind,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct StoredGenerationOutput {
    pub object_key: String,
    pub kind: MediaKind,
    pub mime_type: String,
    pub width: Option<i64>,
    pub height: Option<i64>,
    pub duration_ms: Option<i64>,
}

#[async_trait]
pub trait GeneratedMediaStore: Send + Sync {
    /// Persist the provider's short-lived URL before it expires. Implementations
    /// must make repeated writes for the same job safe.
    async fn store(
        &self,
        job_id: GenerationJobId,
        output: &GenerationOutput,
    ) -> ProductResult<StoredGenerationOutput>;
}

#[async_trait]
pub trait GenerationInputResolver: Send + Sync {
    async fn resolve(&self, job: &GenerationJob) -> ProductResult<Vec<ResolvedGenerationInput>>;
}

#[derive(Clone, Debug, PartialEq)]
pub struct GenerationCompletion {
    pub job: GenerationJob,
    pub output: StoredGenerationOutput,
}

#[derive(Clone, Debug, PartialEq)]
pub struct GenerationFailure {
    pub job: GenerationJob,
    pub public_error: String,
}

#[async_trait]
pub trait GenerationRepository: Send + Sync {
    async fn find(
        &self,
        project_id: ProjectId,
        job_id: GenerationJobId,
    ) -> ProductResult<Option<GenerationJob>>;

    async fn retry(&self, command: RetryGenerationJob) -> ProductResult<GenerationJob>;

    async fn request_media(&self, command: RequestMediaGeneration) -> ProductResult<GenerationJob>;

    async fn claim_next(
        &self,
        claimed_at: DateTime<Utc>,
        stale_before: DateTime<Utc>,
    ) -> ProductResult<Option<ClaimedGenerationJob>>;

    async fn defer_claim(&self, claim: ClaimedGenerationJob) -> ProductResult<GenerationJob>;

    async fn mark_submitted(
        &self,
        claim: ClaimedGenerationJob,
        provider: String,
        provider_job_id: String,
    ) -> ProductResult<GenerationJob>;

    async fn mark_submission_failed(
        &self,
        claim: ClaimedGenerationJob,
        provider: String,
        public_error: String,
    ) -> ProductResult<GenerationJob>;

    async fn list_running(
        &self,
        provider: &str,
        limit: usize,
    ) -> ProductResult<Vec<RunningGenerationJob>>;

    async fn mark_succeeded(
        &self,
        completion: GenerationCompletion,
    ) -> ProductResult<GenerationJob>;

    async fn mark_running_failed(&self, failure: GenerationFailure)
        -> ProductResult<GenerationJob>;

    async fn mark_polled(&self, job: &GenerationJob) -> ProductResult<()>;
}

#[async_trait]
pub trait GenerationProvider: Send + Sync {
    fn name(&self) -> &str;

    /// `prompt` is verified against `target_revision` while the outbox event
    /// is claimed. Providers should pass `request.job.id` as their request
    /// correlation/idempotency value whenever the upstream API supports one.
    async fn submit(&self, request: &GenerationRequest) -> ProductResult<GenerationSubmission>;

    async fn poll(&self, _job: &GenerationJob, _kind: MediaKind) -> ProductResult<GenerationPoll> {
        Err(ProductError::DependencyUnavailable(
            "generation provider does not support polling".into(),
        ))
    }
}

#[derive(Clone)]
pub struct GenerationService {
    repository: Arc<dyn GenerationRepository>,
}

impl GenerationService {
    pub fn new(repository: Arc<dyn GenerationRepository>) -> Self {
        Self { repository }
    }

    pub async fn get(
        &self,
        project_id: ProjectId,
        job_id: GenerationJobId,
    ) -> ProductResult<GenerationJob> {
        self.repository
            .find(project_id, job_id)
            .await?
            .ok_or(ProductError::NotFound)
    }

    pub async fn retry(
        &self,
        project_id: ProjectId,
        job_id: GenerationJobId,
        idempotency_key: String,
    ) -> ProductResult<GenerationJob> {
        #[derive(Serialize)]
        struct Fingerprint {
            project_id: ProjectId,
            job_id: GenerationJobId,
        }

        let idempotency = IdempotencyContext::new(
            "POST /api/v1/projects/:projectId/generation-jobs/:jobId/retry",
            idempotency_key,
            &Fingerprint { project_id, job_id },
            202,
        )?;
        self.repository
            .retry(RetryGenerationJob {
                project_id,
                job_id,
                idempotency,
            })
            .await
    }

    pub async fn request_media(
        &self,
        input: RequestMediaGenerationInput,
    ) -> ProductResult<GenerationJob> {
        let RequestMediaGenerationInput {
            project_id,
            storyboard_id,
            media_id,
            prompt,
            expected_revision,
            generation_options,
            idempotency_key,
        } = input;
        let prompt = prompt.trim().to_owned();
        if prompt.is_empty() || prompt.chars().count() > 10_000 {
            return Err(ProductError::Validation(
                "generation prompt must contain between 1 and 10,000 characters".into(),
            ));
        }
        if expected_revision < 1 {
            return Err(ProductError::Validation(
                "expectedRevision must be at least 1".into(),
            ));
        }
        #[derive(Serialize)]
        struct Fingerprint<'a> {
            project_id: ProjectId,
            storyboard_id: StoryboardId,
            media_id: MediaId,
            prompt: &'a str,
            expected_revision: i64,
            generation: &'a Option<GenerationOptions>,
        }
        let idempotency = IdempotencyContext::new(
            "POST /api/v1/projects/:projectId/storyboards/:storyboardId/media/:mediaId/generations",
            idempotency_key,
            &Fingerprint {
                project_id,
                storyboard_id,
                media_id,
                prompt: &prompt,
                expected_revision,
                generation: &generation_options,
            },
            202,
        )?;
        self.repository
            .request_media(RequestMediaGeneration {
                project_id,
                storyboard_id,
                media_id,
                prompt,
                expected_revision,
                generation_options,
                idempotency,
            })
            .await
    }
}

pub(crate) const DEFAULT_CLAIM_TIMEOUT: Duration = Duration::minutes(5);
