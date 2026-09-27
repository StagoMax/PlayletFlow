use super::error::ProductApiError;
use crate::product::application::generation::{
    generation_models, GenerationModel, GenerationService, RequestMediaGenerationInput,
};
use crate::product::domain::{
    GenerationJob, GenerationJobId, GenerationOptions, GenerationSpec, GenerationStatus, MediaId,
    ProjectId, ProposalId, StoryboardId,
};
use axum::extract::{Path, State};
use axum::http::{HeaderMap, StatusCode};
use axum::routing::{get, post};
use axum::{Json, Router};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

#[derive(Clone)]
struct GenerationApiState {
    service: GenerationService,
}

pub fn router(service: GenerationService) -> Router {
    Router::new()
        .route("/api/v1/generation-models", get(list_generation_models))
        .route(
            "/api/v1/projects/:project_id/generation-jobs/:job_id",
            get(get_generation_job),
        )
        .route(
            "/api/v1/projects/:project_id/media/:media_id/generation-jobs/latest",
            get(get_latest_media_generation_job),
        )
        .route(
            "/api/v1/projects/:project_id/generation-jobs/:job_id/retry",
            post(retry_generation_job),
        )
        .route(
            "/api/v1/projects/:project_id/storyboards/:storyboard_id/media/:media_id/generations",
            post(request_media_generation),
        )
        .with_state(GenerationApiState { service })
}

async fn list_generation_models() -> Json<Vec<GenerationModel>> {
    Json(generation_models().to_vec())
}

async fn get_generation_job(
    State(state): State<GenerationApiState>,
    Path((project_id, job_id)): Path<(String, String)>,
) -> Result<Json<GenerationJobResponse>, ProductApiError> {
    let project_id = ProjectId(parse_uuid("projectId", &project_id)?);
    let job_id = GenerationJobId(parse_uuid("jobId", &job_id)?);
    Ok(Json(state.service.get(project_id, job_id).await?.into()))
}

async fn get_latest_media_generation_job(
    State(state): State<GenerationApiState>,
    Path((project_id, media_id)): Path<(String, String)>,
) -> Result<Json<Option<GenerationJobResponse>>, ProductApiError> {
    let project_id = ProjectId(parse_uuid("projectId", &project_id)?);
    let media_id = MediaId(parse_uuid("mediaId", &media_id)?);
    Ok(Json(
        state
            .service
            .latest_for_media(project_id, media_id)
            .await?
            .map(Into::into),
    ))
}

async fn retry_generation_job(
    State(state): State<GenerationApiState>,
    Path((project_id, job_id)): Path<(String, String)>,
    headers: HeaderMap,
) -> Result<(StatusCode, Json<GenerationJobResponse>), ProductApiError> {
    let project_id = ProjectId(parse_uuid("projectId", &project_id)?);
    let job_id = GenerationJobId(parse_uuid("jobId", &job_id)?);
    let job = state
        .service
        .retry(project_id, job_id, idempotency_key(&headers)?)
        .await?;
    Ok((StatusCode::ACCEPTED, Json(job.into())))
}

async fn request_media_generation(
    State(state): State<GenerationApiState>,
    Path((project_id, storyboard_id, media_id)): Path<(String, String, String)>,
    headers: HeaderMap,
    Json(request): Json<RequestMediaGenerationBody>,
) -> Result<(StatusCode, Json<GenerationJobResponse>), ProductApiError> {
    let job = state
        .service
        .request_media(RequestMediaGenerationInput {
            project_id: ProjectId(parse_uuid("projectId", &project_id)?),
            storyboard_id: StoryboardId(parse_uuid("storyboardId", &storyboard_id)?),
            media_id: MediaId(parse_uuid("mediaId", &media_id)?),
            prompt: request.prompt,
            expected_revision: request.expected_revision,
            generation_options: request.generation,
            idempotency_key: idempotency_key(&headers)?,
        })
        .await?;
    Ok((StatusCode::ACCEPTED, Json(job.into())))
}

fn parse_uuid(field: &str, value: &str) -> Result<Uuid, ProductApiError> {
    Uuid::parse_str(value)
        .map_err(|_| ProductApiError::invalid_request(format!("{field} must be a UUID")))
}

fn idempotency_key(headers: &HeaderMap) -> Result<String, ProductApiError> {
    headers
        .get("idempotency-key")
        .ok_or_else(|| ProductApiError::invalid_request("Idempotency-Key header is required"))?
        .to_str()
        .map(str::to_owned)
        .map_err(|_| ProductApiError::invalid_request("Idempotency-Key must be valid text"))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RequestMediaGenerationBody {
    prompt: String,
    expected_revision: i64,
    generation: Option<GenerationOptions>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct GenerationJobResponse {
    id: GenerationJobId,
    project_id: ProjectId,
    storyboard_id: StoryboardId,
    proposal_id: Option<ProposalId>,
    target_type: String,
    target_id: String,
    target_revision: i64,
    spec: GenerationSpec,
    status: GenerationStatus,
    attempt: i64,
    provider: Option<String>,
    result_media_id: Option<MediaId>,
    error: Option<String>,
    created_at: DateTime<Utc>,
    updated_at: DateTime<Utc>,
}

impl From<GenerationJob> for GenerationJobResponse {
    fn from(value: GenerationJob) -> Self {
        Self {
            id: value.id,
            project_id: value.project_id,
            storyboard_id: value.storyboard_id,
            proposal_id: value.proposal_id,
            target_type: value.target.target_type().into(),
            target_id: value.target.target_id(),
            target_revision: value.target_revision,
            spec: value.spec,
            status: value.status,
            attempt: value.attempt,
            provider: value.provider,
            result_media_id: value.result_media_id,
            error: value.error,
            created_at: value.created_at,
            updated_at: value.updated_at,
        }
    }
}

#[cfg(test)]
mod tests;
