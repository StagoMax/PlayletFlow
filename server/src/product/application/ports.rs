use crate::product::domain::{OutboxEvent, ProductResult, StoryboardId, WorkspaceThreadBinding};
use async_trait::async_trait;
use uuid::Uuid;

#[async_trait]
pub trait WorkspaceThreadRepository: Send + Sync {
    async fn find_workspace_thread(
        &mut self,
        storyboard_id: StoryboardId,
    ) -> ProductResult<Option<WorkspaceThreadBinding>>;
    async fn find_thread_scope(
        &mut self,
        thread_id: Uuid,
    ) -> ProductResult<Option<WorkspaceThreadBinding>>;
    async fn insert_workspace_thread(
        &mut self,
        binding: &WorkspaceThreadBinding,
    ) -> ProductResult<()>;
}

#[async_trait]
pub trait OutboxRepository: Send + Sync {
    async fn append_event(&mut self, event: &OutboxEvent) -> ProductResult<()>;
}
