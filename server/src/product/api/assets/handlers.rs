use super::dto::*;
use super::AssetApiState;
use crate::product::api::error::ProductApiError;
use crate::product::application::assets::{
    AssetQuery, CopyAssetBindingsInput, DeleteBinding, DeleteSection, DeleteSectionBindings,
    ReorderSectionInput, UpdateAsset, UpdateBinding, UpdateSection,
};
use crate::product::domain::{AssetBindingId, AssetId, AssetSectionId, ProjectId, StoryboardId};
use axum::extract::rejection::{JsonRejection, QueryRejection};
use axum::extract::{Path, Query, State};
use axum::http::{HeaderMap, StatusCode};
use axum::Json;
use uuid::Uuid;

type ApiResult<T> = Result<T, ProductApiError>;

pub(super) async fn list_sections(
    State(state): State<AssetApiState>,
    Path((project_id, storyboard_id)): Path<(String, String)>,
) -> ApiResult<Json<Vec<AssetSectionResponse>>> {
    let items = state
        .service
        .list_sections(
            parse_project_id(&project_id)?,
            parse_storyboard_id(&storyboard_id)?,
        )
        .await?;
    Ok(Json(items.into_iter().map(Into::into).collect()))
}

pub(super) async fn create_section(
    State(state): State<AssetApiState>,
    Path((project_id, storyboard_id)): Path<(String, String)>,
    headers: HeaderMap,
    payload: Result<Json<CreateSectionRequest>, JsonRejection>,
) -> ApiResult<(StatusCode, Json<AssetSectionResponse>)> {
    let Json(payload) = payload.map_err(ProductApiError::from_json_rejection)?;
    let result = state
        .service
        .create_section(
            parse_project_id(&project_id)?,
            parse_storyboard_id(&storyboard_id)?,
            payload.parent_id,
            payload.name,
            payload.kind,
            idempotency_key(&headers)?,
        )
        .await?;
    Ok((StatusCode::CREATED, Json(result.into())))
}

pub(super) async fn update_section(
    State(state): State<AssetApiState>,
    Path((project_id, storyboard_id, section_id)): Path<(String, String, String)>,
    payload: Result<Json<UpdateSectionRequest>, JsonRejection>,
) -> ApiResult<Json<AssetSectionResponse>> {
    let Json(payload) = payload.map_err(ProductApiError::from_json_rejection)?;
    let result = state
        .service
        .update_section(UpdateSection {
            project_id: parse_project_id(&project_id)?,
            storyboard_id: parse_storyboard_id(&storyboard_id)?,
            section_id: parse_section_id(&section_id)?,
            parent_id: payload.parent_id,
            name: payload.name,
            kind: payload.kind,
            expected_revision: payload.expected_revision,
        })
        .await?;
    Ok(Json(result.into()))
}

pub(super) async fn delete_section(
    State(state): State<AssetApiState>,
    Path((project_id, storyboard_id, section_id)): Path<(String, String, String)>,
    query: Result<Query<DeleteSectionQuery>, QueryRejection>,
) -> ApiResult<StatusCode> {
    let query = query.map_err(ProductApiError::from_query_rejection)?.0;
    let bindings = match (query.binding_action, query.target_section_id) {
        (BindingAction::Move, Some(target_section_id)) => {
            DeleteSectionBindings::Move { target_section_id }
        }
        (BindingAction::Move, None) => {
            return Err(ProductApiError::invalid_request(
                "targetSectionId is required when bindingAction is move",
            ));
        }
        (BindingAction::Detach, None) => DeleteSectionBindings::Detach,
        (BindingAction::Detach, Some(_)) => {
            return Err(ProductApiError::invalid_request(
                "targetSectionId cannot be used when bindingAction is detach",
            ));
        }
    };
    state
        .service
        .delete_section(DeleteSection {
            project_id: parse_project_id(&project_id)?,
            storyboard_id: parse_storyboard_id(&storyboard_id)?,
            section_id: parse_section_id(&section_id)?,
            bindings,
            expected_revision: query.expected_revision,
        })
        .await?;
    Ok(StatusCode::NO_CONTENT)
}

