use crate::product::application::idempotency::IdempotencyContext;
use crate::product::domain::{
    validate_name, validate_revision, MediaId, ProductError, ProductResult, ProjectId,
    StoryboardId, WorkspaceNode, WorkspaceNodeKind, WorkspaceObjectType, MAX_PROMPT_CHARS,
    MAX_WORKSPACE_NODE_NAME_CHARS,
};
use async_trait::async_trait;
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use std::sync::Arc;

#[derive(Clone, Debug)]
pub struct CreateWorkspaceNode {
    pub node: WorkspaceNode,
    pub idempotency: IdempotencyContext,
}

#[derive(Clone, Debug)]
pub struct CreatePromptedMediaObject {
    pub node: WorkspaceNode,
    pub prompt: String,
    pub idempotency: IdempotencyContext,
}

#[derive(Clone, Debug)]
pub struct SaveWorkspaceObjectPrompt {
    pub project_id: ProjectId,
    pub storyboard_id: StoryboardId,
    pub target_id: String,
    pub prompt: String,
    pub expected_revision: i64,
    pub idempotency: IdempotencyContext,
}

#[derive(Clone, Debug)]
pub struct UndoWorkspaceObjectPrompt {
    pub project_id: ProjectId,
    pub storyboard_id: StoryboardId,
    pub target_id: String,
    pub expected_revision: i64,
    pub idempotency: IdempotencyContext,
}

