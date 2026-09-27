use crate::{
    cloud_generation, cloud_workspace, conversation_events::conversation_payload,
    conversation_references::message_model_text, history, rate_limit::RateLimiter, runtime,
};
use axum::body::{Body, Bytes};
use axum::extract::{DefaultBodyLimit, State};
use axum::http::{header, HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use opentopia_core::model::{AgentEvent, Message, MessageRole};
use opentopia_core::provider::{MockProvider, ModelConversationMessage, ModelProvider};
use opentopia_core::tools::ToolRegistry;
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::convert::Infallible;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;
use uuid::Uuid;

#[derive(Clone)]
pub struct CloudState {
    pub provider: Arc<tokio::sync::OnceCell<Arc<dyn ModelProvider>>>,
    pub fixture: bool,
    pub tools: ToolRegistry,
    pub workspace: PathBuf,
    pub rate_limit: Arc<RateLimiter>,
    pub workspace_store: Option<cloud_workspace::CloudWorkspaceStore>,
}

pub fn router(state: CloudState) -> Router {
    let generation = cloud_generation::router(state.rate_limit.clone());
    let workspace_router = state.workspace_store.clone().map(cloud_workspace::router);
    let mut router = Router::new()
        .route(
            "/health",
            get(|State(state): State<CloudState>| async move {
                Json(json!({
                    "status": "ok",
                    "runtime": "opentopia-agent-core",
                    "mode": if state.fixture { "fixture" } else { "live" },
                    "model": if state.fixture { Some("mock-fixture".to_owned()) } else { runtime::configured_model_id().ok() },
                    "workspaceTools": if state.workspace_store.is_some() { 7 } else { 0 },
                }))
            }),
        )
        .route("/api/turn", post(turn))
        .layer(DefaultBodyLimit::max(64 * 1024))
        .with_state(state)
        .merge(generation);
    if let Some(workspace_router) = workspace_router {
        router = router.merge(workspace_router);
    }
    router
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct TurnRequest {
    thread_id: Uuid,
    project_id: Option<String>,
    storyboard_id: Option<String>,
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
) -> Result<Response, (StatusCode, Json<serde_json::Value>)> {
    accept(&state, &headers, &request)?;
    let token = if state.workspace_store.is_some() {
        Some(cloud_workspace::workspace_token(&headers)?)
    } else {
        None
    };
    let wants_stream = headers
        .get(header::ACCEPT)
        .and_then(|value| value.to_str().ok())
        .is_some_and(|value| value.contains("text/event-stream"));
    if wants_stream {
        return Ok(stream_response(state, request, token));
    }
    execute_turn(state, request, token)
        .await
        .map(|response| Json(response).into_response())
}

fn stream_response(state: CloudState, request: TurnRequest, token: Option<Uuid>) -> Response {
    let stream = async_stream::stream! {
        yield Ok::<Bytes, Infallible>(Bytes::from_static(b"event: started\ndata: {}\n\n"));
        let mut heartbeat = tokio::time::interval(Duration::from_secs(3));
        heartbeat.tick().await;
        let preparation = prepare_turn(state, request, token);
        tokio::pin!(preparation);
        let prepared = loop {
            tokio::select! {
                result = &mut preparation => {
                    match result {
                        Ok(prepared) => break prepared,
                        Err((_, Json(body))) => {
                            yield Ok(Bytes::from(format!("event: error\ndata: {}\n\n", body)));
                            return;
                        }
                    }
                }
                _ = heartbeat.tick() => {
                    yield Ok(Bytes::from_static(b": ping\n\n"));
                }
            }
        };

        let PreparedTurn {
            provider,
            tools,
            workspace,
            thread_id,
            turn_id,
            user,
            content,
            history,
            mut next_seq,
            started,
            workspace_context,
        } = prepared;
        let (sender, mut receiver) = tokio::sync::mpsc::unbounded_channel();
        let work = runtime::run_once(runtime::RuntimeTurnRequest {
            provider,
            tools,
            workspace,
            thread_id,
            turn_id,
            user_message_id: user.id,
            content,
            conversation: history,
            sender: Some(sender),
            workspace_context,
            cancellation: None,
        });
        tokio::pin!(work);
        let mut events = Vec::new();
        let result = loop {
            tokio::select! {
                biased;
                Some(payload) = receiver.recv() => {
                    if let Some(payload) = conversation_payload(payload) {
                        let event = AgentEvent::new(thread_id, Some(turn_id), next_seq, payload);
                        next_seq += 1;
                        yield Ok(Bytes::from(agent_event_frame(&event)));
                        events.push(event);
                    }
                }
                result = &mut work => break result,
                _ = heartbeat.tick() => {
                    yield Ok(Bytes::from_static(b": ping\n\n"));
                }
            }
        };
        while let Ok(payload) = receiver.try_recv() {
            if let Some(payload) = conversation_payload(payload) {
                let event = AgentEvent::new(thread_id, Some(turn_id), next_seq, payload);
                next_seq += 1;
                yield Ok(Bytes::from(agent_event_frame(&event)));
                events.push(event);
            }
        }

        match result {
            Ok(result) => {
                // AgentTurnDriver publishes the live sink before returning. If
                // a future OpenTopia event is recorded without being published,
                // append that tail so the final durable projection remains whole.
                let already_streamed = events.len();
                for payload in result
                    .events
                    .into_iter()
                    .filter_map(conversation_payload)
                    .skip(already_streamed)
                {
                    let event = AgentEvent::new(thread_id, Some(turn_id), next_seq, payload);
                    next_seq += 1;
                    yield Ok(Bytes::from(agent_event_frame(&event)));
                    events.push(event);
                }
                eprintln!("cloud turn completed after {}ms", started.elapsed().as_millis());
                let response = TurnResponse { message: user, turn_id, events };
                yield Ok(Bytes::from(format!(
                    "event: result\ndata: {}\n\n",
                    serde_json::to_string(&response).expect("turn response serializes")
                )));
            }
            Err(cause) => {
                eprintln!("cloud turn failed: {cause:#}");
                yield Ok(Bytes::from_static(
                    b"event: error\ndata: {\"error\":\"model request failed\"}\n\n",
                ));
            }
        }
    };
    Response::builder()
        .header(header::CONTENT_TYPE, "text/event-stream; charset=utf-8")
        .header(header::CACHE_CONTROL, "no-cache, no-transform")
        .header("x-accel-buffering", "no")
        .body(Body::from_stream(stream))
        .expect("stream response headers are valid")
}

fn agent_event_frame(event: &AgentEvent) -> String {
    format!(
        "event: {}\ndata: {}\n\n",
        event.kind(),
        serde_json::to_string(event).expect("agent event serializes")
    )
}

fn accept(
    state: &CloudState,
    headers: &HeaderMap,
    request: &TurnRequest,
) -> Result<(), (StatusCode, Json<serde_json::Value>)> {
    let client = headers
        .get("x-vercel-forwarded-for")
        .or_else(|| headers.get("x-forwarded-for"))
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.split(',').next())
        .unwrap_or("unknown")
        .trim();
    if !state.rate_limit.check(client) {
        return Err(error(
            StatusCode::TOO_MANY_REQUESTS,
            "too many requests; please retry in one minute",
        ));
    }
    validate(request).map_err(|reason| error(StatusCode::BAD_REQUEST, reason))
}

async fn execute_turn(
    state: CloudState,
    request: TurnRequest,
    token: Option<Uuid>,
) -> Result<TurnResponse, (StatusCode, Json<serde_json::Value>)> {
    let prepared = prepare_turn(state, request, token).await?;
    let PreparedTurn {
        provider,
        tools,
        workspace,
        thread_id,
        turn_id,
        user,
        content,
        history,
        next_seq,
        started,
        workspace_context,
    } = prepared;
    let result = runtime::run_once(runtime::RuntimeTurnRequest {
        provider,
        tools,
        workspace,
        thread_id,
        turn_id,
        user_message_id: user.id,
        content,
        conversation: history,
        sender: None,
        workspace_context,
        cancellation: None,
    })
    .await
    .map_err(|cause| {
        eprintln!("cloud turn failed: {cause:#}");
        error(StatusCode::BAD_GATEWAY, "model request failed")
    })?;
    eprintln!(
        "cloud turn completed after {}ms",
        started.elapsed().as_millis()
    );
    let events = result
        .events
        .into_iter()
        .filter_map(conversation_payload)
        .enumerate()
        .map(|(offset, payload)| {
            AgentEvent::new(thread_id, Some(turn_id), next_seq + offset as i64, payload)
        })
        .collect();
    Ok(TurnResponse {
        message: user,
        turn_id,
        events,
    })
}

struct PreparedTurn {
    provider: Arc<dyn ModelProvider>,
    tools: ToolRegistry,
    workspace: PathBuf,
    thread_id: Uuid,
    turn_id: Uuid,
    user: Message,
    content: String,
    history: Vec<ModelConversationMessage>,
    next_seq: i64,
    started: std::time::Instant,
    workspace_context: Option<String>,
}

async fn prepare_turn(
    state: CloudState,
    request: TurnRequest,
    token: Option<Uuid>,
) -> Result<PreparedTurn, (StatusCode, Json<serde_json::Value>)> {
    let started = std::time::Instant::now();
    eprintln!("cloud turn accepted");
    let provider = state
        .provider
        .get_or_try_init(|| async {
            if state.fixture {
                Ok(Arc::new(MockProvider) as Arc<dyn ModelProvider>)
            } else {
                runtime::configured_cloud_provider().await
            }
        })
        .await
        .map_err(|cause| {
            eprintln!("cloud provider initialization failed: {cause:#}");
            error(StatusCode::BAD_GATEWAY, "model provider is unavailable")
        })?
        .clone();
    eprintln!(
        "cloud provider ready after {}ms",
        started.elapsed().as_millis()
    );
    let (tools, workspace_context) = if let Some(store) = state.workspace_store.as_ref() {
        let token =
            token.ok_or_else(|| error(StatusCode::UNAUTHORIZED, "missing workspace key"))?;
        let project_id = request
            .project_id
            .as_deref()
            .ok_or_else(|| error(StatusCode::BAD_REQUEST, "projectId is required"))?;
        let storyboard_id = request
            .storyboard_id
            .as_deref()
            .ok_or_else(|| error(StatusCode::BAD_REQUEST, "storyboardId is required"))?;
        let doc = store
            .get(token)
            .await
            .map_err(|cause| {
                eprintln!("cloud workspace read failed: {cause:#}");
                error(StatusCode::BAD_GATEWAY, "cloud workspace is unavailable")
            })?
            .ok_or_else(|| error(StatusCode::NOT_FOUND, "workspace not found"))?;
        let context =
            cloud_workspace::scope_context(&doc.document.snapshot, project_id, storyboard_id)
                .map_err(|_| error(StatusCode::NOT_FOUND, "storyboard not found"))?;
        (
            cloud_workspace::registry_for(
                store.clone(),
                token,
                project_id.to_owned(),
                storyboard_id.to_owned(),
            ),
            Some(context),
        )
    } else {
        (state.tools, None)
    };
    let user = request.message;
    let content = message_model_text(&user.parts);
    let turn_id = Uuid::new_v4();
    let history = history::project_history(&request.messages, &request.events);
    let next_seq = request.events.last().map_or(0, |event| event.seq) + 1;
    Ok(PreparedTurn {
        provider,
        tools,
        workspace: state.workspace,
        thread_id: request.thread_id,
        turn_id,
        user,
        content,
        history,
        next_seq,
        started,
        workspace_context,
    })
}

fn validate(request: &TurnRequest) -> Result<(), &'static str> {
    let content = message_model_text(&request.message.parts);
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
    }) || request
        .events
        .iter()
        .any(|event| event.thread_id != request.thread_id)
    {
        return Err("invalid conversation history");
    }
    Ok(())
}

