use super::idempotency::IdempotencyContext;
use crate::conversation_references::WorkspaceReference;
use crate::product::domain::{
    GenerationInputSelection, ProductError, ProductResult, ProjectId, StoryboardId,
    WorkspaceThreadBinding,
};
use async_trait::async_trait;
use chrono::Utc;
use serde::Serialize;
use std::sync::Arc;
use uuid::Uuid;

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StoryboardContext {
    pub project_id: ProjectId,
    pub project_name: String,
    pub storyboard_id: StoryboardId,
    pub storyboard_name: String,
    pub storyboard_revision: i64,
    pub script: StoryboardScriptContext,
    pub folders: Vec<StoryboardFolderContext>,
    pub assets: Vec<StoryboardAssetContext>,
    pub media: Vec<StoryboardMediaContext>,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StoryboardScriptContext {
    pub text: String,
    pub revision: i64,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StoryboardFolderContext {
    pub id: String,
    pub parent_id: Option<String>,
    pub name: String,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StoryboardAssetContext {
    pub binding_id: Uuid,
    pub asset_id: Uuid,
    pub kind: String,
    pub name: String,
    pub prompt: Option<String>,
    pub revision: i64,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StoryboardMediaContext {
    pub media_id: Uuid,
    pub kind: String,
    pub role: String,
    pub name: String,
    pub prompt: Option<String>,
    pub status: String,
    pub revision: i64,
}

/// A scoped, current snapshot of a resource that tools may search or read.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StoryboardResource {
    pub id: String,
    pub kind: String,
    pub name: String,
    pub role: Option<String>,
    pub content: Option<String>,
    pub status: Option<String>,
    pub revision: i64,
    pub editable: bool,
    pub generation_input: Option<GenerationInputSelection>,
}

#[async_trait]
pub trait WorkspaceThreadStore: Send + Sync {
    async fn validate_scope(
        &self,
        project_id: ProjectId,
        storyboard_id: StoryboardId,
    ) -> ProductResult<()>;

    async fn find_latest(
        &self,
        project_id: ProjectId,
        storyboard_id: StoryboardId,
    ) -> ProductResult<Option<WorkspaceThreadBinding>>;

    async fn list(
        &self,
        project_id: ProjectId,
        storyboard_id: StoryboardId,
    ) -> ProductResult<Vec<WorkspaceThreadBinding>>;

    async fn find_by_thread(
        &self,
        thread_id: Uuid,
    ) -> ProductResult<Option<WorkspaceThreadBinding>>;

    async fn replay_create(
        &self,
        idempotency: &IdempotencyContext,
    ) -> ProductResult<Option<WorkspaceThreadBinding>>;

    async fn bind(
        &self,
        binding: WorkspaceThreadBinding,
        idempotency: IdempotencyContext,
    ) -> ProductResult<WorkspaceThreadBinding>;

    async fn delete_binding(
        &self,
        project_id: ProjectId,
        storyboard_id: StoryboardId,
        thread_id: Uuid,
    ) -> ProductResult<()>;

    async fn load_context(&self, thread_id: Uuid) -> ProductResult<Option<StoryboardContext>>;

    async fn list_resources(&self, thread_id: Uuid) -> ProductResult<Vec<StoryboardResource>>;

    async fn resolve_references(
        &self,
        thread_id: Uuid,
        reference_ids: &[String],
    ) -> ProductResult<Vec<WorkspaceReference>>;
}

#[async_trait]
pub trait RuntimeThreadGateway: Send + Sync {
    async fn create_thread(&self, title: String) -> ProductResult<Uuid>;
    async fn delete_thread(&self, thread_id: Uuid) -> ProductResult<()>;
}

#[derive(Clone)]
pub struct WorkspaceThreadService {
    store: Arc<dyn WorkspaceThreadStore>,
    runtime: Arc<dyn RuntimeThreadGateway>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CreateWorkspaceThreadFingerprint {
    project_id: ProjectId,
    storyboard_id: StoryboardId,
}

impl WorkspaceThreadService {
    pub fn new(
        store: Arc<dyn WorkspaceThreadStore>,
        runtime: Arc<dyn RuntimeThreadGateway>,
    ) -> Self {
        Self { store, runtime }
    }

    pub async fn get(
        &self,
        project_id: ProjectId,
        storyboard_id: StoryboardId,
    ) -> ProductResult<Option<WorkspaceThreadBinding>> {
        self.store.validate_scope(project_id, storyboard_id).await?;
        self.store.find_latest(project_id, storyboard_id).await
    }

    pub async fn list(
        &self,
        project_id: ProjectId,
        storyboard_id: StoryboardId,
    ) -> ProductResult<Vec<WorkspaceThreadBinding>> {
        self.store.validate_scope(project_id, storyboard_id).await?;
        self.store.list(project_id, storyboard_id).await
    }

    pub async fn create(
        &self,
        project_id: ProjectId,
        storyboard_id: StoryboardId,
        idempotency_key: String,
    ) -> ProductResult<WorkspaceThreadBinding> {
        let fingerprint = CreateWorkspaceThreadFingerprint {
            project_id,
            storyboard_id,
        };
        let idempotency =
            IdempotencyContext::new("createWorkspaceThread", idempotency_key, &fingerprint, 201)?;
        if let Some(binding) = self.store.replay_create(&idempotency).await? {
            return Ok(binding);
        }

        // Validate before touching Runtime so an invalid URL can never leave an
        // orphaned conversation behind.
        self.store.validate_scope(project_id, storyboard_id).await?;
        let thread_id = self
            .runtime
            .create_thread(format!("片段 · {storyboard_id}"))
            .await?;
        self.store
            .bind(
                WorkspaceThreadBinding {
                    project_id,
                    storyboard_id,
                    thread_id,
                    created_at: Utc::now(),
                },
                idempotency,
            )
            .await
    }

    pub async fn delete(
        &self,
        project_id: ProjectId,
        storyboard_id: StoryboardId,
        thread_id: Uuid,
    ) -> ProductResult<()> {
        self.store.validate_scope(project_id, storyboard_id).await?;
        let binding = self.store.find_by_thread(thread_id).await?;
        if !binding.is_some_and(|binding| {
            binding.project_id == project_id && binding.storyboard_id == storyboard_id
        }) {
            return Err(ProductError::NotFound);
        }
        // Runtime and product metadata live in separate databases. Runtime deletion
        // is idempotent so a failed binding write can be retried safely.
        self.runtime.delete_thread(thread_id).await?;
        self.store
            .delete_binding(project_id, storyboard_id, thread_id)
            .await
    }

    pub async fn binding_for_thread(
        &self,
        thread_id: Uuid,
    ) -> ProductResult<WorkspaceThreadBinding> {
        self.store
            .find_by_thread(thread_id)
            .await?
            .ok_or(ProductError::NotFound)
    }

    pub async fn model_context(&self, thread_id: Uuid) -> ProductResult<Option<String>> {
        let Some(context) = self.store.load_context(thread_id).await? else {
            return Ok(None);
        };
        serde_json::to_string(&context)
            .map(Some)
            .map_err(|error| ProductError::Storage(error.to_string()))
    }

    pub async fn resolve_references(
        &self,
        thread_id: Uuid,
        reference_ids: &[String],
    ) -> ProductResult<Vec<WorkspaceReference>> {
        self.store
            .resolve_references(thread_id, reference_ids)
            .await
    }
}
