use super::{
    GeneratedMediaStore, GenerationCompletion, GenerationFailure, GenerationInputResolver,
    GenerationPoll, GenerationProvider, GenerationRepository, GenerationSubmission,
    DEFAULT_CLAIM_TIMEOUT,
};
use crate::product::domain::{GenerationJobId, ProductError, ProductResult};
use chrono::{Duration, Utc};
use std::sync::Arc;

const PUBLIC_SUBMISSION_ERROR: &str = "generation provider submission failed";
const PUBLIC_RESULT_ERROR: &str = "generation provider processing failed";
const PUBLIC_STORAGE_ERROR: &str = "generated media could not be persisted";
const DEFAULT_POLL_BATCH_SIZE: usize = 32;

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum GenerationWorkerOutcome {
    Idle,
    WaitingForProvider { job_id: GenerationJobId },
    Submitted { job_id: GenerationJobId },
    Succeeded { job_id: GenerationJobId },
    Failed { job_id: GenerationJobId },
}

#[derive(Clone)]
pub struct GenerationWorker {
    repository: Arc<dyn GenerationRepository>,
    provider: Arc<dyn GenerationProvider>,
    media_store: Option<Arc<dyn GeneratedMediaStore>>,
    input_resolver: Option<Arc<dyn GenerationInputResolver>>,
    claim_timeout: Duration,
}

impl GenerationWorker {
    pub fn new(
        repository: Arc<dyn GenerationRepository>,
        provider: Arc<dyn GenerationProvider>,
    ) -> Self {
        Self {
            repository,
            provider,
            media_store: None,
            input_resolver: None,
            claim_timeout: DEFAULT_CLAIM_TIMEOUT,
        }
    }

    pub fn with_media_store(mut self, media_store: Arc<dyn GeneratedMediaStore>) -> Self {
        self.media_store = Some(media_store);
        self
    }

    pub fn with_input_resolver(mut self, resolver: Arc<dyn GenerationInputResolver>) -> Self {
        self.input_resolver = Some(resolver);
        self
    }

    #[cfg(test)]
    pub(crate) fn with_claim_timeout(mut self, claim_timeout: Duration) -> Self {
        self.claim_timeout = claim_timeout;
        self
    }

    pub async fn run_once(&self) -> ProductResult<GenerationWorkerOutcome> {
        let now = Utc::now();
        let Some(mut claim) = self
            .repository
            .claim_next(now, now - self.claim_timeout)
            .await?
        else {
            return Ok(GenerationWorkerOutcome::Idle);
        };
        let job_id = claim.request.job.id;
        if !claim.request.job.spec.input.media_ids().is_empty() {
            let Some(resolver) = &self.input_resolver else {
                self.repository.defer_claim(claim).await?;
                return Ok(GenerationWorkerOutcome::WaitingForProvider { job_id });
            };
            match resolver.resolve(&claim.request.job).await {
                Ok(inputs) => claim.request.inputs = inputs,
                Err(ProductError::DependencyUnavailable(error)) => {
                    eprintln!("generation inputs temporarily unavailable for {job_id}: {error}");
                    self.repository.defer_claim(claim).await?;
                    return Ok(GenerationWorkerOutcome::WaitingForProvider { job_id });
                }
                Err(error) => {
                    eprintln!("generation input resolution failed for {job_id}: {error}");
                    self.fail_submission(claim).await?;
                    return Ok(GenerationWorkerOutcome::Failed { job_id });
                }
            }
        }
        match self.provider.submit(&claim.request).await {
            Ok(submission) if submission.provider_job_id().trim().is_empty() => {
                self.fail_submission(claim).await?;
                Ok(GenerationWorkerOutcome::Failed { job_id })
            }
            Ok(GenerationSubmission::Pending { provider_job_id }) => {
                self.repository
                    .mark_submitted(claim, self.provider.name().to_owned(), provider_job_id)
                    .await?;
                Ok(GenerationWorkerOutcome::Submitted { job_id })
            }
            Ok(GenerationSubmission::Succeeded {
                provider_job_id,
                output,
            }) => {
                let job = self
                    .repository
                    .mark_submitted(claim, self.provider.name().to_owned(), provider_job_id)
                    .await?;
                match persist(self.media_store.as_ref(), job.id, &output).await {
                    Ok(output) => {
                        self.repository
                            .mark_succeeded(GenerationCompletion { job, output })
                            .await?;
                        Ok(GenerationWorkerOutcome::Succeeded { job_id })
                    }
                    Err(error) => {
                        eprintln!("generated media persistence failed for {job_id}: {error}");
                        self.repository
                            .mark_running_failed(GenerationFailure {
                                job,
                                public_error: PUBLIC_STORAGE_ERROR.into(),
                            })
                            .await?;
                        Ok(GenerationWorkerOutcome::Failed { job_id })
                    }
                }
            }
            Err(ProductError::DependencyUnavailable(error)) => {
                eprintln!("generation provider temporarily unavailable for {job_id}: {error}");
                self.repository.defer_claim(claim).await?;
                Ok(GenerationWorkerOutcome::WaitingForProvider { job_id })
            }
            Err(error) => {
                eprintln!("generation provider submission failed for {job_id}: {error}");
                self.fail_submission(claim).await?;
                Ok(GenerationWorkerOutcome::Failed { job_id })
            }
        }
    }

