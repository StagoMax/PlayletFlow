use super::error::ProductApiError;
use super::storyboard_views::{
    AssetCopySummaryResponse, CreateStoryboardResponse, Page, ProjectListResponse,
    StoryboardDetailResponse, StoryboardScriptResponse, StoryboardWindowResponse,
};
use crate::product::application::storyboards::{
    ReorderStoryboard, ReuseStoryboardAssets, StoryboardService,
};
use crate::product::domain::{
    AssetBindingId, ProductError, ProjectId, StoryboardId, StoryboardSnapshot,
};
use axum::extract::rejection::{JsonRejection, QueryRejection};
use axum::extract::{Path, Query, State};
use axum::http::{HeaderMap, StatusCode};
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::Deserialize;
use uuid::Uuid;

type ApiResult<T> = Result<T, ProductApiError>;

#[derive(Clone)]
struct StoryboardApiState {
    service: StoryboardService,
}

pub fn router(service: StoryboardService) -> Router {
    Router::new()
        .route("/api/v1/projects", get(list_projects).post(create_project))
        .route(
            "/api/v1/projects/:project_id",
            get(get_project).patch(update_project),
        )
        .route(
            "/api/v1/projects/:project_id/storyboards",
            get(list_storyboards).post(create_storyboard),
        )
        .route(
            "/api/v1/projects/:project_id/storyboards/:storyboard_id",
            get(get_storyboard)
                .patch(update_storyboard)
                .delete(delete_storyboard),
        )
        .route(
            "/api/v1/projects/:project_id/storyboards/:storyboard_id/restore",
            post(restore_storyboard),
        )
        .route(
            "/api/v1/projects/:project_id/storyboards/:storyboard_id/reorder",
            post(reorder_storyboard),
        )
        .route(
            "/api/v1/projects/:project_id/storyboards/:storyboard_id/duplicate",
            post(duplicate_storyboard),
        )
        .route(
            "/api/v1/projects/:project_id/storyboards/:storyboard_id/script",
            get(get_script).patch(update_script),
        )
        .with_state(StoryboardApiState { service })
}

async fn list_projects(
    State(state): State<StoryboardApiState>,
) -> ApiResult<Json<ProjectListResponse>> {
    let items = state.service.list_projects().await?;
    let total = items.len();
    Ok(Json(ProjectListResponse {
        items,
        page: Page {
            next_cursor: None,
            total,
        },
    }))
}

async fn create_project(
    State(state): State<StoryboardApiState>,
    headers: HeaderMap,
    payload: Result<Json<CreateProjectRequest>, JsonRejection>,
) -> ApiResult<(StatusCode, Json<crate::product::domain::Project>)> {
    let Json(payload) = payload.map_err(ProductApiError::from_json_rejection)?;
    let project = state
        .service
        .create_project(payload.name, idempotency_key(&headers)?)
        .await?;
    Ok((StatusCode::CREATED, Json(project)))
}

async fn get_project(
    State(state): State<StoryboardApiState>,
    Path(project_id): Path<String>,
) -> ApiResult<Json<crate::product::domain::Project>> {
    Ok(Json(
        state
            .service
            .get_project(parse_project_id(&project_id)?)
            .await?,
    ))
}

async fn update_project(
    State(state): State<StoryboardApiState>,
    Path(project_id): Path<String>,
    payload: Result<Json<UpdateProjectRequest>, JsonRejection>,
) -> ApiResult<Json<crate::product::domain::Project>> {
    let Json(payload) = payload.map_err(ProductApiError::from_json_rejection)?;
    Ok(Json(
        state
            .service
            .rename_project(
                parse_project_id(&project_id)?,
                payload.name,
                payload.expected_revision,
            )
            .await?,
    ))
}

async fn list_storyboards(
    State(state): State<StoryboardApiState>,
    Path(project_id): Path<String>,
    query: Result<Query<StoryboardWindowQuery>, QueryRejection>,
) -> ApiResult<Json<StoryboardWindowResponse>> {
    let Query(query) = query.map_err(ProductApiError::from_query_rejection)?;
    let anchor_id = query
        .anchor_id
        .as_deref()
        .map(parse_storyboard_id)
        .transpose()?;
    let cursor = query
        .cursor
        .as_deref()
        .map(|cursor| {
            cursor.parse::<usize>().map_err(|_| {
                ProductApiError::invalid_request("cursor must be a non-negative integer")
            })
        })
        .transpose()?;
    let window = state
        .service
        .list_storyboard_window(
            parse_project_id(&project_id)?,
            anchor_id,
            cursor,
            query.before,
            query.after,
        )
        .await?;
    Ok(Json(window.into()))
}

