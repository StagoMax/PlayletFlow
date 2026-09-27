use super::CloudWorkspaceStore;
use crate::cloud_generation::record::{
    CloudGenerationInput, CloudGenerationOptions, CreateGenerationBody,
};
use crate::cloud_generation::service::{CloudGenerationService, CreateGenerationCommand};
use crate::rate_limit::RateLimiter;
use axum::extract::{DefaultBodyLimit, Path, Query, State};
use axum::http::{HeaderMap, StatusCode};
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::Deserialize;
use serde_json::{json, Value};
use std::sync::OnceLock;
use uuid::Uuid;

type ApiResult<T> = Result<T, (StatusCode, Json<Value>)>;

pub fn router(store: CloudWorkspaceStore) -> Router {
    Router::new()
        .route(
            "/api/cloud-workspace",
            get(get_workspace)
                .put(put_workspace)
                .layer(DefaultBodyLimit::max(2_000_000)),
        )
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
            post(apply_proposal).layer(DefaultBodyLimit::max(28 * 1024 * 1024)),
        )
        .route(
            "/api/v1/projects/:project_id/proposals/:proposal_id/reject",
            post(reject_proposal),
        )
        .with_state(store)
}

pub fn workspace_token(headers: &HeaderMap) -> ApiResult<Uuid> {
    headers
        .get("x-videoflow-workspace-key")
        .and_then(|value| value.to_str().ok())
        .and_then(|value| Uuid::parse_str(value).ok())
        .filter(|value| value.get_version_num() == 4)
        .ok_or_else(|| err(StatusCode::UNAUTHORIZED, "missing workspace key"))
}

fn err(status: StatusCode, message: &str) -> (StatusCode, Json<Value>) {
    (status, Json(json!({"error": message})))
}

fn failed(error: anyhow::Error) -> (StatusCode, Json<Value>) {
    eprintln!("cloud workspace error: {error:#}");
    err(
        StatusCode::BAD_GATEWAY,
        "cloud workspace storage is unavailable",
    )
}

fn client_ip(headers: &HeaderMap) -> &str {
    headers
        .get("x-vercel-forwarded-for")
        .or_else(|| headers.get("x-forwarded-for"))
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.split(',').next())
        .unwrap_or("unknown")
}

async fn get_workspace(
    State(store): State<CloudWorkspaceStore>,
    headers: HeaderMap,
) -> ApiResult<(HeaderMap, Json<Value>)> {
    let token = workspace_token(&headers)?;
    let current = store
        .get(token)
        .await
        .map_err(failed)?
        .ok_or_else(|| err(StatusCode::NOT_FOUND, "workspace not found"))?;
    let mut response_headers = HeaderMap::new();
    response_headers.insert(
        "x-videoflow-revision",
        current.etag.parse().map_err(|_| {
            err(
                StatusCode::INTERNAL_SERVER_ERROR,
                "invalid storage revision",
            )
        })?,
    );
    Ok((response_headers, Json(current.document.snapshot)))
}

async fn put_workspace(
    State(store): State<CloudWorkspaceStore>,
    headers: HeaderMap,
    Json(snapshot): Json<Value>,
) -> ApiResult<(HeaderMap, Json<Value>)> {
    let token = workspace_token(&headers)?;
    static LIMIT: OnceLock<RateLimiter> = OnceLock::new();
    if !LIMIT
        .get_or_init(|| RateLimiter::with_limits(60, 600))
        .check(client_ip(&headers))
    {
        return Err(err(
            StatusCode::TOO_MANY_REQUESTS,
            "too many workspace writes; retry shortly",
        ));
    }
    if !valid_snapshot(&snapshot) {
        return Err(err(StatusCode::BAD_REQUEST, "invalid workspace snapshot"));
    }
    // Keep storage revisions in application-specific headers. Vercel's edge
    // applies HTTP conditional request semantics to If-Match/If-None-Match and
    // can turn a successful PUT into a 304/412 after the handler has written it.
    let expected = headers
        .get("x-videoflow-revision")
        .and_then(|value| value.to_str().ok());
    if expected.is_none()
        && headers
            .get("x-videoflow-create")
            .and_then(|value| value.to_str().ok())
            != Some("1")
    {
        return Err(err(
            StatusCode::PRECONDITION_REQUIRED,
            "workspace revision is required",
        ));
    }
    let etag = store
        .replace_snapshot(token, snapshot, expected)
        .await
        .map_err(failed)?
        .ok_or_else(|| {
            err(
                StatusCode::PRECONDITION_FAILED,
                "workspace changed; reload before saving",
            )
        })?;
    let mut response_headers = HeaderMap::new();
    response_headers.insert(
        "x-videoflow-revision",
        etag.parse().map_err(|_| {
            err(
                StatusCode::INTERNAL_SERVER_ERROR,
                "invalid storage revision",
            )
        })?,
    );
    Ok((response_headers, Json(json!({"saved": true}))))
}

