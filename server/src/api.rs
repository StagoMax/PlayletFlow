use crate::{conversation::ConversationService, runtime};
use axum::extract::{Path, Query, State};
use axum::http::{HeaderMap, HeaderName, Method, StatusCode};
use axum::response::sse::{Event, KeepAlive, Sse};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::{Json, Router};
use chrono::{DateTime, Utc};
use opentopia_core::model::{
    AgentEvent, AgentEventPayload, ExperienceMode, Message, Thread, ToolResult,
};
use opentopia_core::store::SessionStore;
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::convert::Infallible;
use tower_http::cors::CorsLayer;
use uuid::Uuid;

pub fn router(service: ConversationService) -> Router {
    Router::new()
        .route("/health", get(health))
        .route("/api/threads", get(list_threads).post(create_thread))
        .route(
            "/api/threads/:thread_id/messages",
            get(list_messages).post(send_message),
        )
        .route("/api/threads/:thread_id/events", get(list_events))
        .route("/api/threads/:thread_id/events/stream", get(stream_events))
        .route(
            "/api/threads/:thread_id/turn/cancel",
            axum::routing::post(cancel_turn),
        )
        .route(
            "/api/threads/:thread_id/events/:event_id/tool-result",
            get(tool_result_detail),
        )
        .layer(
            CorsLayer::new()
                .allow_origin([
                    "http://localhost:5173".parse().unwrap(),
                    "http://127.0.0.1:5173".parse().unwrap(),
                ])
                .allow_methods([Method::GET, Method::POST])
                .allow_headers([axum::http::header::CONTENT_TYPE]),
        )
        .with_state(service)
}

#[derive(Debug)]
pub struct ApiError(StatusCode, String);

impl ApiError {
    fn not_found() -> Self {
        Self(StatusCode::NOT_FOUND, "thread not found".to_owned())
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        (self.0, Json(json!({ "error": self.1 }))).into_response()
    }
}

type ApiResult<T> = Result<T, ApiError>;

fn internal(error: impl std::fmt::Display) -> ApiError {
    ApiError(StatusCode::INTERNAL_SERVER_ERROR, error.to_string())
}

fn require_thread(service: &ConversationService, id: Uuid) -> ApiResult<()> {
    service
        .ensure_thread(id)
        .map(|_| ())
        .map_err(|_| ApiError::not_found())
}

async fn health() -> Json<serde_json::Value> {
    Json(json!({
        "status": "ok",
        "runtime": "opentopia-agent-core",
        "model": runtime::configured_model_id().ok(),
    }))
}

