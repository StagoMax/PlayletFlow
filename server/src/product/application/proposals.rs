use super::idempotency::IdempotencyContext;
use crate::product::domain::{
    ChangeProposal, GenerationJob, GenerationOptions, ProductError, ProductResult, ProjectId,
    ProposalId, ProposalSource, ProposalStatus, ProposalTarget, StoryboardId,
};
use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use std::sync::Arc;

#[derive(Clone, Debug)]
pub struct CreateProposal {
    pub project_id: ProjectId,
    pub storyboard_id: StoryboardId,
    pub target: ProposalTarget,
    pub proposed_value: String,
    pub summary: String,
    pub source: ProposalSource,
}

#[derive(Clone, Debug, PartialEq)]
pub struct ProposalListQuery {
    pub project_id: ProjectId,
    pub storyboard_id: StoryboardId,
    pub statuses: Vec<ProposalStatus>,
}

#[derive(Clone, Debug)]
pub struct ResolveProposal {
    pub project_id: ProjectId,
    pub proposal_id: ProposalId,
    pub expected_proposal_revision: i64,
    pub expected_target_revision: i64,
    pub generation_options: Option<GenerationOptions>,
    pub idempotency: IdempotencyContext,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppliedTarget {
    pub target_type: String,
    pub revision: i64,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ApplyProposalResult {
    pub proposal: ChangeProposal,
    pub target: AppliedTarget,
    pub generation_job: Option<GenerationJob>,
}

#[async_trait]
pub trait ProposalRepository: Send + Sync {
    async fn create(&self, command: CreateProposal) -> ProductResult<ChangeProposal>;
    async fn list(&self, query: ProposalListQuery) -> ProductResult<Vec<ChangeProposal>>;
    async fn find(
        &self,
        project_id: ProjectId,
        proposal_id: ProposalId,
    ) -> ProductResult<Option<ChangeProposal>>;
    async fn apply(&self, command: ResolveProposal) -> ProductResult<ApplyProposalResult>;
    async fn reject(&self, command: ResolveProposal) -> ProductResult<ChangeProposal>;
}

#[derive(Clone)]
pub struct ProposalService {
    repository: Arc<dyn ProposalRepository>,
}

impl ProposalService {
    pub fn new(repository: Arc<dyn ProposalRepository>) -> Self {
        Self { repository }
    }

    pub async fn create(&self, mut command: CreateProposal) -> ProductResult<ChangeProposal> {
        command.summary = command.summary.trim().to_owned();
        validate_create(&command)?;
        self.repository.create(command).await
    }

    pub async fn list(&self, query: ProposalListQuery) -> ProductResult<Vec<ChangeProposal>> {
        self.repository.list(query).await
    }

    pub async fn get(
        &self,
        project_id: ProjectId,
        proposal_id: ProposalId,
    ) -> ProductResult<ChangeProposal> {
        self.repository
            .find(project_id, proposal_id)
            .await?
            .ok_or(ProductError::NotFound)
    }

    pub async fn apply(
        &self,
        project_id: ProjectId,
        proposal_id: ProposalId,
        expected_proposal_revision: i64,
        expected_target_revision: i64,
        idempotency_key: String,
    ) -> ProductResult<ApplyProposalResult> {
        self.apply_with_generation(
            project_id,
            proposal_id,
            expected_proposal_revision,
            expected_target_revision,
            None,
            idempotency_key,
        )
        .await
    }

    pub async fn apply_with_generation(
        &self,
        project_id: ProjectId,
        proposal_id: ProposalId,
        expected_proposal_revision: i64,
        expected_target_revision: i64,
        generation_options: Option<GenerationOptions>,
        idempotency_key: String,
    ) -> ProductResult<ApplyProposalResult> {
        validate_revisions(expected_proposal_revision, expected_target_revision)?;
        let fingerprint = (
            project_id,
            proposal_id,
            expected_proposal_revision,
            expected_target_revision,
            &generation_options,
        );
        let idempotency = IdempotencyContext::new(
            "POST /api/v1/projects/:projectId/proposals/:proposalId/apply",
            idempotency_key,
            &fingerprint,
            200,
        )?;
        self.repository
            .apply(ResolveProposal {
                project_id,
                proposal_id,
                expected_proposal_revision,
                expected_target_revision,
                generation_options,
                idempotency,
            })
            .await
    }

    pub async fn reject(
        &self,
        project_id: ProjectId,
        proposal_id: ProposalId,
        expected_proposal_revision: i64,
        expected_target_revision: i64,
        idempotency_key: String,
    ) -> ProductResult<ChangeProposal> {
        validate_revisions(expected_proposal_revision, expected_target_revision)?;
        let fingerprint = (
            project_id,
            proposal_id,
            expected_proposal_revision,
            expected_target_revision,
        );
        let idempotency = IdempotencyContext::new(
            "POST /api/v1/projects/:projectId/proposals/:proposalId/reject",
            idempotency_key,
            &fingerprint,
            200,
        )?;
        self.repository
            .reject(ResolveProposal {
                project_id,
                proposal_id,
                expected_proposal_revision,
                expected_target_revision,
                generation_options: None,
                idempotency,
            })
            .await
    }
}

fn validate_create(command: &CreateProposal) -> ProductResult<()> {
    if matches!(
        command.target,
        ProposalTarget::Script { storyboard_id } if storyboard_id != command.storyboard_id
    ) {
        return Err(ProductError::Validation(
            "script proposal target must be the current storyboard".into(),
        ));
    }
    let max_length = if matches!(command.target, ProposalTarget::Script { .. }) {
        20_000
    } else {
        10_000
    };
    if command.proposed_value.trim().is_empty()
        || command.proposed_value.chars().count() > max_length
    {
        return Err(ProductError::Validation(format!(
            "proposed value must contain 1 to {max_length} characters"
        )));
    }
    if command.summary.is_empty() || command.summary.chars().count() > 300 {
        return Err(ProductError::Validation(
            "summary must contain 1 to 300 characters".into(),
        ));
    }
    if command.source.tool_call_id.trim().is_empty()
        || command.source.tool_call_id.chars().count() > 500
    {
        return Err(ProductError::Validation(
            "toolCallId must contain 1 to 500 characters".into(),
        ));
    }
    Ok(())
}

fn validate_revisions(proposal_revision: i64, target_revision: i64) -> ProductResult<()> {
    if proposal_revision < 1 || target_revision < 1 {
        return Err(ProductError::Validation(
            "expected revisions must be at least 1".into(),
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use uuid::Uuid;

    #[test]
    fn validates_target_specific_proposed_values() {
        let storyboard_id = StoryboardId::new();
        let mut command = CreateProposal {
            project_id: ProjectId::new(),
            storyboard_id,
            target: ProposalTarget::Script { storyboard_id },
            proposed_value: " ".into(),
            summary: "summary".into(),
            source: ProposalSource {
                thread_id: Uuid::new_v4(),
                turn_id: Uuid::new_v4(),
                tool_call_id: "call-1".into(),
            },
        };
        assert!(validate_create(&command).is_err());
        command.proposed_value = "new script".into();
        assert!(validate_create(&command).is_ok());
    }
}