async fn create_storyboard(
    State(state): State<StoryboardApiState>,
    Path(project_id): Path<String>,
    headers: HeaderMap,
    payload: Result<Json<CreateStoryboardRequestBody>, JsonRejection>,
) -> ApiResult<(StatusCode, Json<CreateStoryboardResponse>)> {
    let Json(payload) = payload.map_err(ProductApiError::from_json_rejection)?;
    let project_id = parse_project_id(&project_id)?;
    let insert_after_id = payload
        .insert_after_id
        .0
        .as_deref()
        .map(parse_storyboard_id)
        .transpose()?;
    let reuse_assets = payload
        .reuse_assets_from
        .map(|reuse| -> ApiResult<ReuseStoryboardAssets> {
            Ok(ReuseStoryboardAssets {
                source_storyboard_id: parse_storyboard_id(&reuse.storyboard_id)?,
                binding_ids: reuse
                    .binding_ids
                    .iter()
                    .map(|id| parse_asset_binding_id(id))
                    .collect::<ApiResult<Vec<_>>>()?,
                include_prompt_overrides: reuse.include_prompt_overrides,
            })
        })
        .transpose()?;
    let created = state
        .service
        .create_storyboard_with_assets(
            project_id,
            payload.name,
            insert_after_id,
            reuse_assets,
            idempotency_key(&headers)?,
        )
        .await?;
    let storyboard = detail_response(&state.service, project_id, created.snapshot).await?;
    Ok((
        StatusCode::CREATED,
        Json(CreateStoryboardResponse {
            storyboard,
            asset_copy: AssetCopySummaryResponse {
                created: created.asset_copy.created,
                skipped: created.asset_copy.skipped,
                failed: Vec::new(),
            },
        }),
    ))
}

async fn get_storyboard(
    State(state): State<StoryboardApiState>,
    Path((project_id, storyboard_id)): Path<(String, String)>,
) -> ApiResult<Json<StoryboardDetailResponse>> {
    let project_id = parse_project_id(&project_id)?;
    let storyboard_id = parse_storyboard_id(&storyboard_id)?;
    let snapshot = state
        .service
        .get_storyboard(project_id, storyboard_id)
        .await?;
    Ok(Json(
        detail_response(&state.service, project_id, snapshot).await?,
    ))
}

async fn update_storyboard(
    State(state): State<StoryboardApiState>,
    Path((project_id, storyboard_id)): Path<(String, String)>,
    payload: Result<Json<UpdateStoryboardRequest>, JsonRejection>,
) -> ApiResult<Json<StoryboardDetailResponse>> {
    let Json(payload) = payload.map_err(ProductApiError::from_json_rejection)?;
    let project_id = parse_project_id(&project_id)?;
    let snapshot = state
        .service
        .rename_storyboard(
            project_id,
            parse_storyboard_id(&storyboard_id)?,
            payload.name,
            payload.expected_revision,
        )
        .await?;
    Ok(Json(
        detail_response(&state.service, project_id, snapshot).await?,
    ))
}

async fn delete_storyboard(
    State(state): State<StoryboardApiState>,
    Path((project_id, storyboard_id)): Path<(String, String)>,
    query: Result<Query<ExpectedRevisionQuery>, QueryRejection>,
) -> ApiResult<StatusCode> {
    let Query(query) = query.map_err(ProductApiError::from_query_rejection)?;
    state
        .service
        .delete_storyboard(
            parse_project_id(&project_id)?,
            parse_storyboard_id(&storyboard_id)?,
            query.expected_revision,
        )
        .await?;
    Ok(StatusCode::NO_CONTENT)
}

async fn restore_storyboard(
    State(state): State<StoryboardApiState>,
    Path((project_id, storyboard_id)): Path<(String, String)>,
    headers: HeaderMap,
) -> ApiResult<Json<StoryboardDetailResponse>> {
    let project_id = parse_project_id(&project_id)?;
    let snapshot = state
        .service
        .restore_storyboard(
            project_id,
            parse_storyboard_id(&storyboard_id)?,
            idempotency_key(&headers)?,
        )
        .await?;
    Ok(Json(
        detail_response(&state.service, project_id, snapshot).await?,
    ))
}

async fn reorder_storyboard(
    State(state): State<StoryboardApiState>,
    Path((project_id, storyboard_id)): Path<(String, String)>,
    headers: HeaderMap,
    payload: Result<Json<ReorderRequestBody>, JsonRejection>,
) -> ApiResult<Json<StoryboardDetailResponse>> {
    let Json(payload) = payload.map_err(ProductApiError::from_json_rejection)?;
    let project_id = parse_project_id(&project_id)?;
    let snapshot = state
        .service
        .reorder_storyboard(
            ReorderStoryboard {
                project_id,
                storyboard_id: parse_storyboard_id(&storyboard_id)?,
                before_id: payload
                    .before_id
                    .0
                    .as_deref()
                    .map(parse_storyboard_id)
                    .transpose()?,
                after_id: payload
                    .after_id
                    .0
                    .as_deref()
                    .map(parse_storyboard_id)
                    .transpose()?,
                expected_revision: payload.expected_revision,
            },
            idempotency_key(&headers)?,
        )
        .await?;
    Ok(Json(
        detail_response(&state.service, project_id, snapshot).await?,
    ))
}