#[derive(Clone, Debug)]
pub struct MarkWorkspaceNodeViewed {
    pub project_id: ProjectId,
    pub storyboard_id: StoryboardId,
    pub node_id: String,
    pub seen_through: DateTime<Utc>,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SavedWorkspaceObjectPrompt {
    pub object_id: String,
    pub media_id: MediaId,
    pub object_type: WorkspaceObjectType,
    pub prompt: String,
    pub revision: i64,
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

#[derive(Clone, Debug)]
pub struct ReorderWorkspaceNode {
    pub project_id: ProjectId,
    pub storyboard_id: StoryboardId,
    pub node_id: String,
    pub before_id: Option<String>,
    pub after_id: Option<String>,
    pub expected_revision: i64,
}

#[derive(Clone, Debug)]
pub struct DeleteWorkspaceNode {
    pub project_id: ProjectId,
    pub storyboard_id: StoryboardId,
    pub node_id: String,
    pub expected_revision: i64,
}

#[derive(Clone, Debug)]
pub struct CopyWorkspaceNode {
    pub project_id: ProjectId,
    pub storyboard_id: StoryboardId,
    pub node_id: String,
    pub idempotency: IdempotencyContext,
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

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CreatePromptedMediaObjectInput {
    pub project_id: ProjectId,
    pub storyboard_id: StoryboardId,
    pub parent_id: Option<String>,
    pub name: String,
    pub object_type: WorkspaceObjectType,
    pub prompt: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveWorkspaceObjectPromptInput {
    pub project_id: ProjectId,
    pub storyboard_id: StoryboardId,
    pub target_id: String,
    pub prompt: String,
    pub expected_revision: i64,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UndoWorkspaceObjectPromptInput {
    pub project_id: ProjectId,
    pub storyboard_id: StoryboardId,
    pub target_id: String,
    pub expected_revision: i64,
}

#[async_trait]
pub trait WorkspaceNodeRepository: Send + Sync {
    async fn list(
        &self,
        project_id: ProjectId,
        storyboard_id: StoryboardId,
    ) -> ProductResult<Vec<WorkspaceNode>>;
    async fn create(&self, command: CreateWorkspaceNode) -> ProductResult<WorkspaceNode>;
    async fn create_prompted_media_object(
        &self,
        command: CreatePromptedMediaObject,
    ) -> ProductResult<WorkspaceNode>;
    async fn save_object_prompt(
        &self,
        command: SaveWorkspaceObjectPrompt,
    ) -> ProductResult<SavedWorkspaceObjectPrompt>;
    async fn undo_object_prompt(
        &self,
        command: UndoWorkspaceObjectPrompt,
    ) -> ProductResult<SavedWorkspaceObjectPrompt>;
    async fn mark_viewed(&self, command: MarkWorkspaceNodeViewed) -> ProductResult<WorkspaceNode>;
    async fn update(&self, command: UpdateWorkspaceNode) -> ProductResult<WorkspaceNode>;
    async fn reorder(&self, command: ReorderWorkspaceNode) -> ProductResult<WorkspaceNode>;
    async fn delete(&self, command: DeleteWorkspaceNode) -> ProductResult<()>;
    async fn copy(&self, command: CopyWorkspaceNode) -> ProductResult<WorkspaceNode>;
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

    pub async fn create_prompted_media_object(
        &self,
        mut input: CreatePromptedMediaObjectInput,
        idempotency_key: String,
    ) -> ProductResult<WorkspaceNode> {
        input.prompt = input.prompt.trim().to_owned();
        if input.prompt.is_empty() || input.prompt.chars().count() > MAX_PROMPT_CHARS {
            return Err(ProductError::Validation(format!(
                "prompt must contain between 1 and {MAX_PROMPT_CHARS} characters"
            )));
        }
        if input.object_type == WorkspaceObjectType::Text {
            return Err(ProductError::Validation(
                "objectType must be image or video".to_owned(),
            ));
        }
        let idempotency =
            IdempotencyContext::new("createPromptedMediaObject", idempotency_key, &input, 201)?;
        let now = Utc::now();
        let mut node = WorkspaceNode::media_object(
            input.project_id,
            input.storyboard_id,
            input.parent_id,
            input.name,
            input.object_type,
            now,
        )?;
        node.unseen_update_at = Some(now);
        self.repository
            .create_prompted_media_object(CreatePromptedMediaObject {
                node,
                prompt: input.prompt,
                idempotency,
            })
            .await
    }

    pub async fn mark_viewed(
        &self,
        command: MarkWorkspaceNodeViewed,
    ) -> ProductResult<WorkspaceNode> {
        self.repository.mark_viewed(command).await
    }

    pub async fn save_object_prompt(
        &self,
        mut input: SaveWorkspaceObjectPromptInput,
        idempotency_key: String,
    ) -> ProductResult<SavedWorkspaceObjectPrompt> {
        input.target_id = input.target_id.trim().to_owned();
        if input.target_id.is_empty() || input.target_id.chars().count() > 200 {
            return Err(ProductError::Validation(
                "targetId must contain between 1 and 200 characters".to_owned(),
            ));
        }
        input.prompt = input.prompt.trim().to_owned();
        if input.prompt.is_empty() || input.prompt.chars().count() > MAX_PROMPT_CHARS {
            return Err(ProductError::Validation(format!(
                "prompt must contain between 1 and {MAX_PROMPT_CHARS} characters"
            )));
        }
        validate_revision(input.expected_revision)?;
        let idempotency =
            IdempotencyContext::new("saveWorkspaceObjectPrompt", idempotency_key, &input, 200)?;
        self.repository
            .save_object_prompt(SaveWorkspaceObjectPrompt {
                project_id: input.project_id,
                storyboard_id: input.storyboard_id,
                target_id: input.target_id,
                prompt: input.prompt,
                expected_revision: input.expected_revision,
                idempotency,
            })
            .await
    }

    pub async fn undo_object_prompt(
        &self,
        mut input: UndoWorkspaceObjectPromptInput,
        idempotency_key: String,
    ) -> ProductResult<SavedWorkspaceObjectPrompt> {
        input.target_id = input.target_id.trim().to_owned();
        if input.target_id.is_empty() || input.target_id.chars().count() > 200 {
            return Err(ProductError::Validation(
                "targetId must contain between 1 and 200 characters".to_owned(),
            ));
        }
        validate_revision(input.expected_revision)?;
        let idempotency =
            IdempotencyContext::new("undoWorkspaceObjectPrompt", idempotency_key, &input, 200)?;
        self.repository
            .undo_object_prompt(UndoWorkspaceObjectPrompt {
                project_id: input.project_id,
                storyboard_id: input.storyboard_id,
                target_id: input.target_id,
                expected_revision: input.expected_revision,
                idempotency,
            })
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

    pub async fn reorder(&self, command: ReorderWorkspaceNode) -> ProductResult<WorkspaceNode> {
        validate_revision(command.expected_revision)?;
        if command.before_id.is_some() == command.after_id.is_some() {
            return Err(ProductError::Validation(
                "exactly one of beforeId or afterId is required".to_owned(),
            ));
        }
        self.repository.reorder(command).await
    }

    pub async fn delete(&self, command: DeleteWorkspaceNode) -> ProductResult<()> {
        validate_revision(command.expected_revision)?;
        self.repository.delete(command).await
    }

    pub async fn copy(
        &self,
        project_id: ProjectId,
        storyboard_id: StoryboardId,
        node_id: String,
        idempotency_key: String,
    ) -> ProductResult<WorkspaceNode> {
        let idempotency = IdempotencyContext::new(
            "copyWorkspaceNode",
            idempotency_key,
            &(project_id, storyboard_id, &node_id),
            201,
        )?;
        self.repository
            .copy(CopyWorkspaceNode {
                project_id,
                storyboard_id,
                node_id,
                idempotency,
            })
            .await
    }
}