pub(super) async fn reorder_section(
    State(state): State<AssetApiState>,
    Path((project_id, storyboard_id, section_id)): Path<(String, String, String)>,
    headers: HeaderMap,
    payload: Result<Json<ReorderRequest<AssetSectionId>>, JsonRejection>,
) -> ApiResult<Json<AssetSectionResponse>> {
    let Json(payload) = payload.map_err(ProductApiError::from_json_rejection)?;
    let result = state
        .service
        .reorder_section(
            ReorderSectionInput {
                project_id: parse_project_id(&project_id)?,
                storyboard_id: parse_storyboard_id(&storyboard_id)?,
                section_id: parse_section_id(&section_id)?,
                before_id: payload.before_id,
                after_id: payload.after_id,
                expected_revision: payload.expected_revision,
            },
            idempotency_key(&headers)?,
        )
        .await?;
    Ok(Json(result.into()))
}

pub(super) async fn list_assets(
    State(state): State<AssetApiState>,
    Path(project): Path<String>,
    query: Result<Query<AssetListQuery>, QueryRejection>,
) -> ApiResult<Json<AssetListResponse>> {
    let query = query.map_err(ProductApiError::from_query_rejection)?.0;
    let result = state
        .service
        .list_assets(AssetQuery {
            project_id: parse_project_id(&project)?,
            kind: query.kind,
            query: query.query,
            cursor: query.cursor,
            limit: query.limit.unwrap_or(50),
        })
        .await?;
    Ok(Json(result.into()))
}

pub(super) async fn create_asset(
    State(state): State<AssetApiState>,
    Path(project): Path<String>,
    headers: HeaderMap,
    payload: Result<Json<CreateAssetRequest>, JsonRejection>,
) -> ApiResult<(StatusCode, Json<AssetResponse>)> {
    let Json(payload) = payload.map_err(ProductApiError::from_json_rejection)?;
    let result = state
        .service
        .create_asset(
            parse_project_id(&project)?,
            payload.kind,
            payload.name,
            payload.description,
            payload.canonical_prompt,
            idempotency_key(&headers)?,
        )
        .await?;
    Ok((StatusCode::CREATED, Json(result.into())))
}

pub(super) async fn get_asset(
    State(state): State<AssetApiState>,
    Path((project, asset)): Path<(String, String)>,
) -> ApiResult<Json<AssetResponse>> {
    Ok(Json(
        state
            .service
            .get_asset(parse_project_id(&project)?, parse_asset_id(&asset)?)
            .await?
            .into(),
    ))
}

pub(super) async fn update_asset(
    State(state): State<AssetApiState>,
    Path((project, asset)): Path<(String, String)>,
    payload: Result<Json<UpdateAssetRequest>, JsonRejection>,
) -> ApiResult<Json<AssetResponse>> {
    let Json(payload) = payload.map_err(ProductApiError::from_json_rejection)?;
    let result = state
        .service
        .update_asset(UpdateAsset {
            project_id: parse_project_id(&project)?,
            asset_id: parse_asset_id(&asset)?,
            kind: payload.kind,
            name: payload.name,
            description: payload.description,
            canonical_prompt: payload.canonical_prompt,
            expected_revision: payload.expected_revision,
        })
        .await?;
    Ok(Json(result.into()))
}

pub(super) async fn delete_asset(
    State(state): State<AssetApiState>,
    Path((project, asset)): Path<(String, String)>,
    query: Result<Query<ExpectedRevisionQuery>, QueryRejection>,
) -> ApiResult<StatusCode> {
    let query = query.map_err(ProductApiError::from_query_rejection)?.0;
    state
        .service
        .delete_asset(
            parse_project_id(&project)?,
            parse_asset_id(&asset)?,
            query.expected_revision,
        )
        .await?;
    Ok(StatusCode::NO_CONTENT)
}

pub(super) async fn create_representation(
    State(state): State<AssetApiState>,
    Path((project, asset)): Path<(String, String)>,
    headers: HeaderMap,
    payload: Result<Json<CreateRepresentationRequest>, JsonRejection>,
) -> ApiResult<(StatusCode, Json<AssetResponse>)> {
    let Json(payload) = payload.map_err(ProductApiError::from_json_rejection)?;
    let result = state
        .service
        .create_representation(
            parse_project_id(&project)?,
            parse_asset_id(&asset)?,
            payload.label,
            payload.view_kind,
            payload.media_id,
            idempotency_key(&headers)?,
        )
        .await?;
    Ok((StatusCode::CREATED, Json(result.into())))
}

