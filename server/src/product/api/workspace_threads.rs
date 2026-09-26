use super::error::ProductApiError;
use crate::product::application::workspace_threads::WorkspaceThreadService;
use crate::product::domain::{ProjectId, StoryboardId, WorkspaceThreadBinding};
use axum::extract::{Path, State};
use axum::http::{HeaderMap, StatusCode};
use axum::routing::get;
use axum::{Json, Router};
use uuid::Uuid;

type ApiResult<T> = Result<T, ProductApiError>;

#[derive(Clone)]
struct WorkspaceThreadApiState {
    service: WorkspaceThreadService,
}

pub fn router(service: WorkspaceThreadService) -> Router {
    Router::new()
        .route(
            "/api/v1/projects/:project_id/storyboards/:storyboard_id/ai-thread",
            get(get_workspace_thread).post(create_workspace_thread),
        )
        .route(
            "/api/v1/projects/:project_id/storyboards/:storyboard_id/ai-threads",
            get(list_workspace_threads),
        )
        .with_state(WorkspaceThreadApiState { service })
}

async fn list_workspace_threads(
    State(state): State<WorkspaceThreadApiState>,
    Path((project_id, storyboard_id)): Path<(String, String)>,
) -> ApiResult<Json<Vec<WorkspaceThreadBinding>>> {
    Ok(Json(
        state
            .service
            .list(
                parse_project_id(&project_id)?,
                parse_storyboard_id(&storyboard_id)?,
            )
            .await?,
    ))
}

async fn get_workspace_thread(
    State(state): State<WorkspaceThreadApiState>,
    Path((project_id, storyboard_id)): Path<(String, String)>,
) -> ApiResult<Json<Option<WorkspaceThreadBinding>>> {
    Ok(Json(
        state
            .service
            .get(
                parse_project_id(&project_id)?,
                parse_storyboard_id(&storyboard_id)?,
            )
            .await?,
    ))
}

async fn create_workspace_thread(
    State(state): State<WorkspaceThreadApiState>,
    Path((project_id, storyboard_id)): Path<(String, String)>,
    headers: HeaderMap,
) -> ApiResult<(StatusCode, Json<WorkspaceThreadBinding>)> {
    let binding = state
        .service
        .create(
            parse_project_id(&project_id)?,
            parse_storyboard_id(&storyboard_id)?,
            idempotency_key(&headers)?,
        )
        .await?;
    Ok((StatusCode::CREATED, Json(binding)))
}

fn parse_project_id(value: &str) -> ApiResult<ProjectId> {
    Uuid::parse_str(value)
        .map(ProjectId)
        .map_err(|_| ProductApiError::invalid_request("projectId must be a UUID"))
}

fn parse_storyboard_id(value: &str) -> ApiResult<StoryboardId> {
    Uuid::parse_str(value)
        .map(StoryboardId)
        .map_err(|_| ProductApiError::invalid_request("storyboardId must be a UUID"))
}

fn idempotency_key(headers: &HeaderMap) -> ApiResult<String> {
    headers
        .get("Idempotency-Key")
        .and_then(|value| value.to_str().ok())
        .map(str::to_owned)
        .ok_or_else(|| ProductApiError::invalid_request("Idempotency-Key header is required"))
}

#[cfg(test)]
#[path = "workspace_threads_tests.rs"]
mod tests;
