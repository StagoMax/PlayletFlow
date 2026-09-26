use crate::product::application::idempotency::IdempotencyContext;
use crate::product::domain::{
    validate_name, validate_revision, ProductError, ProductResult, ProjectId, StoryboardId,
    WorkspaceNode, WorkspaceNodeKind, WorkspaceObjectType, MAX_WORKSPACE_NODE_NAME_CHARS,
};
use async_trait::async_trait;
use chrono::Utc;
use serde::Serialize;
use std::sync::Arc;

#[derive(Clone, Debug)]
pub struct CreateWorkspaceNode {
    pub node: WorkspaceNode,
    pub idempotency: IdempotencyContext,
}

#[derive(Clone, Debug)]
pub struct UpdateWorkspaceNode {
    pub project_id: ProjectId,
    pub storyboard_id: StoryboardId,
    pub node_id: String,
    pub parent_id: Option<String>,
    pub name: String,
    pub expected_revision: i64,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateWorkspaceNodeInput {
    pub project_id: ProjectId,
    pub storyboard_id: StoryboardId,
    pub parent_id: Option<String>,
    pub kind: WorkspaceNodeKind,
    pub name: String,
    pub object_type: Option<WorkspaceObjectType>,
}

#[async_trait]
pub trait WorkspaceNodeRepository: Send + Sync {
    async fn list(
        &self,
        project_id: ProjectId,
        storyboard_id: StoryboardId,
    ) -> ProductResult<Vec<WorkspaceNode>>;
    async fn create(&self, command: CreateWorkspaceNode) -> ProductResult<WorkspaceNode>;
    async fn update(&self, command: UpdateWorkspaceNode) -> ProductResult<WorkspaceNode>;
}

#[derive(Clone)]
pub struct WorkspaceNodeService {
    repository: Arc<dyn WorkspaceNodeRepository>,
}

impl WorkspaceNodeService {
    pub fn new(repository: Arc<dyn WorkspaceNodeRepository>) -> Self {
        Self { repository }
    }

    pub async fn list(
        &self,
        project_id: ProjectId,
        storyboard_id: StoryboardId,
    ) -> ProductResult<Vec<WorkspaceNode>> {
        self.repository.list(project_id, storyboard_id).await
    }

    pub async fn create(
        &self,
        input: CreateWorkspaceNodeInput,
        idempotency_key: String,
    ) -> ProductResult<WorkspaceNode> {
        if matches!(input.kind, WorkspaceNodeKind::Folder) && input.object_type.is_some() {
            return Err(ProductError::Validation(
                "objectType is only valid for object nodes".to_owned(),
            ));
        }
        if matches!(input.kind, WorkspaceNodeKind::Object) && input.object_type.is_none() {
            return Err(ProductError::Validation(
                "objectType is required for object nodes".to_owned(),
            ));
        }
        let idempotency =
            IdempotencyContext::new("createWorkspaceNode", idempotency_key, &input, 201)?;
        let now = Utc::now();
        let node = match input.kind {
            WorkspaceNodeKind::Folder => WorkspaceNode::folder(
                input.project_id,
                input.storyboard_id,
                input.parent_id,
                input.name,
                now,
            )?,
            WorkspaceNodeKind::Object => WorkspaceNode::object(
                input.project_id,
                input.storyboard_id,
                input.parent_id,
                input.name,
                input.object_type.expect("validated object type"),
                now,
            )?,
        };
        self.repository
            .create(CreateWorkspaceNode { node, idempotency })
            .await
    }

    pub async fn update(&self, mut command: UpdateWorkspaceNode) -> ProductResult<WorkspaceNode> {
        command.name = validate_name(
            command.name,
            MAX_WORKSPACE_NODE_NAME_CHARS,
            "workspace node",
        )?;
        validate_revision(command.expected_revision)?;
        self.repository.update(command).await
    }
}