fn valid_snapshot(snapshot: &Value) -> bool {
    snapshot
        .pointer("/project/id")
        .and_then(Value::as_str)
        .is_some()
        && snapshot
            .get("storyboards")
            .and_then(Value::as_array)
            .is_some()
        && snapshot
            .get("workspaces")
            .and_then(Value::as_object)
            .is_some()
}

#[derive(Deserialize)]
struct ProposalFilter {
    status: Option<String>,
}

async fn list_proposals(
    State(store): State<CloudWorkspaceStore>,
    Path((project_id, storyboard_id)): Path<(String, String)>,
    Query(filter): Query<ProposalFilter>,
    headers: HeaderMap,
) -> ApiResult<Json<Vec<Value>>> {
    let token = workspace_token(&headers)?;
    let current = store
        .get(token)
        .await
        .map_err(failed)?
        .ok_or_else(|| err(StatusCode::NOT_FOUND, "workspace not found"))?;
    if current
        .document
        .snapshot
        .pointer("/project/id")
        .and_then(Value::as_str)
        != Some(&project_id)
    {
        return Err(err(StatusCode::NOT_FOUND, "project not found"));
    }
    let statuses = filter.status.unwrap_or_default();
    let statuses: Vec<&str> = statuses
        .split(',')
        .filter(|item| !item.is_empty())
        .collect();
    let items = current
        .document
        .proposals
        .into_iter()
        .filter(|item| {
            item.get("storyboardId").and_then(Value::as_str) == Some(&storyboard_id)
                && (statuses.is_empty()
                    || item
                        .get("status")
                        .and_then(Value::as_str)
                        .is_some_and(|status| statuses.contains(&status)))
        })
        .collect();
    Ok(Json(items))
}

