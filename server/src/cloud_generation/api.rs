use super::record::{CloudGenerationResponse, CreateGenerationBody};
use super::service::{CloudGenerationService, CreateGenerationCommand};
use crate::product::application::generation::{generation_models, GenerationModel};
use crate::product::domain::{GenerationJobId, ProductError};
use crate::rate_limit::RateLimiter;
use axum::extract::{DefaultBodyLimit, Path, State};
use axum::http::{HeaderMap, StatusCode};
use axum::routing::{get, post};
use axum::{Json, Router};
use serde_json::{json, Value};
use std::sync::Arc;
use uuid::Uuid;

const MAX_GENERATION_REQUEST_BYTES: usize = 28 * 1024 * 1024;

#[derive(Clone)]
struct CloudGenerationState {
    service: Arc<tokio::sync::OnceCell<CloudGenerationService>>,
    rate_limit: Arc<RateLimiter>,
}

pub fn router(rate_limit: Arc<RateLimiter>) -> Router {
    Router::new()
        .route("/api/v1/generation-models", get(list_generation_models))
        .route(
            "/api/v1/projects/:project_id/generation-jobs/:job_id",
            get(get_generation),
        )
        .route(
            "/api/v1/projects/:project_id/storyboards/:storyboard_id/media/:media_id/generations",
            post(create_generation),
        )
        .layer(DefaultBodyLimit::max(MAX_GENERATION_REQUEST_BYTES))
        .with_state(CloudGenerationState {
            service: Arc::new(tokio::sync::OnceCell::new()),
            rate_limit,
        })
}

async fn list_generation_models() -> Json<Vec<GenerationModel>> {
    Json(generation_models().to_vec())
}

async fn create_generation(
    State(state): State<CloudGenerationState>,
    Path((project_id, storyboard_id, media_id)): Path<(String, String, String)>,
    headers: HeaderMap,
    Json(body): Json<CreateGenerationBody>,
) -> Result<(StatusCode, Json<CloudGenerationResponse>), ApiError> {
    let client = client_ip(&headers);
    if !state.rate_limit.check(client) {
        return Err(ApiError::new(
            StatusCode::TOO_MANY_REQUESTS,
            "too many requests; please retry in one minute",
        ));
    }
    let idempotency_key = headers
        .get("idempotency-key")
        .ok_or_else(|| ApiError::bad_request("Idempotency-Key header is required"))?
        .to_str()
        .map(str::to_owned)
        .map_err(|_| ApiError::bad_request("Idempotency-Key must be valid text"))?;
    let service = configured_service(&state).await?;
    let response = service
        .create(CreateGenerationCommand {
            project_id,
            storyboard_id,
            target_id: media_id,
            idempotency_key,
            body,
        })
        .await
        .map_err(ApiError::from)?;
    Ok((StatusCode::ACCEPTED, Json(response)))
}

async fn get_generation(
    State(state): State<CloudGenerationState>,
    Path((project_id, job_id)): Path<(String, String)>,
) -> Result<Json<CloudGenerationResponse>, ApiError> {
    let job_id = GenerationJobId(
        Uuid::parse_str(&job_id).map_err(|_| ApiError::bad_request("jobId must be a UUID"))?,
    );
    let service = configured_service(&state).await?;
    service
        .get(&project_id, job_id)
        .await
        .map(Json)
        .map_err(ApiError::from)
}

async fn configured_service(
    state: &CloudGenerationState,
) -> Result<&CloudGenerationService, ApiError> {
    state
        .service
        .get_or_try_init(|| async { CloudGenerationService::from_env() })
        .await
        .map_err(ApiError::from)
}

fn client_ip(headers: &HeaderMap) -> &str {
    headers
        .get("x-vercel-forwarded-for")
        .or_else(|| headers.get("x-forwarded-for"))
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.split(',').next())
        .unwrap_or("unknown")
        .trim()
}

struct ApiError {
    status: StatusCode,
    message: String,
}

impl ApiError {
    fn new(status: StatusCode, message: impl Into<String>) -> Self {
        Self {
            status,
            message: message.into(),
        }
    }

    fn bad_request(message: impl Into<String>) -> Self {
        Self::new(StatusCode::BAD_REQUEST, message)
    }
}

impl From<ProductError> for ApiError {
    fn from(error: ProductError) -> Self {
        match error {
            ProductError::NotFound => Self::new(StatusCode::NOT_FOUND, "generation job not found"),
            ProductError::Validation(message) => Self::bad_request(message),
            ProductError::RevisionConflict { .. } | ProductError::Conflict { .. } => {
                Self::new(StatusCode::CONFLICT, error.to_string())
            }
            ProductError::DependencyUnavailable(message) => {
                eprintln!("generation dependency unavailable: {message}");
                Self::new(
                    StatusCode::SERVICE_UNAVAILABLE,
                    "generation service is temporarily unavailable",
                )
            }
            ProductError::Storage(message) => {
                eprintln!("generation storage failed: {message}");
                Self::new(
                    StatusCode::SERVICE_UNAVAILABLE,
                    "generation storage is temporarily unavailable",
                )
            }
            ProductError::External(message) => {
                eprintln!("generation integration failed: {message}");
                Self::new(StatusCode::BAD_GATEWAY, "generation request failed")
            }
            ProductError::ProviderRejected { .. } => {
                eprintln!("generation provider rejected request: {error}");
                Self::new(StatusCode::BAD_GATEWAY, error.to_string())
            }
        }
    }
}

impl axum::response::IntoResponse for ApiError {
    fn into_response(self) -> axum::response::Response {
        (self.status, Json::<Value>(json!({ "error": self.message }))).into_response()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::{to_bytes, Body};
    use axum::http::Request;
    use tower::ServiceExt;

    #[tokio::test]
    async fn catalog_is_available_without_cloud_credentials() {
        let response = router(Arc::new(RateLimiter::default()))
            .oneshot(
                Request::builder()
                    .uri("/api/v1/generation-models")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let body = to_bytes(response.into_body(), usize::MAX).await.unwrap();
        let models = serde_json::from_slice::<Vec<Value>>(&body).unwrap();
        assert!(models.iter().any(|model| model["kind"] == "image"));
        assert!(models.iter().any(|model| model["kind"] == "video"));
    }
}
