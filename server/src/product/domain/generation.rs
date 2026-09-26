use super::{GenerationJob, GenerationStatus, MediaId, ProductError, ProductResult};
use chrono::{DateTime, Utc};

impl GenerationStatus {
    pub const fn as_storage_str(self) -> &'static str {
        match self {
            Self::Queued => "queued",
            Self::WaitingForProvider => "waitingForProvider",
            Self::Running => "running",
            Self::Succeeded => "succeeded",
            Self::Failed => "failed",
            Self::Cancelled => "cancelled",
        }
    }

    pub fn from_storage_str(value: &str) -> Option<Self> {
        match value {
            "queued" => Some(Self::Queued),
            "waitingForProvider" => Some(Self::WaitingForProvider),
            "running" => Some(Self::Running),
            "succeeded" => Some(Self::Succeeded),
            "failed" => Some(Self::Failed),
            "cancelled" => Some(Self::Cancelled),
            _ => None,
        }
    }
}

impl GenerationJob {
    pub fn claim(&mut self, occurred_at: DateTime<Utc>) -> ProductResult<()> {
        self.transition(GenerationStatus::Queued, occurred_at)
    }

    pub fn defer_for_provider(&mut self, occurred_at: DateTime<Utc>) -> ProductResult<()> {
        self.transition(GenerationStatus::WaitingForProvider, occurred_at)
    }

    pub fn mark_submitted(
        &mut self,
        provider: String,
        provider_job_id: String,
        occurred_at: DateTime<Utc>,
    ) -> ProductResult<()> {
        if provider.trim().is_empty() || provider_job_id.trim().is_empty() {
            return Err(ProductError::Validation(
                "provider and provider job id must not be empty".into(),
            ));
        }
        self.transition(GenerationStatus::Running, occurred_at)?;
        self.attempt += 1;
        self.provider = Some(provider);
        self.provider_job_id = Some(provider_job_id);
        self.error = None;
        Ok(())
    }

    pub fn mark_submission_failed(
        &mut self,
        public_error: String,
        occurred_at: DateTime<Utc>,
    ) -> ProductResult<()> {
        if public_error.trim().is_empty() {
            return Err(ProductError::Validation(
                "generation error must not be empty".into(),
            ));
        }
        self.transition(GenerationStatus::Failed, occurred_at)?;
        self.attempt += 1;
        self.provider_job_id = None;
        self.result_media_id = None;
        self.error = Some(public_error);
        Ok(())
    }

    pub fn mark_succeeded(
        &mut self,
        result_media_id: MediaId,
        occurred_at: DateTime<Utc>,
    ) -> ProductResult<()> {
        self.transition(GenerationStatus::Succeeded, occurred_at)?;
        self.result_media_id = Some(result_media_id);
        self.error = None;
        Ok(())
    }

    pub fn mark_processing_failed(
        &mut self,
        public_error: String,
        occurred_at: DateTime<Utc>,
    ) -> ProductResult<()> {
        if public_error.trim().is_empty() {
            return Err(ProductError::Validation(
                "generation error must not be empty".into(),
            ));
        }
        self.transition(GenerationStatus::Failed, occurred_at)?;
        self.result_media_id = None;
        self.error = Some(public_error);
        Ok(())
    }

    pub fn retry(&mut self, occurred_at: DateTime<Utc>) -> ProductResult<()> {
        self.transition(GenerationStatus::WaitingForProvider, occurred_at)?;
        self.provider = None;
        self.provider_job_id = None;
        self.result_media_id = None;
        self.error = None;
        Ok(())
    }

    pub fn cancel(
        &mut self,
        public_error: String,
        occurred_at: DateTime<Utc>,
    ) -> ProductResult<()> {
        if public_error.trim().is_empty() {
            return Err(ProductError::Validation(
                "generation cancellation reason must not be empty".into(),
            ));
        }
        self.transition(GenerationStatus::Cancelled, occurred_at)?;
        self.provider_job_id = None;
        self.result_media_id = None;
        self.error = Some(public_error);
        Ok(())
    }

    fn transition(
        &mut self,
        next: GenerationStatus,
        occurred_at: DateTime<Utc>,
    ) -> ProductResult<()> {
        let allowed = matches!(
            (self.status, next),
            (
                GenerationStatus::WaitingForProvider,
                GenerationStatus::Queued
            ) | (
                GenerationStatus::Queued,
                GenerationStatus::WaitingForProvider
            ) | (GenerationStatus::Queued, GenerationStatus::Running)
                | (GenerationStatus::Queued, GenerationStatus::Failed)
                | (
                    GenerationStatus::WaitingForProvider,
                    GenerationStatus::Cancelled
                )
                | (GenerationStatus::Queued, GenerationStatus::Cancelled)
                | (GenerationStatus::Running, GenerationStatus::Succeeded)
                | (GenerationStatus::Running, GenerationStatus::Failed)
                | (GenerationStatus::Running, GenerationStatus::Cancelled)
                | (
                    GenerationStatus::Failed,
                    GenerationStatus::WaitingForProvider
                )
        );
        if !allowed {
            return Err(ProductError::Conflict {
                code: "INVALID_GENERATION_TRANSITION",
                message: format!(
                    "generation job cannot transition from {} to {}",
                    self.status.as_storage_str(),
                    next.as_storage_str()
                ),
            });
        }
        self.status = next;
        self.updated_at = occurred_at;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::product::domain::{
        GenerationInputSelection, GenerationJobId, GenerationSpec, MediaId, ProjectId, ProposalId,
        ProposalTarget, StoryboardId,
    };

    fn waiting_job() -> GenerationJob {
        let now = Utc::now();
        GenerationJob {
            id: GenerationJobId::new(),
            project_id: ProjectId::new(),
            storyboard_id: StoryboardId::new(),
            proposal_id: Some(ProposalId::new()),
            target: ProposalTarget::MediaPrompt {
                media_id: MediaId::new(),
            },
            target_revision: 2,
            spec: GenerationSpec {
                model: "doubao-seedream-5-0-pro-260628".into(),
                input: GenerationInputSelection::TextOnly,
                image_size: Some("2K".into()),
                video_resolution: None,
                video_ratio: None,
                duration_seconds: None,
                generate_audio: None,
            },
            status: GenerationStatus::WaitingForProvider,
            attempt: 0,
            provider: None,
            provider_job_id: None,
            result_media_id: None,
            error: None,
            created_at: now,
            updated_at: now,
        }
    }

    #[test]
    fn dispatch_and_retry_follow_the_state_machine() {
        let mut job = waiting_job();
        job.claim(Utc::now()).unwrap();
        job.mark_submission_failed("provider request failed".into(), Utc::now())
            .unwrap();
        assert_eq!((job.status, job.attempt), (GenerationStatus::Failed, 1));
        job.retry(Utc::now()).unwrap();
        job.claim(Utc::now()).unwrap();
        job.mark_submitted("provider-a".into(), "remote-1".into(), Utc::now())
            .unwrap();
        assert_eq!((job.status, job.attempt), (GenerationStatus::Running, 2));
        assert_eq!(job.provider_job_id.as_deref(), Some("remote-1"));
    }

    #[test]
    fn final_and_unclaimed_jobs_cannot_be_retried_or_submitted() {
        let mut job = waiting_job();
        assert!(job.retry(Utc::now()).is_err());
        assert!(job
            .mark_submitted("provider-a".into(), "remote-1".into(), Utc::now())
            .is_err());
    }
}