async fn get_proposal(
    State(store): State<CloudWorkspaceStore>,
    Path((project_id, proposal_id)): Path<(String, String)>,
    headers: HeaderMap,
) -> ApiResult<Json<Value>> {
    let token = workspace_token(&headers)?;
    let current = store
        .get(token)
        .await
        .map_err(failed)?
        .ok_or_else(|| err(StatusCode::NOT_FOUND, "workspace not found"))?;
    current
        .document
        .proposals
        .into_iter()
        .find(|item| {
            item.get("projectId").and_then(Value::as_str) == Some(&project_id)
                && item.get("id").and_then(Value::as_str) == Some(&proposal_id)
        })
        .map(Json)
        .ok_or_else(|| err(StatusCode::NOT_FOUND, "proposal not found"))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ResolveBody {
    expected_proposal_revision: i64,
    expected_target_revision: i64,
    #[serde(default)]
    generation: Option<Value>,
    #[serde(default)]
    inputs: Vec<CloudGenerationInput>,
}

async fn apply_proposal(
    State(store): State<CloudWorkspaceStore>,
    Path((project_id, proposal_id)): Path<(String, String)>,
    headers: HeaderMap,
    Json(body): Json<ResolveBody>,
) -> ApiResult<Json<Value>> {
    resolve(store, project_id, proposal_id, headers, body, true).await
}

async fn reject_proposal(
    State(store): State<CloudWorkspaceStore>,
    Path((project_id, proposal_id)): Path<(String, String)>,
    headers: HeaderMap,
    Json(body): Json<ResolveBody>,
) -> ApiResult<Json<Value>> {
    resolve(store, project_id, proposal_id, headers, body, false).await
}

async fn resolve(
    store: CloudWorkspaceStore,
    project_id: String,
    proposal_id: String,
    headers: HeaderMap,
    body: ResolveBody,
    apply: bool,
) -> ApiResult<Json<Value>> {
    let token = workspace_token(&headers)?;
    if apply {
        static LIMIT: OnceLock<RateLimiter> = OnceLock::new();
        if !LIMIT
            .get_or_init(RateLimiter::default)
            .check(client_ip(&headers))
        {
            return Err(err(
                StatusCode::TOO_MANY_REQUESTS,
                "too many proposal applications; retry shortly",
            ));
        }
    }
    let current = store
        .get(token)
        .await
        .map_err(failed)?
        .ok_or_else(|| err(StatusCode::NOT_FOUND, "workspace not found"))?;
    let proposal = current
        .document
        .proposals
        .iter()
        .find(|item| {
            item.get("id").and_then(Value::as_str) == Some(&proposal_id)
                && item.get("projectId").and_then(Value::as_str) == Some(&project_id)
        })
        .ok_or_else(|| err(StatusCode::NOT_FOUND, "proposal not found"))?;
    if apply && proposal.get("status").and_then(Value::as_str) == Some("applied") {
        if let Some(saved) = proposal.get("applyResponse") {
            return Ok(Json(saved.clone()));
        }
    }
    if !apply && proposal.get("status").and_then(Value::as_str) == Some("rejected") {
        return Ok(Json(proposal.clone()));
    }
    if proposal.get("status").and_then(Value::as_str) != Some("pending")
        || proposal.get("revision").and_then(Value::as_i64) != Some(body.expected_proposal_revision)
        || proposal.get("baseRevision").and_then(Value::as_i64)
            != Some(body.expected_target_revision)
    {
        return Err(err(StatusCode::CONFLICT, "proposal or target changed"));
    }
    let mut generation_job = Value::Null;
    if apply && proposal.pointer("/target/type").and_then(Value::as_str) != Some("script") {
        let input = proposal
            .get("proposedInput")
            .cloned()
            .unwrap_or(json!({"type":"textOnly"}));
        let mut options = body.generation.clone().unwrap_or_else(|| json!({}));
        if !options.is_object() {
            return Err(err(StatusCode::BAD_REQUEST, "invalid generation options"));
        }
        if options.get("input").is_none() {
            options["input"] = input;
        }
        let options: CloudGenerationOptions = serde_json::from_value(options)
            .map_err(|_| err(StatusCode::BAD_REQUEST, "invalid generation options"))?;
        let target_type = proposal
            .pointer("/target/type")
            .and_then(Value::as_str)
            .unwrap_or("");
        let target_id = proposal
            .pointer("/target/mediaId")
            .or_else(|| proposal.pointer("/target/bindingId"))
            .and_then(Value::as_str)
            .ok_or_else(|| err(StatusCode::BAD_REQUEST, "invalid proposal target"))?;
        let storyboard_id = proposal
            .get("storyboardId")
            .and_then(Value::as_str)
            .unwrap_or("");
        let media = if target_type == "mediaPrompt" {
            current
                .document
                .snapshot
                .get("objectMedia")
                .and_then(Value::as_object)
                .and_then(|items| {
                    items
                        .values()
                        .find(|media| media.get("id").and_then(Value::as_str) == Some(target_id))
                })
        } else {
            let ws = &current.document.snapshot["workspaces"][storyboard_id];
            ["assetGroups", "videoGroups"]
                .iter()
                .flat_map(|key| ws.get(key).and_then(Value::as_array).into_iter().flatten())
                .flat_map(|group| {
                    group
                        .get("items")
                        .and_then(Value::as_array)
                        .into_iter()
                        .flatten()
                })
                .find(|item| item.get("id").and_then(Value::as_str) == Some(target_id))
                .and_then(|item| item.get("media"))
        }
        .ok_or_else(|| err(StatusCode::NOT_FOUND, "proposal media not found"))?;
        let media_id = media.get("id").and_then(Value::as_str).unwrap_or(target_id);
        let kind = serde_json::from_value(json!(media
            .get("kind")
            .and_then(Value::as_str)
            .unwrap_or("image")))
        .map_err(|_| err(StatusCode::BAD_REQUEST, "invalid media kind"))?;
        let service = CloudGenerationService::from_env().map_err(|cause| failed(cause.into()))?;
        let job = service
            .create(CreateGenerationCommand {
                project_id: project_id.clone(),
                storyboard_id: storyboard_id.to_owned(),
                target_id: media_id.to_owned(),
                idempotency_key: format!("proposal-{proposal_id}"),
                body: CreateGenerationBody {
                    prompt: proposal
                        .get("proposedValue")
                        .and_then(Value::as_str)
                        .unwrap_or("")
                        .to_owned(),
                    expected_revision: body.expected_target_revision,
                    kind,
                    generation: Some(options),
                    inputs: body.inputs.clone(),
                },
            })
            .await
            .map_err(|cause| failed(cause.into()))?;
        generation_job = serde_json::to_value(job).map_err(|cause| failed(cause.into()))?;
        generation_job["proposalId"] = json!(proposal_id);
        generation_job["targetType"] = json!(target_type);
    }
    let result = store.mutate(token, |document| {
        let proposal = document.proposals.iter_mut().find(|item|
            item.get("id").and_then(Value::as_str) == Some(&proposal_id)
                && item.get("projectId").and_then(Value::as_str) == Some(&project_id))
            .ok_or_else(|| anyhow::anyhow!("proposal not found"))?;
        if proposal.get("status").and_then(Value::as_str) != Some("pending")
            || proposal.get("revision").and_then(Value::as_i64) != Some(body.expected_proposal_revision) {
            anyhow::bail!("proposal changed; reload before resolving");
        }
        let target = proposal.get("target").cloned().unwrap_or(Value::Null);
        let storyboard_id = proposal.get("storyboardId").and_then(Value::as_str).unwrap_or("").to_owned();
        let proposed = proposal.get("proposedValue").and_then(Value::as_str).unwrap_or("").to_owned();
        let target_result = if apply {
            super::tools::apply_proposed_value(&mut document.snapshot, &storyboard_id, &target, body.expected_target_revision, &proposed)?
        } else { Value::Null };
        if apply { super::tools::apply_generation_state(&mut document.snapshot, &storyboard_id, &target, &generation_job)?; }
        proposal["status"] = json!(if apply { "applied" } else { "rejected" });
        proposal["revision"] = json!(body.expected_proposal_revision + 1);
        proposal["resolvedAt"] = json!(chrono::Utc::now().to_rfc3339());
        let updated = proposal.clone();
        if apply {
            let response = json!({"proposal": updated, "target": target_result, "generationJob": generation_job});
            proposal["applyResponse"] = response.clone();
            Ok(response)
        } else { Ok(updated) }
    }).await.map_err(|cause| {
        if cause.to_string().contains("changed") { err(StatusCode::CONFLICT, "proposal or target changed") }
        else if cause.to_string().contains("not found") { err(StatusCode::NOT_FOUND, "proposal not found") }
        else { failed(cause) }
    })?;
    Ok(Json(result))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn workspace_key_requires_a_random_uuid() {
        let mut headers = HeaderMap::new();
        assert!(workspace_token(&headers).is_err());
        headers.insert(
            "x-videoflow-workspace-key",
            Uuid::new_v4().to_string().parse().unwrap(),
        );
        assert!(workspace_token(&headers).is_ok());
        headers.insert(
            "x-videoflow-workspace-key",
            Uuid::nil().to_string().parse().unwrap(),
        );
        assert!(workspace_token(&headers).is_err());
    }
}