fn error(status: StatusCode, reason: impl Into<String>) -> (StatusCode, Json<serde_json::Value>) {
    (status, Json(json!({ "error": reason.into() })))
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::http::Request;
    use tower::ServiceExt;

    #[tokio::test]
    async fn cloud_stream_publishes_runtime_events_before_the_final_result() {
        let state = CloudState {
            provider: Arc::new(tokio::sync::OnceCell::new()),
            fixture: true,
            tools: runtime::default_registry(),
            workspace: std::env::temp_dir(),
            rate_limit: Arc::new(RateLimiter::default()),
            workspace_store: None,
        };
        let thread_id = Uuid::new_v4();
        let message = Message::text(thread_id, MessageRole::User, "stream me");
        let request = Request::builder()
            .method("POST")
            .uri("/api/turn")
            .header(header::CONTENT_TYPE, "application/json")
            .header(header::ACCEPT, "text/event-stream")
            .body(Body::from(
                serde_json::to_vec(&json!({
                    "threadId": thread_id,
                    "message": message,
                    "messages": [],
                    "events": [],
                }))
                .unwrap(),
            ))
            .unwrap();

        let response = router(state).oneshot(request).await.unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(response.headers().get("x-accel-buffering").unwrap(), "no");
        let body = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap();
        let stream = String::from_utf8(body.to_vec()).unwrap();
        let started = stream.find("event: turn_started").unwrap();
        let provider = stream.find("event: provider_request_sent").unwrap();
        let delta = stream.find("event: model_delta").unwrap();
        let assistant = stream.find("event: assistant_message").unwrap();
        let finished = stream.find("event: turn_finished").unwrap();
        let result = stream.find("event: result").unwrap();
        assert!(
            started < provider
                && provider < delta
                && delta < assistant
                && assistant < finished
                && finished < result
        );
    }
}
