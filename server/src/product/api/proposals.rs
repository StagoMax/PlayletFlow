use super::error::ProductApiError;
use crate::product::application::proposals::{
    ApplyProposalResult, ProposalListQuery, ProposalService,
};
use crate::product::domain::{
    ChangeProposal, GenerationJob, GenerationJobId, GenerationOptions, GenerationSpec,
    GenerationStatus, MediaId, ProductError, ProjectId, ProposalId, ProposalSource, ProposalStatus,
    ProposalTarget, StoryboardId,
};
use axum::extract::rejection::{JsonRejection, QueryRejection};
use axum::extract::{Path, Query, State};
use axum::http::HeaderMap;
use axum::routing::{get, post};
use axum::{Json, Router};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use uuid::Uuid;

#[derive(Clone)]
struct ProposalApiState {
    service: ProposalService,
}

pub fn router(service: ProposalService) -> Router {
    Router::new()
        .route(
            "/api/v1/projects/:project_id/storyboards/:storyboard_id/proposals",
            get(list_proposals),
        )
        .route(
            "/api/v1/projects/:project_id/proposals/:proposal_id",
            get(get_proposal),
        )
        .route(
            "/api/v1/projects/:project_id/proposals/:proposal_id/apply",
            post(apply_proposal),
        )
        .route(
            "/api/v1/projects/:project_id/proposals/:proposal_id/reject",
            post(reject_proposal),
        )
        .with_state(ProposalApiState { service })
}