    async fn fail_submission(&self, claim: super::ClaimedGenerationJob) -> ProductResult<()> {
        self.repository
            .mark_submission_failed(
                claim,
                self.provider.name().to_owned(),
                PUBLIC_SUBMISSION_ERROR.into(),
            )
            .await?;
        Ok(())
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum GenerationMonitorOutcome {
    Idle,
    Pending { job_id: GenerationJobId },
    Succeeded { job_id: GenerationJobId },
    Failed { job_id: GenerationJobId },
}

#[derive(Clone)]
pub struct GenerationMonitor {
    repository: Arc<dyn GenerationRepository>,
    provider: Arc<dyn GenerationProvider>,
    media_store: Arc<dyn GeneratedMediaStore>,
    batch_size: usize,
}

impl GenerationMonitor {
    pub fn new(
        repository: Arc<dyn GenerationRepository>,
        provider: Arc<dyn GenerationProvider>,
        media_store: Arc<dyn GeneratedMediaStore>,
    ) -> Self {
        Self {
            repository,
            provider,
            media_store,
            batch_size: DEFAULT_POLL_BATCH_SIZE,
        }
    }

    pub async fn run_once(&self) -> ProductResult<Vec<GenerationMonitorOutcome>> {
        let jobs = self
            .repository
            .list_running(self.provider.name(), self.batch_size)
            .await?;
        if jobs.is_empty() {
            return Ok(vec![GenerationMonitorOutcome::Idle]);
        }
        let mut outcomes = Vec::with_capacity(jobs.len());
        for running in jobs {
            let job_id = running.job.id;
            let outcome = match self.provider.poll(&running.job, running.kind).await {
                Ok(GenerationPoll::Pending) => {
                    self.repository.mark_polled(&running.job).await?;
                    GenerationMonitorOutcome::Pending { job_id }
                }
                Ok(GenerationPoll::Succeeded(output)) => {
                    match self.media_store.store(job_id, &output).await {
                        Ok(output) => {
                            self.repository
                                .mark_succeeded(GenerationCompletion {
                                    job: running.job,
                                    output,
                                })
                                .await?;
                            GenerationMonitorOutcome::Succeeded { job_id }
                        }
                        Err(ProductError::DependencyUnavailable(error)) => {
                            eprintln!("generated media download deferred for {job_id}: {error}");
                            self.repository.mark_polled(&running.job).await?;
                            GenerationMonitorOutcome::Pending { job_id }
                        }
                        Err(error) => {
                            eprintln!("generated media persistence failed for {job_id}: {error}");
                            self.repository
                                .mark_running_failed(GenerationFailure {
                                    job: running.job,
                                    public_error: PUBLIC_STORAGE_ERROR.into(),
                                })
                                .await?;
                            GenerationMonitorOutcome::Failed { job_id }
                        }
                    }
                }
                Ok(GenerationPoll::Failed) => {
                    self.repository
                        .mark_running_failed(GenerationFailure {
                            job: running.job,
                            public_error: PUBLIC_RESULT_ERROR.into(),
                        })
                        .await?;
                    GenerationMonitorOutcome::Failed { job_id }
                }
                Err(ProductError::DependencyUnavailable(error)) => {
                    eprintln!("generation provider poll deferred for {job_id}: {error}");
                    self.repository.mark_polled(&running.job).await?;
                    GenerationMonitorOutcome::Pending { job_id }
                }
                Err(error) => {
                    eprintln!("generation provider poll failed for {job_id}: {error}");
                    self.repository
                        .mark_running_failed(GenerationFailure {
                            job: running.job,
                            public_error: PUBLIC_RESULT_ERROR.into(),
                        })
                        .await?;
                    GenerationMonitorOutcome::Failed { job_id }
                }
            };
            outcomes.push(outcome);
        }
        Ok(outcomes)
    }
}

async fn persist(
    store: Option<&Arc<dyn GeneratedMediaStore>>,
    job_id: GenerationJobId,
    output: &super::GenerationOutput,
) -> ProductResult<super::StoredGenerationOutput> {
    let store = store.ok_or_else(|| {
        ProductError::DependencyUnavailable("generated media store is not configured".into())
    })?;
    store.store(job_id, output).await
}
