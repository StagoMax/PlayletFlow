use super::{ChangeProposal, ProductError, ProductResult, ProposalStatus, ProposalTarget};
use chrono::{DateTime, Utc};

impl ProposalStatus {
    pub const fn as_storage_str(self) -> &'static str {
        match self {
            Self::Pending => "pending",
            Self::Applying => "applying",
            Self::Applied => "applied",
            Self::Rejected => "rejected",
            Self::Conflicted => "conflicted",
            Self::Expired => "expired",
            Self::Failed => "failed",
        }
    }

    pub fn from_api_str(value: &str) -> Option<Self> {
        match value {
            "pending" => Some(Self::Pending),
            "applying" => Some(Self::Applying),
            "applied" => Some(Self::Applied),
            "rejected" => Some(Self::Rejected),
            "conflicted" => Some(Self::Conflicted),
            "expired" => Some(Self::Expired),
            "failed" => Some(Self::Failed),
            _ => None,
        }
    }
}

impl ProposalTarget {
    pub const fn target_type(&self) -> &'static str {
        match self {
            Self::Script { .. } => "script",
            Self::MediaPrompt { .. } => "mediaPrompt",
            Self::AssetBindingPrompt { .. } => "assetBindingPrompt",
        }
    }

    pub fn target_id(&self) -> String {
        match self {
            Self::Script { storyboard_id } => storyboard_id.to_string(),
            Self::MediaPrompt { media_id } => media_id.to_string(),
            Self::AssetBindingPrompt { binding_id } => binding_id.to_string(),
        }
    }

    pub const fn creates_generation_job(&self) -> bool {
        !matches!(self, Self::Script { .. })
    }
}

impl ChangeProposal {
    pub fn transition(
        &mut self,
        next: ProposalStatus,
        occurred_at: DateTime<Utc>,
    ) -> ProductResult<()> {
        let allowed = matches!(
            (self.status, next),
            (ProposalStatus::Pending, ProposalStatus::Applying)
                | (ProposalStatus::Pending, ProposalStatus::Rejected)
                | (ProposalStatus::Pending, ProposalStatus::Conflicted)
                | (ProposalStatus::Pending, ProposalStatus::Expired)
                | (ProposalStatus::Pending, ProposalStatus::Failed)
                | (ProposalStatus::Applying, ProposalStatus::Applied)
                | (ProposalStatus::Applying, ProposalStatus::Pending)
                | (ProposalStatus::Applying, ProposalStatus::Conflicted)
                | (ProposalStatus::Applying, ProposalStatus::Expired)
                | (ProposalStatus::Applying, ProposalStatus::Failed)
                | (ProposalStatus::Conflicted, ProposalStatus::Rejected)
                | (ProposalStatus::Conflicted, ProposalStatus::Expired)
        );
        if !allowed {
            return Err(ProductError::Conflict {
                code: "INVALID_PROPOSAL_TRANSITION",
                message: format!(
                    "proposal cannot transition from {} to {}",
                    self.status.as_storage_str(),
                    next.as_storage_str()
                ),
            });
        }
        self.status = next;
        self.revision += 1;
        self.resolved_at = matches!(
            next,
            ProposalStatus::Applied
                | ProposalStatus::Rejected
                | ProposalStatus::Expired
                | ProposalStatus::Failed
        )
        .then_some(occurred_at);
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::product::domain::{ProjectId, ProposalId, ProposalSource, StoryboardId};
    use uuid::Uuid;

    fn proposal() -> ChangeProposal {
        let storyboard_id = StoryboardId::new();
        ChangeProposal {
            id: ProposalId::new(),
            project_id: ProjectId::new(),
            storyboard_id,
            target: ProposalTarget::Script { storyboard_id },
            base_revision: 1,
            before_value: "before".into(),
            proposed_value: "after".into(),
            summary: "summary".into(),
            status: ProposalStatus::Pending,
            source: ProposalSource {
                thread_id: Uuid::new_v4(),
                turn_id: Uuid::new_v4(),
                tool_call_id: "call-1".into(),
            },
            revision: 1,
            created_at: Utc::now(),
            resolved_at: None,
        }
    }

    #[test]
    fn state_machine_requires_applying_before_applied() {
        let mut proposal = proposal();
        assert!(proposal
            .transition(ProposalStatus::Applied, Utc::now())
            .is_err());
        proposal
            .transition(ProposalStatus::Applying, Utc::now())
            .unwrap();
        proposal
            .transition(ProposalStatus::Applied, Utc::now())
            .unwrap();
        assert_eq!(
            (proposal.status, proposal.revision),
            (ProposalStatus::Applied, 3)
        );
        assert!(proposal.resolved_at.is_some());
    }

    #[test]
    fn conflicted_proposal_can_be_rejected() {
        let mut proposal = proposal();
        proposal
            .transition(ProposalStatus::Conflicted, Utc::now())
            .unwrap();
        proposal
            .transition(ProposalStatus::Rejected, Utc::now())
            .unwrap();
        assert_eq!(proposal.status, ProposalStatus::Rejected);
    }
}