pub(super) async fn list_bindings(
    State(state): State<AssetApiState>,
    Path((project, storyboard)): Path<(String, String)>,
) -> ApiResult<Json<Vec<AssetBindingResponse>>> {
    let items = state
        .service
        .list_bindings(
            parse_project_id(&project)?,
            parse_storyboard_id(&storyboard)?,
        )
        .await?;
    Ok(Json(items.into_iter().map(Into::into).collect()))
}

pub(super) async fn create_bindings(
    State(state): State<AssetApiState>,
    Path((project, storyboard)): Path<(String, String)>,
    headers: HeaderMap,
    payload: Result<Json<CreateBindingsRequest>, JsonRejection>,
) -> ApiResult<(StatusCode, Json<Vec<AssetBindingResponse>>)> {
    let Json(payload) = payload.map_err(ProductApiError::from_json_rejection)?;
    let items = state
        .service
        .create_bindings(
            parse_project_id(&project)?,
            parse_storyboard_id(&storyboard)?,
            payload.section_id,
            payload.asset_ids,
            idempotency_key(&headers)?,
        )
        .await?;
    Ok((
        StatusCode::CREATED,
        Json(items.into_iter().map(Into::into).collect()),
    ))
}

pub(super) async fn update_binding(
    State(state): State<AssetApiState>,
    Path((project, storyboard, binding)): Path<(String, String, String)>,
    payload: Result<Json<UpdateBindingRequest>, JsonRejection>,
) -> ApiResult<Json<AssetBindingResponse>> {
    let Json(payload) = payload.map_err(ProductApiError::from_json_rejection)?;
    let result = state
        .service
        .update_binding(UpdateBinding {
            project_id: parse_project_id(&project)?,
            storyboard_id: parse_storyboard_id(&storyboard)?,
            binding_id: parse_binding_id(&binding)?,
            section_id: payload.section_id,
            prompt_override: payload.prompt_override,
            before_id: payload.before_id,
            after_id: payload.after_id,
            expected_revision: payload.expected_revision,
        })
        .await?;
    Ok(Json(result.into()))
}

pub(super) async fn delete_binding(
    State(state): State<AssetApiState>,
    Path((project, storyboard, binding)): Path<(String, String, String)>,
    query: Result<Query<ExpectedRevisionQuery>, QueryRejection>,
) -> ApiResult<StatusCode> {
    let query = query.map_err(ProductApiError::from_query_rejection)?.0;
    state
        .service
        .delete_binding(DeleteBinding {
            project_id: parse_project_id(&project)?,
            storyboard_id: parse_storyboard_id(&storyboard)?,
            binding_id: parse_binding_id(&binding)?,
            expected_revision: query.expected_revision,
        })
        .await?;
    Ok(StatusCode::NO_CONTENT)
}

pub(super) async fn copy_bindings(
    State(state): State<AssetApiState>,
    Path((project, source_storyboard)): Path<(String, String)>,
    headers: HeaderMap,
    payload: Result<Json<CopyBindingsRequest>, JsonRejection>,
) -> ApiResult<Json<CopyBindingsResponse>> {
    let Json(payload) = payload.map_err(ProductApiError::from_json_rejection)?;
    let DuplicateBindingStrategy::Skip = payload.on_duplicate;
    let result = state
        .service
        .copy_bindings(
            CopyAssetBindingsInput {
                project_id: parse_project_id(&project)?,
                source_storyboard_id: parse_storyboard_id(&source_storyboard)?,
                target_storyboard_id: payload.target_storyboard_id,
                binding_ids: payload.binding_ids,
                include_section_structure: payload.include_section_structure,
                target_section_id: payload.target_section_id,
                include_prompt_overrides: payload.include_prompt_overrides,
            },
            idempotency_key(&headers)?,
        )
        .await?;
    Ok(Json(result.into()))
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

fn parse_section_id(value: &str) -> ApiResult<AssetSectionId> {
    Ok(AssetSectionId::from(parse_uuid("sectionId", value)?))
}

fn parse_asset_id(value: &str) -> ApiResult<AssetId> {
    Ok(AssetId::from(parse_uuid("assetId", value)?))
}

fn parse_binding_id(value: &str) -> ApiResult<AssetBindingId> {
    Ok(AssetBindingId::from(parse_uuid("bindingId", value)?))
}