async fn list_threads(State(service): State<ConversationService>) -> ApiResult<Json<Vec<Thread>>> {
    service
        .store
        .list_threads_for_mode(false, ExperienceMode::Work)
        .map(Json)
        .map_err(internal)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CreateThreadRequest {
    title: Option<String>,
}

async fn create_thread(
    State(service): State<ConversationService>,
    Json(request): Json<CreateThreadRequest>,
) -> ApiResult<(StatusCode, Json<Thread>)> {
    let thread = service.create_thread(request.title).map_err(internal)?;
    Ok((StatusCode::CREATED, Json(thread)))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct MessageQuery {
    before_created_at: Option<DateTime<Utc>>,
    before_id: Option<Uuid>,
    after_created_at: Option<DateTime<Utc>>,
    after_id: Option<Uuid>,
    limit: Option<usize>,
}

async fn list_messages(
    State(service): State<ConversationService>,
    Path(thread_id): Path<Uuid>,
    Query(query): Query<MessageQuery>,
) -> ApiResult<Json<Vec<Message>>> {
    require_thread(&service, thread_id)?;
    let before = cursor(query.before_created_at, query.before_id)?;
    let after = cursor(query.after_created_at, query.after_id)?;
    if before.is_some() && after.is_some() {
        return Err(ApiError(
            StatusCode::BAD_REQUEST,
            "choose one message cursor".into(),
        ));
    }
    service
        .store
        .list_conversation_message_page(thread_id, after, before, query.limit.unwrap_or(61))
        .map(Json)
        .map_err(internal)
}

fn cursor(at: Option<DateTime<Utc>>, id: Option<Uuid>) -> ApiResult<Option<(DateTime<Utc>, Uuid)>> {
    match (at, id) {
        (Some(at), Some(id)) => Ok(Some((at, id))),
        (None, None) => Ok(None),
        _ => Err(ApiError(
            StatusCode::BAD_REQUEST,
            "incomplete message cursor".into(),
        )),
    }
}

#[derive(Deserialize)]
struct SendMessageRequest {
    content: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SendMessageResponse {
    message: Message,
    turn_id: Uuid,
}

async fn send_message(
    State(service): State<ConversationService>,
    Path(thread_id): Path<Uuid>,
    Json(request): Json<SendMessageRequest>,
) -> ApiResult<(StatusCode, Json<SendMessageResponse>)> {
    require_thread(&service, thread_id)?;
    let (message, turn_id) = service
        .send_message(thread_id, request.content)
        .await
        .map_err(|error| {
            let text = error.to_string();
            let status = if text.contains("already running") {
                StatusCode::CONFLICT
            } else {
                StatusCode::BAD_REQUEST
            };
            ApiError(status, text)
        })?;
    Ok((
        StatusCode::ACCEPTED,
        Json(SendMessageResponse { message, turn_id }),
    ))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CancelTurnRequest {
    turn_id: Option<Uuid>,
}

async fn cancel_turn(
    State(service): State<ConversationService>,
    Path(thread_id): Path<Uuid>,
    Json(request): Json<CancelTurnRequest>,
) -> ApiResult<Json<serde_json::Value>> {
    require_thread(&service, thread_id)?;
    let cancelled = service
        .cancel_turn(thread_id, request.turn_id)
        .await
        .map_err(internal)?;
    Ok(Json(json!({ "cancelled": cancelled })))
}

#[derive(Deserialize)]
struct EventQuery {
    since: Option<i64>,
    before: Option<i64>,
    limit: Option<usize>,
}

async fn list_events(
    State(service): State<ConversationService>,
    Path(thread_id): Path<Uuid>,
    Query(query): Query<EventQuery>,
) -> ApiResult<Json<Vec<AgentEvent>>> {
    require_thread(&service, thread_id)?;
    service
        .store
        .list_conversation_event_page(
            thread_id,
            query.since,
            query.before,
            query.limit.unwrap_or(250),
        )
        .map(Json)
        .map_err(internal)
}

async fn tool_result_detail(
    State(service): State<ConversationService>,
    Path((thread_id, event_id)): Path<(Uuid, Uuid)>,
) -> ApiResult<Json<ToolResult>> {
    require_thread(&service, thread_id)?;
    let event = service
        .store
        .get_event(thread_id, event_id)
        .map_err(internal)?
        .ok_or_else(ApiError::not_found)?;
    match event.payload {
        AgentEventPayload::ToolCallFinished { result } => Ok(Json(result)),
        _ => Err(ApiError(
            StatusCode::NOT_FOUND,
            "tool result not found".into(),
        )),
    }
}

async fn stream_events(
    State(service): State<ConversationService>,
    Path(thread_id): Path<Uuid>,
    Query(query): Query<EventQuery>,
    headers: HeaderMap,
) -> ApiResult<Sse<impl futures_util::Stream<Item = Result<Event, Infallible>>>> {
    require_thread(&service, thread_id)?;
    let mut receiver = service.subscribe(thread_id).await;
    let header_since = headers
        .get(HeaderName::from_static("last-event-id"))
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.parse::<i64>().ok());
    let mut cursor = query
        .since
        .unwrap_or_default()
        .max(header_since.unwrap_or_default());
    let events = service
        .store
        .list_conversation_events(thread_id, Some(cursor))
        .map_err(internal)?;
    let stream = async_stream::stream! {
        for event in events {
            cursor = cursor.max(event.seq);
            yield Ok::<Event, Infallible>(sse_event(&event));
        }
        loop {
            match receiver.recv().await {
                Ok(event) if event.seq > cursor => {
                    cursor = event.seq;
                    yield Ok(sse_event(&event));
                }
                Ok(_) => {}
                Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => {
                    if let Ok(missed) = service.store.list_conversation_events(thread_id, Some(cursor)) {
                        for event in missed {
                            cursor = cursor.max(event.seq);
                            yield Ok(sse_event(&event));
                        }
                    }
                }
                Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
            }
        }
    };
    Ok(Sse::new(stream).keep_alive(KeepAlive::default()))
}

fn sse_event(event: &AgentEvent) -> Event {
    Event::default()
        .id(event.seq.to_string())
        .event(event.kind())
        .json_data(event)
        .expect("conversation events are serializable")
}
