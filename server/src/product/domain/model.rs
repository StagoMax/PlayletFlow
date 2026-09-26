use super::{
    AssetBindingId, AssetId, AssetRepresentationId, AssetSectionId, GenerationJobId,
    GenerationSpec, MediaId, OutboxEventId, ProjectId, ProposalId, StoryboardId,
};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use uuid::Uuid;

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum AssetKind {
    Character,
    Scene,
    Prop,
    Custom,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AssetSection {
    pub id: AssetSectionId,
    pub project_id: ProjectId,
    pub storyboard_id: StoryboardId,
    pub parent_id: Option<AssetSectionId>,
    pub name: String,
    pub kind: AssetKind,
    pub position: String,
    pub revision: i64,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum AssetViewKind {
    Front,
    Back,
    Side,
    Top,
    ThreeView,
    Custom,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AssetRepresentation {
    pub id: AssetRepresentationId,
    pub asset_id: AssetId,
    pub label: String,
    pub view_kind: AssetViewKind,
    pub media_id: Option<MediaId>,
    pub position: String,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Asset {
    pub id: AssetId,
    pub project_id: ProjectId,
    pub kind: AssetKind,
    pub name: String,
    pub description: Option<String>,
    pub canonical_prompt: Option<String>,
    pub revision: i64,
    pub representations: Vec<AssetRepresentation>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
    pub deleted_at: Option<DateTime<Utc>>,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AssetBinding {
    pub id: AssetBindingId,
    pub project_id: ProjectId,
    pub storyboard_id: StoryboardId,
    pub section_id: AssetSectionId,
    pub asset_id: AssetId,
    pub position: String,
    pub prompt_override: Option<String>,
    pub derived_media_id: Option<MediaId>,
    pub revision: i64,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, Hash, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ProposalStatus {
    Pending,
    Applying,
    Applied,
    Rejected,
    Conflicted,
    Expired,
    Failed,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    tag = "type"
)]
pub enum ProposalTarget {
    Script { storyboard_id: StoryboardId },
    MediaPrompt { media_id: MediaId },
    AssetBindingPrompt { binding_id: AssetBindingId },
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProposalSource {
    pub thread_id: Uuid,
    pub turn_id: Uuid,
    pub tool_call_id: String,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChangeProposal {
    pub id: ProposalId,
    pub project_id: ProjectId,
    pub storyboard_id: StoryboardId,
    pub target: ProposalTarget,
    pub base_revision: i64,
    pub before_value: String,
    pub proposed_value: String,
    pub summary: String,
    pub status: ProposalStatus,
    pub source: ProposalSource,
    pub revision: i64,
    pub created_at: DateTime<Utc>,
    pub resolved_at: Option<DateTime<Utc>>,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum GenerationStatus {
    Queued,
    WaitingForProvider,
    Running,
    Succeeded,
    Failed,
    Cancelled,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GenerationJob {
    pub id: GenerationJobId,
    pub project_id: ProjectId,
    pub storyboard_id: StoryboardId,
    /// Present when the job was created by accepting an AI proposal. Direct
    /// user-triggered generations intentionally have no proposal origin.
    pub proposal_id: Option<ProposalId>,
    pub target: ProposalTarget,
    pub target_revision: i64,
    pub spec: GenerationSpec,
    pub status: GenerationStatus,
    pub attempt: i64,
    pub provider: Option<String>,
    pub provider_job_id: Option<String>,
    pub result_media_id: Option<MediaId>,
    pub error: Option<String>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceThreadBinding {
    pub project_id: ProjectId,
    pub storyboard_id: StoryboardId,
    pub thread_id: Uuid,
    pub created_at: DateTime<Utc>,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OutboxEvent {
    pub id: OutboxEventId,
    pub project_id: ProjectId,
    pub event_type: String,
    pub payload: Value,
    pub occurred_at: DateTime<Utc>,
}
