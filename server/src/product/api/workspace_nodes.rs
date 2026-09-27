use crate::product::api::error::ProductApiError;
use crate::product::application::workspace_nodes::{
    CreateWorkspaceNodeInput, DeleteWorkspaceNode, MarkWorkspaceNodeViewed, ReorderWorkspaceNode,
    SavedWorkspaceObjectPrompt, UndoWorkspaceObjectPromptInput, UpdateWorkspaceNode,
    WorkspaceNodeService,
};
use crate::product::domain::{
    ProjectId, StoryboardId, WorkspaceNode, WorkspaceNodeKind, WorkspaceObjectType,
};
use axum::extract::rejection::JsonRejection;
use axum::extract::{Path, Query, State};
use axum::http::{HeaderMap, StatusCode};
use axum::routing::{get, patch, post, put};
use axum::{Json, Router};
use serde::Deserialize;
use uuid::Uuid;

#[derive(Clone)]
struct WorkspaceNodeApiState {
    service: WorkspaceNodeService,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CreateWorkspaceNodeRequest {
    parent_id: Option<String>,
    kind: WorkspaceNodeKind,
    name: String,
    object_type: Option<WorkspaceObjectType>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct UpdateWorkspaceNodeRequest {
    parent_id: Option<String>,
    name: String,
    expected_revision: i64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ReorderWorkspaceNodeRequest {
    before_id: Option<String>,
    after_id: Option<String>,
    expected_revision: i64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct DeleteWorkspaceNodeQuery {
    expected_revision: i64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct MarkWorkspaceNodeViewedRequest {
    seen_through: chrono::DateTime<chrono::Utc>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct UndoWorkspaceObjectPromptRequest {
    expected_revision: i64,
}

type ApiResult<T> = Result<T, ProductApiError>;

pub(super) fn router(service: WorkspaceNodeService) -> Router {
    Router::new()
        .route(
            "/api/v1/projects/:project_id/storyboards/:storyboard_id/workspace-nodes",
            get(list_nodes).post(create_node),
        )
        .route(
            "/api/v1/projects/:project_id/storyboards/:storyboard_id/workspace-nodes/:node_id",
            patch(update_node).delete(delete_node),
        )
        .route(
            "/api/v1/projects/:project_id/storyboards/:storyboard_id/workspace-nodes/:node_id/copies",
            post(copy_node),
        )
        .route(
            "/api/v1/projects/:project_id/storyboards/:storyboard_id/workspace-nodes/:node_id/order",
            patch(reorder_node),
        )
        .route(
            "/api/v1/projects/:project_id/storyboards/:storyboard_id/workspace-nodes/:node_id/viewed",
            put(mark_node_viewed),
        )
        .route(
            "/api/v1/projects/:project_id/storyboards/:storyboard_id/workspace-nodes/:node_id/prompt/undo",
            post(undo_object_prompt),
        )
        .with_state(WorkspaceNodeApiState { service })
}

async fn list_nodes(
    State(state): State<WorkspaceNodeApiState>,
    Path((project_id, storyboard_id)): Path<(String, String)>,
) -> ApiResult<Json<Vec<WorkspaceNode>>> {
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

async fn create_node(
    State(state): State<WorkspaceNodeApiState>,
    Path((project_id, storyboard_id)): Path<(String, String)>,
    headers: HeaderMap,
    payload: Result<Json<CreateWorkspaceNodeRequest>, JsonRejection>,
) -> ApiResult<(StatusCode, Json<WorkspaceNode>)> {
    let Json(payload) = payload.map_err(ProductApiError::from_json_rejection)?;
    let node = state
        .service
        .create(
            CreateWorkspaceNodeInput {
                project_id: parse_project_id(&project_id)?,
                storyboard_id: parse_storyboard_id(&storyboard_id)?,
                parent_id: normalize_parent_id(payload.parent_id)?,
                kind: payload.kind,
                name: payload.name,
                object_type: payload.object_type,
            },
            idempotency_key(&headers)?,
        )
        .await?;
    Ok((StatusCode::CREATED, Json(node)))
}

async fn update_node(
    State(state): State<WorkspaceNodeApiState>,
    Path((project_id, storyboard_id, node_id)): Path<(String, String, String)>,
    payload: Result<Json<UpdateWorkspaceNodeRequest>, JsonRejection>,
) -> ApiResult<Json<WorkspaceNode>> {
    let Json(payload) = payload.map_err(ProductApiError::from_json_rejection)?;
    let node_id = validate_node_id(node_id)?;
    Ok(Json(
        state
            .service
            .update(UpdateWorkspaceNode {
                project_id: parse_project_id(&project_id)?,
                storyboard_id: parse_storyboard_id(&storyboard_id)?,
                node_id,
                parent_id: normalize_parent_id(payload.parent_id)?,
                name: payload.name,
                expected_revision: payload.expected_revision,
            })
            .await?,
    ))
}

async fn delete_node(
    State(state): State<WorkspaceNodeApiState>,
    Path((project_id, storyboard_id, node_id)): Path<(String, String, String)>,
    Query(query): Query<DeleteWorkspaceNodeQuery>,
) -> ApiResult<StatusCode> {
    state
        .service
        .delete(DeleteWorkspaceNode {
            project_id: parse_project_id(&project_id)?,
            storyboard_id: parse_storyboard_id(&storyboard_id)?,
            node_id: validate_node_id(node_id)?,
            expected_revision: query.expected_revision,
        })
        .await?;
    Ok(StatusCode::NO_CONTENT)
}

async fn reorder_node(
    State(state): State<WorkspaceNodeApiState>,
    Path((project_id, storyboard_id, node_id)): Path<(String, String, String)>,
    payload: Result<Json<ReorderWorkspaceNodeRequest>, JsonRejection>,
) -> ApiResult<Json<WorkspaceNode>> {
    let Json(payload) = payload.map_err(ProductApiError::from_json_rejection)?;
    Ok(Json(
        state
            .service
            .reorder(ReorderWorkspaceNode {
                project_id: parse_project_id(&project_id)?,
                storyboard_id: parse_storyboard_id(&storyboard_id)?,
                node_id: validate_node_id(node_id)?,
                before_id: normalize_parent_id(payload.before_id)?,
                after_id: normalize_parent_id(payload.after_id)?,
                expected_revision: payload.expected_revision,
            })
            .await?,
    ))
}

async fn copy_node(
    State(state): State<WorkspaceNodeApiState>,
    Path((project_id, storyboard_id, node_id)): Path<(String, String, String)>,
    headers: HeaderMap,
) -> ApiResult<(StatusCode, Json<WorkspaceNode>)> {
    let node = state
        .service
        .copy(
            parse_project_id(&project_id)?,
            parse_storyboard_id(&storyboard_id)?,
            validate_node_id(node_id)?,
            idempotency_key(&headers)?,
        )
        .await?;
    Ok((StatusCode::CREATED, Json(node)))
}

async fn mark_node_viewed(
    State(state): State<WorkspaceNodeApiState>,
    Path((project_id, storyboard_id, node_id)): Path<(String, String, String)>,
    payload: Result<Json<MarkWorkspaceNodeViewedRequest>, JsonRejection>,
) -> ApiResult<Json<WorkspaceNode>> {
    let Json(payload) = payload.map_err(ProductApiError::from_json_rejection)?;
    Ok(Json(
        state
            .service
            .mark_viewed(MarkWorkspaceNodeViewed {
                project_id: parse_project_id(&project_id)?,
                storyboard_id: parse_storyboard_id(&storyboard_id)?,
                node_id: validate_node_id(node_id)?,
                seen_through: payload.seen_through,
            })
            .await?,
    ))
}

async fn undo_object_prompt(
    State(state): State<WorkspaceNodeApiState>,
    Path((project_id, storyboard_id, node_id)): Path<(String, String, String)>,
    headers: HeaderMap,
    payload: Result<Json<UndoWorkspaceObjectPromptRequest>, JsonRejection>,
) -> ApiResult<Json<SavedWorkspaceObjectPrompt>> {
    let Json(payload) = payload.map_err(ProductApiError::from_json_rejection)?;
    Ok(Json(
        state
            .service
            .undo_object_prompt(
                UndoWorkspaceObjectPromptInput {
                    project_id: parse_project_id(&project_id)?,
                    storyboard_id: parse_storyboard_id(&storyboard_id)?,
                    target_id: validate_node_id(node_id)?,
                    expected_revision: payload.expected_revision,
                },
                idempotency_key(&headers)?,
            )
            .await?,
    ))
}

fn idempotency_key(headers: &HeaderMap) -> ApiResult<String> {
    headers
        .get("Idempotency-Key")
        .and_then(|value| value.to_str().ok())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
        .ok_or_else(|| ProductApiError::invalid_request("Idempotency-Key header is required"))
}

fn normalize_parent_id(value: Option<String>) -> ApiResult<Option<String>> {
    value.map(validate_node_id).transpose()
}

fn validate_node_id(value: String) -> ApiResult<String> {
    let value = value.trim().to_owned();
    if value.is_empty() || value.chars().count() > 200 {
        return Err(ProductApiError::invalid_request(
            "nodeId must contain between 1 and 200 characters",
        ));
    }
    Ok(value)
}

fn parse_uuid(field: &str, value: &str) -> ApiResult<Uuid> {
    Uuid::parse_str(value)
        .map_err(|_| ProductApiError::invalid_request(format!("{field} must be a UUID")))
}

fn parse_project_id(value: &str) -> ApiResult<ProjectId> {
    Ok(ProjectId::from(parse_uuid("projectId", value)?))
}

fn parse_storyboard_id(value: &str) -> ApiResult<StoryboardId> {
    Ok(StoryboardId::from(parse_uuid("storyboardId", value)?))
}
