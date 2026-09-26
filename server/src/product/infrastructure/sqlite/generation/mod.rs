mod completion;
mod mapping;
mod mutations;
pub(crate) mod storage;

#[cfg(test)]
mod tests;

use super::ProductDatabase;
use crate::product::application::generation::{
    ClaimedGenerationJob, GenerationCompletion, GenerationFailure, GenerationRepository,
    RequestMediaGeneration, RetryGenerationJob, RunningGenerationJob,
};
use crate::product::domain::{
    GenerationJob, GenerationJobId, ProductError, ProductResult, ProjectId,
};
use async_trait::async_trait;
use chrono::{DateTime, Utc};
use rusqlite::Connection;

#[derive(Clone, Debug)]
pub struct SqliteGenerationRepository {
    database: ProductDatabase,
}

impl SqliteGenerationRepository {
    pub fn new(database: ProductDatabase) -> Self {
        Self { database }
    }

    async fn run<T, F>(&self, operation: F) -> ProductResult<T>
    where
        T: Send + 'static,
        F: FnOnce(&mut Connection) -> ProductResult<T> + Send + 'static,
    {
        let database = self.database.clone();
        tokio::task::spawn_blocking(move || {
            let mut connection = database.connect()?;
            operation(&mut connection)
        })
        .await
        .map_err(|error| ProductError::Storage(error.to_string()))?
    }
}

#[async_trait]
impl GenerationRepository for SqliteGenerationRepository {
    async fn find(
        &self,
        project_id: ProjectId,
        job_id: GenerationJobId,
    ) -> ProductResult<Option<GenerationJob>> {
        self.run(move |connection| mapping::find(connection, project_id, job_id))
            .await
    }

    async fn retry(&self, command: RetryGenerationJob) -> ProductResult<GenerationJob> {
        self.run(move |connection| mutations::retry(connection, command))
            .await
    }

    async fn request_media(&self, command: RequestMediaGeneration) -> ProductResult<GenerationJob> {
        self.run(move |connection| mutations::request_media(connection, command))
            .await
    }

    async fn claim_next(
        &self,
        claimed_at: DateTime<Utc>,
        stale_before: DateTime<Utc>,
    ) -> ProductResult<Option<ClaimedGenerationJob>> {
        self.run(move |connection| mutations::claim_next(connection, claimed_at, stale_before))
            .await
    }

    async fn defer_claim(&self, claim: ClaimedGenerationJob) -> ProductResult<GenerationJob> {
        self.run(move |connection| mutations::defer_claim(connection, claim))
            .await
    }

    async fn mark_submitted(
        &self,
        claim: ClaimedGenerationJob,
        provider: String,
        provider_job_id: String,
    ) -> ProductResult<GenerationJob> {
        self.run(move |connection| {
            mutations::mark_submitted(connection, claim, provider, provider_job_id)
        })
        .await
    }

    async fn mark_submission_failed(
        &self,
        claim: ClaimedGenerationJob,
        provider: String,
        public_error: String,
    ) -> ProductResult<GenerationJob> {
        self.run(move |connection| {
            mutations::mark_submission_failed(connection, claim, provider, public_error)
        })
        .await
    }

    async fn list_running(
        &self,
        provider: &str,
        limit: usize,
    ) -> ProductResult<Vec<RunningGenerationJob>> {
        let provider = provider.to_owned();
        self.run(move |connection| completion::list_running(connection, &provider, limit))
            .await
    }

    async fn mark_succeeded(
        &self,
        completion: GenerationCompletion,
    ) -> ProductResult<GenerationJob> {
        self.run(move |connection| completion::mark_succeeded(connection, completion))
            .await
    }

    async fn mark_running_failed(
        &self,
        failure: GenerationFailure,
    ) -> ProductResult<GenerationJob> {
        self.run(move |connection| completion::mark_running_failed(connection, failure))
            .await
    }

    async fn mark_polled(&self, job: &GenerationJob) -> ProductResult<()> {
        let job = job.clone();
        self.run(move |connection| completion::mark_polled(connection, &job))
            .await
    }
}
