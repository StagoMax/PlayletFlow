use crate::{history, rate_limit::RateLimiter, runtime};
use axum::extract::{DefaultBodyLimit, State};
use axum::http::{HeaderMap, StatusCode};
use axum::routing::{get, post};
use axum::{Json, Router};
use opentopia_core::model::{AgentEvent, AgentEventPayload, Message, MessageRole};
use opentopia_core::provider::ModelProvider;
use opentopia_core::tools::ToolRegistry;
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::path::PathBuf;
use std::sync::Arc;
use uuid::Uuid;

#[derive(Clone)]
pub struct CloudState {
    pub provider: Arc<dyn ModelProvider>,
    pub tools: ToolRegistry,
    pub workspace: PathBuf,
    pub rate_limit: Arc<RateLimiter>,
}

pub fn router(state: CloudState) -> Router {
    Router::new()
        .route("/health", get(|| async { Json(json!({"status": "ok", "runtime": "opentopia-agent-core"})) }))
        .route("/api/turn", post(turn))
        .layer(DefaultBodyLimit::max(64 * 1024))
        .with_state(state)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct TurnRequest {
    thread_id: Uuid,
    message: Message,
    messages: Vec<Message>,
    events: Vec<AgentEvent>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct TurnResponse {
    message: Message,
    turn_id: Uuid,
    events: Vec<AgentEvent>,
}

async fn turn(
    State(state): State<CloudState>,
    headers: HeaderMap,
    Json(request): Json<TurnRequest>,
) -> Result<Json<TurnResponse>, (StatusCode, Json<serde_json::Value>)> {
    let client = headers
        .get("x-vercel-forwarded-for")
        .or_else(|| headers.get("x-forwarded-for"))
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.split(',').next())
        .unwrap_or("unknown")
        .trim();
    if !state.rate_limit.check(client) {
        return Err(error(StatusCode::TOO_MANY_REQUESTS, "too many requests; please retry in one minute"));
    }
    validate(&request).map_err(|reason| error(StatusCode::BAD_REQUEST, reason))?;
    let user = request.message;
    let content = user
        .parts
        .iter()
        .filter_map(|part| match part {
            opentopia_core::model::MessagePart::Text { text } => Some(text.as_str()),
            _ => None,
        })
        .collect::<Vec<_>>()
        .join("\n");
    let turn_id = Uuid::new_v4();
    let history = history::project_history(&request.messages, &request.events);
    let result = runtime::run_once(
        state.provider,
        state.tools,
        state.workspace,
        request.thread_id,
        turn_id,
        user.id,
        content,
        history,
        None,
    )
    .await
    .map_err(|cause| {
        eprintln!("cloud turn failed: {cause:#}");
        error(StatusCode::BAD_GATEWAY, "model request failed")
    })?;
    let next_seq = request.events.last().map_or(0, |event| event.seq) + 1;
    let events = result
        .events
        .into_iter()
        .filter(visible_payload)
        .enumerate()
        .map(|(offset, payload)| {
            AgentEvent::new(request.thread_id, Some(turn_id), next_seq + offset as i64, payload)
        })
        .collect();
    Ok(Json(TurnResponse { message: user, turn_id, events }))
}

fn validate(request: &TurnRequest) -> Result<(), &'static str> {
    let content = request.message.parts.iter().filter_map(|part| match part {
        opentopia_core::model::MessagePart::Text { text } => Some(text.as_str()),
        _ => None,
    }).collect::<Vec<_>>().join("\n");
    if content.trim().is_empty() || content.chars().count() > 2_000 {
        return Err("message must contain 1 to 2000 characters");
    }
    if request.message.thread_id != request.thread_id || request.message.role != MessageRole::User {
        return Err("invalid user message");
    }
    if request.messages.len() > 40 || request.events.len() > 160 {
        return Err("conversation history limit exceeded");
    }
    if request.messages.iter().any(|message| {
        message.thread_id != request.thread_id
            || !matches!(message.role, MessageRole::User | MessageRole::Assistant)
    }) || request.events.iter().any(|event| event.thread_id != request.thread_id)
    {
        return Err("invalid conversation history");
    }
    Ok(())
}

fn visible_payload(payload: &AgentEventPayload) -> bool {
    matches!(
        payload,
        AgentEventPayload::TurnStarted { .. }
            | AgentEventPayload::ToolCallStarted { .. }
            | AgentEventPayload::ToolCallFinished { .. }
            | AgentEventPayload::AssistantMessage { .. }
            | AgentEventPayload::TurnFinished { .. }
            | AgentEventPayload::Error { .. }
    )
}

fn error(status: StatusCode, reason: impl Into<String>) -> (StatusCode, Json<serde_json::Value>) {
    (status, Json(json!({ "error": reason.into() })))
}