#[derive(Debug, Default, Deserialize)]
#[serde(deny_unknown_fields)]
struct ProposalListParams {
    status: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ResolveProposalRequest {
    expected_proposal_revision: i64,
    expected_target_revision: i64,
    #[serde(default)]
    generation: Option<GenerationOptions>,
}

async fn list_proposals(
    State(state): State<ProposalApiState>,
    Path((project_id, storyboard_id)): Path<(String, String)>,
    params: Result<Query<ProposalListParams>, QueryRejection>,
) -> Result<Json<Vec<ProposalResponse>>, ProductApiError> {
    let project_id = ProjectId(parse_uuid("projectId", &project_id)?);
    let storyboard_id = StoryboardId(parse_uuid("storyboardId", &storyboard_id)?);
    let params = params.map_err(ProductApiError::from_query_rejection)?.0;
    let proposals = state
        .service
        .list(ProposalListQuery {
            project_id,
            storyboard_id,
            statuses: parse_statuses(params.status.as_deref())?,
        })
        .await?;
    Ok(Json(proposals.into_iter().map(Into::into).collect()))
}

async fn get_proposal(
    State(state): State<ProposalApiState>,
    Path((project_id, proposal_id)): Path<(String, String)>,
) -> Result<Json<ProposalResponse>, ProductApiError> {
    let project_id = ProjectId(parse_uuid("projectId", &project_id)?);
    let proposal_id = ProposalId(parse_uuid("proposalId", &proposal_id)?);
    Ok(Json(
        state.service.get(project_id, proposal_id).await?.into(),
    ))
}

async fn apply_proposal(
    State(state): State<ProposalApiState>,
    Path((project_id, proposal_id)): Path<(String, String)>,
    headers: HeaderMap,
    body: Result<Json<ResolveProposalRequest>, JsonRejection>,
) -> Result<Json<ApplyProposalResponse>, ProductApiError> {
    let project_id = ProjectId(parse_uuid("projectId", &project_id)?);
    let proposal_id = ProposalId(parse_uuid("proposalId", &proposal_id)?);
    let body = body.map_err(ProductApiError::from_json_rejection)?.0;
    Ok(Json(
        state
            .service
            .apply_with_generation(
                project_id,
                proposal_id,
                body.expected_proposal_revision,
                body.expected_target_revision,
                body.generation,
                idempotency_key(&headers)?,
            )
            .await?
            .into(),
    ))
}

async fn reject_proposal(
    State(state): State<ProposalApiState>,
    Path((project_id, proposal_id)): Path<(String, String)>,
    headers: HeaderMap,
    body: Result<Json<ResolveProposalRequest>, JsonRejection>,
) -> Result<Json<ProposalResponse>, ProductApiError> {
    let project_id = ProjectId(parse_uuid("projectId", &project_id)?);
    let proposal_id = ProposalId(parse_uuid("proposalId", &proposal_id)?);
    let body = body.map_err(ProductApiError::from_json_rejection)?.0;
    Ok(Json(
        state
            .service
            .reject(
                project_id,
                proposal_id,
                body.expected_proposal_revision,
                body.expected_target_revision,
                idempotency_key(&headers)?,
            )
            .await?
            .into(),
    ))
}

fn parse_uuid(field: &str, value: &str) -> Result<Uuid, ProductApiError> {
    Uuid::parse_str(value)
        .map_err(|_| ProductApiError::invalid_request(format!("{field} must be a UUID")))
}

fn parse_statuses(value: Option<&str>) -> Result<Vec<ProposalStatus>, ProductApiError> {
    let mut statuses = Vec::new();
    let mut seen = HashSet::new();
    for status in value.into_iter().flat_map(|value| value.split(',')) {
        let status = status.trim();
        if status.is_empty() {
            continue;
        }
        let parsed = ProposalStatus::from_api_str(status).ok_or_else(|| {
            ProductApiError::from(ProductError::Validation(format!(
                "unsupported proposal status: {status}"
            )))
        })?;
        if seen.insert(parsed) {
            statuses.push(parsed);
        }
    }
    Ok(statuses)
}

fn idempotency_key(headers: &HeaderMap) -> Result<String, ProductApiError> {
    headers
        .get("idempotency-key")
        .ok_or_else(|| ProductApiError::invalid_request("Idempotency-Key header is required"))?
        .to_str()
        .map(str::to_owned)
        .map_err(|_| ProductApiError::invalid_request("Idempotency-Key must be valid text"))
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ProposalResponse {
    id: ProposalId,
    project_id: ProjectId,
    storyboard_id: StoryboardId,
    target: ProposalTarget,
    base_revision: i64,
    before_value: String,
    proposed_value: String,
    summary: String,
    status: ProposalStatus,
    source: ProposalSourceResponse,
    revision: i64,
    created_at: DateTime<Utc>,
    resolved_at: Option<DateTime<Utc>>,
}

impl From<ChangeProposal> for ProposalResponse {
    fn from(value: ChangeProposal) -> Self {
        Self {
            id: value.id,
            project_id: value.project_id,
            storyboard_id: value.storyboard_id,
            target: value.target,
            base_revision: value.base_revision,
            before_value: value.before_value,
            proposed_value: value.proposed_value,
            summary: value.summary,
            status: value.status,
            source: value.source.into(),
            revision: value.revision,
            created_at: value.created_at,
            resolved_at: value.resolved_at,
        }
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ProposalSourceResponse {
    #[serde(rename = "type")]
    source_type: &'static str,
    thread_id: Uuid,
    turn_id: Uuid,
    tool_call_id: String,
}

impl From<ProposalSource> for ProposalSourceResponse {
    fn from(value: ProposalSource) -> Self {
        Self {
            source_type: "ai",
            thread_id: value.thread_id,
            turn_id: value.turn_id,
            tool_call_id: value.tool_call_id,
        }
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ApplyProposalResponse {
    proposal: ProposalResponse,
    target: AppliedTargetResponse,
    generation_job: Option<GenerationJobResponse>,
}

impl From<ApplyProposalResult> for ApplyProposalResponse {
    fn from(value: ApplyProposalResult) -> Self {
        Self {
            proposal: value.proposal.into(),
            target: AppliedTargetResponse {
                target_type: value.target.target_type,
                revision: value.target.revision,
            },
            generation_job: value.generation_job.map(Into::into),
        }
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct AppliedTargetResponse {
    #[serde(rename = "type")]
    target_type: String,
    revision: i64,
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
mod tests {
    use super::*;
    use crate::product::application::proposals::CreateProposal;
    use crate::product::infrastructure::sqlite::SqliteProposalRepository;
    use crate::product::ProductDatabase;
    use axum::body::{to_bytes, Body};
    use axum::http::{Request, StatusCode};
    use rusqlite::params;
    use serde_json::{json, Value};
    use std::path::PathBuf;
    use std::sync::Arc;
    use tower::ServiceExt;

    struct ApiFixture {
        database: ProductDatabase,
        path: PathBuf,
        project_id: ProjectId,
        storyboard_id: StoryboardId,
    }

    impl ApiFixture {
        fn new() -> Self {
            let path = std::env::temp_dir()
                .join(format!("videoflow-proposal-api-{}.sqlite", Uuid::new_v4()));
            let database = ProductDatabase::open(&path).unwrap();
            let fixture = Self {
                database,
                path,
                project_id: ProjectId::new(),
                storyboard_id: StoryboardId::new(),
            };
            let connection = fixture.database.connect().unwrap();
            let now = "2026-09-26T00:00:00Z";
            connection
                .execute(
                    "INSERT INTO projects (id, name, revision, created_at, updated_at) \
                     VALUES (?1, 'API project', 1, ?2, ?2)",
                    params![fixture.project_id.to_string(), now],
                )
                .unwrap();
            connection
                .execute(
                    "INSERT INTO storyboards \
                     (id, project_id, name, position, revision, created_at, updated_at) \
                     VALUES (?1, ?2, 'Opening', 'a', 1, ?3, ?3)",
                    params![
                        fixture.storyboard_id.to_string(),
                        fixture.project_id.to_string(),
                        now
                    ],
                )
                .unwrap();
            connection
                .execute(
                    "INSERT INTO storyboard_scripts (storyboard_id, text, revision, updated_at) \
                     VALUES (?1, 'before', 1, ?2)",
                    params![fixture.storyboard_id.to_string(), now],
                )
                .unwrap();
            drop(connection);
            fixture
        }

        async fn create(&self, value: &str, call: &str) -> ChangeProposal {
            ProposalService::new(Arc::new(SqliteProposalRepository::new(
                self.database.clone(),
            )))
            .create(CreateProposal {
                project_id: self.project_id,
                storyboard_id: self.storyboard_id,
                target: ProposalTarget::Script {
                    storyboard_id: self.storyboard_id,
                },
                proposed_value: value.into(),
                summary: "API proposal".into(),
                source: ProposalSource {
                    thread_id: Uuid::new_v4(),
                    turn_id: Uuid::new_v4(),
                    tool_call_id: call.into(),
                },
            })
            .await
            .unwrap()
        }
    }

    impl Drop for ApiFixture {
        fn drop(&mut self) {
            for path in [
                self.path.clone(),
                PathBuf::from(format!("{}-wal", self.path.display())),
                PathBuf::from(format!("{}-shm", self.path.display())),
            ] {
                let _ = std::fs::remove_file(path);
            }
        }
    }

    #[test]
    fn parses_status_filter() {
        assert_eq!(
            parse_statuses(Some("pending,conflicted,pending")).unwrap(),
            vec![ProposalStatus::Pending, ProposalStatus::Conflicted]
        );
        assert!(parse_statuses(Some("unknown")).is_err());
    }

    #[tokio::test]
    async fn product_entry_lists_applies_and_rejects_proposals() {
        let fixture = ApiFixture::new();
        let proposal = fixture.create("applied text", "api-call-1").await;
        let router = crate::product::api::router(fixture.database.clone());
        let list_uri = format!(
            "/api/v1/projects/{}/storyboards/{}/proposals?status=pending",
            fixture.project_id, fixture.storyboard_id
        );
        let list = router
            .clone()
            .oneshot(Request::get(list_uri).body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert_eq!(list.status(), StatusCode::OK);
        let list: Value =
            serde_json::from_slice(&to_bytes(list.into_body(), 64_000).await.unwrap()).unwrap();
        assert_eq!(list[0]["source"]["type"], "ai");
        assert_eq!(list[0]["target"]["type"], "script");
        assert_eq!(
            list[0]["target"]["storyboardId"],
            fixture.storyboard_id.to_string()
        );

        let apply_uri = format!(
            "/api/v1/projects/{}/proposals/{}/apply",
            fixture.project_id, proposal.id
        );
        let apply = router
            .clone()
            .oneshot(
                Request::post(apply_uri)
                    .header("content-type", "application/json")
                    .header("idempotency-key", "api-apply-001")
                    .body(Body::from(
                        json!({
                            "expectedProposalRevision": 1,
                            "expectedTargetRevision": 1
                        })
                        .to_string(),
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(apply.status(), StatusCode::OK);
        let apply: Value =
            serde_json::from_slice(&to_bytes(apply.into_body(), 64_000).await.unwrap()).unwrap();
        assert_eq!(apply["proposal"]["status"], "applied");
        assert_eq!(apply["target"], json!({ "type": "script", "revision": 2 }));
        assert_eq!(apply["generationJob"], Value::Null);

        let rejected = fixture.create("unused text", "api-call-2").await;
        let reject_uri = format!(
            "/api/v1/projects/{}/proposals/{}/reject",
            fixture.project_id, rejected.id
        );
        let reject = router
            .oneshot(
                Request::post(reject_uri)
                    .header("content-type", "application/json")
                    .header("idempotency-key", "api-reject-001")
                    .body(Body::from(
                        json!({
                            "expectedProposalRevision": 1,
                            "expectedTargetRevision": 2
                        })
                        .to_string(),
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(reject.status(), StatusCode::OK);
        let reject: Value =
            serde_json::from_slice(&to_bytes(reject.into_body(), 64_000).await.unwrap()).unwrap();
        assert_eq!(reject["status"], "rejected");
    }
}