async fn duplicate_storyboard(
    State(state): State<StoryboardApiState>,
    Path((project_id, storyboard_id)): Path<(String, String)>,
    headers: HeaderMap,
) -> ApiResult<(StatusCode, Json<StoryboardDetailResponse>)> {
    let project_id = parse_project_id(&project_id)?;
    let snapshot = state
        .service
        .duplicate_storyboard(
            project_id,
            parse_storyboard_id(&storyboard_id)?,
            idempotency_key(&headers)?,
        )
        .await?;
    Ok((
        StatusCode::CREATED,
        Json(detail_response(&state.service, project_id, snapshot).await?),
    ))
}

async fn get_script(
    State(state): State<StoryboardApiState>,
    Path((project_id, storyboard_id)): Path<(String, String)>,
) -> ApiResult<Json<StoryboardScriptResponse>> {
    let script = state
        .service
        .get_script(
            parse_project_id(&project_id)?,
            parse_storyboard_id(&storyboard_id)?,
        )
        .await?;
    Ok(Json(script.into()))
}

async fn update_script(
    State(state): State<StoryboardApiState>,
    Path((project_id, storyboard_id)): Path<(String, String)>,
    payload: Result<Json<UpdateScriptRequest>, JsonRejection>,
) -> ApiResult<Json<StoryboardScriptResponse>> {
    let Json(payload) = payload.map_err(ProductApiError::from_json_rejection)?;
    let script = state
        .service
        .update_script(
            parse_project_id(&project_id)?,
            parse_storyboard_id(&storyboard_id)?,
            payload.text,
            payload.expected_revision,
        )
        .await?;
    Ok(Json(script.into()))
}

async fn detail_response(
    service: &StoryboardService,
    project_id: ProjectId,
    snapshot: StoryboardSnapshot,
) -> ApiResult<StoryboardDetailResponse> {
    let storyboard_id = snapshot.entry.storyboard.id;
    let window = service
        .list_storyboard_window(project_id, Some(storyboard_id), None, 0, 0)
        .await?;
    let index = window.anchor_index.ok_or(ProductError::NotFound)?;
    Ok(StoryboardDetailResponse::from_snapshot(snapshot, index))
}

fn parse_project_id(value: &str) -> ApiResult<ProjectId> {
    Uuid::parse_str(value)
        .map(ProjectId::from)
        .map_err(|_| ProductApiError::invalid_request("projectId must be a UUID"))
}

fn parse_storyboard_id(value: &str) -> ApiResult<StoryboardId> {
    Uuid::parse_str(value)
        .map(StoryboardId::from)
        .map_err(|_| ProductApiError::invalid_request("storyboardId must be a UUID"))
}

fn parse_asset_binding_id(value: &str) -> ApiResult<AssetBindingId> {
    Uuid::parse_str(value)
        .map(AssetBindingId::from)
        .map_err(|_| ProductApiError::invalid_request("bindingId must be a UUID"))
}

fn idempotency_key(headers: &HeaderMap) -> ApiResult<String> {
    let value = headers
        .get("Idempotency-Key")
        .ok_or_else(|| ProductApiError::invalid_request("Idempotency-Key header is required"))?
        .to_str()
        .map_err(|_| ProductApiError::invalid_request("Idempotency-Key must be valid text"))?
        .trim();
    if !(8..=200).contains(&value.chars().count()) {
        return Err(ProductApiError::invalid_request(
            "Idempotency-Key must contain between 8 and 200 characters",
        ));
    }
    Ok(value.to_owned())
}

fn default_window_radius() -> usize {
    25
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CreateProjectRequest {
    name: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct UpdateProjectRequest {
    name: String,
    expected_revision: i64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct StoryboardWindowQuery {
    anchor_id: Option<String>,
    #[serde(default = "default_window_radius")]
    before: usize,
    #[serde(default = "default_window_radius")]
    after: usize,
    cursor: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CreateStoryboardRequestBody {
    name: String,
    insert_after_id: NullableString,
    reuse_assets_from: Option<ReuseAssetsFromRequest>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ReuseAssetsFromRequest {
    storyboard_id: String,
    binding_ids: Vec<String>,
    include_prompt_overrides: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct UpdateStoryboardRequest {
    name: String,
    expected_revision: i64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ExpectedRevisionQuery {
    expected_revision: i64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ReorderRequestBody {
    before_id: NullableString,
    after_id: NullableString,
    expected_revision: i64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct UpdateScriptRequest {
    text: String,
    expected_revision: i64,
}

#[derive(Deserialize)]
struct NullableString(Option<String>);

#[cfg(test)]
#[path = "storyboards_tests.rs"]
mod tests;
