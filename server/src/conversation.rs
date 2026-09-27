use anyhow::{anyhow, Result};
use async_trait::async_trait;
use opentopia_core::model::{
    AgentEvent, AgentEventPayload, ExperienceMode, Message, MessagePart, MessageRole, Thread,
};
use opentopia_core::provider::ModelProvider;
use opentopia_core::store::{SessionStore, SqliteSessionStore};
use opentopia_core::tools::ToolRegistry;
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use tokio::sync::{broadcast, Mutex};
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

use crate::{
    conversation_events::conversation_payload,
    conversation_references::{message_model_text, reference_part, WorkspaceReference},
    history, runtime,
};

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ConversationInputPart {
    Text(String),
    AssetReference(String),
}

#[async_trait]
pub trait ConversationContextProvider: Send + Sync {
    async fn context_for_thread(&self, thread_id: Uuid) -> Result<Option<String>>;

    async fn resolve_references(
        &self,
        thread_id: Uuid,
        reference_ids: &[String],
    ) -> Result<Vec<WorkspaceReference>>;
}

#[derive(Clone)]
pub struct ConversationService {
    pub store: Arc<SqliteSessionStore>,
    provider: Arc<dyn ModelProvider>,
    tools: ToolRegistry,
    workspace: PathBuf,
    streams: Arc<Mutex<HashMap<Uuid, broadcast::Sender<AgentEvent>>>>,
    active: Arc<Mutex<HashMap<Uuid, ActiveTurn>>>,
    context_provider: Option<Arc<dyn ConversationContextProvider>>,
}

#[derive(Clone)]
struct ActiveTurn {
    id: Uuid,
    cancellation: CancellationToken,
}

impl ConversationService {
    pub fn new(
        store: Arc<SqliteSessionStore>,
        provider: Arc<dyn ModelProvider>,
        tools: ToolRegistry,
        workspace: PathBuf,
    ) -> Self {
        Self {
            store,
            provider,
            tools,
            workspace,
            streams: Arc::new(Mutex::new(HashMap::new())),
            active: Arc::new(Mutex::new(HashMap::new())),
            context_provider: None,
        }
    }

    pub fn with_context_provider(
        mut self,
        context_provider: Arc<dyn ConversationContextProvider>,
    ) -> Self {
        self.context_provider = Some(context_provider);
        self
    }

    pub fn create_thread(&self, title: Option<String>) -> Result<Thread> {
        self.store
            .create_thread_with_mode(title, self.workspace.clone(), ExperienceMode::Work)
    }

    pub fn ensure_thread(&self, thread_id: Uuid) -> Result<Thread> {
        self.store
            .get_thread(thread_id)?
            .ok_or_else(|| anyhow!("thread not found"))
    }

    pub async fn delete_thread(&self, thread_id: Uuid) -> Result<()> {
        if let Some(turn) = self.active.lock().await.remove(&thread_id) {
            turn.cancellation.cancel();
        }
        self.streams.lock().await.remove(&thread_id);
        // Deleting an already absent runtime thread lets a product binding
        // deletion be retried after a partial cross-database failure.
        self.store.delete_thread(thread_id)?;
        Ok(())
    }

    pub async fn subscribe(&self, thread_id: Uuid) -> broadcast::Receiver<AgentEvent> {
        let mut streams = self.streams.lock().await;
        streams
            .entry(thread_id)
            .or_insert_with(|| broadcast::channel(512).0)
            .subscribe()
    }

    async fn publish(&self, event: AgentEvent) {
        let streams = self.streams.lock().await;
        if let Some(stream) = streams.get(&event.thread_id) {
            let _ = stream.send(event);
        }
    }

    pub async fn send_message(
        &self,
        thread_id: Uuid,
        input_parts: Vec<ConversationInputPart>,
    ) -> Result<(Message, Uuid)> {
        self.ensure_thread(thread_id)?;
        let human_text = input_parts
            .iter()
            .filter_map(|part| match part {
                ConversationInputPart::Text(text) => Some(text.as_str()),
                ConversationInputPart::AssetReference(_) => None,
            })
            .collect::<String>()
            .trim()
            .to_owned();
        if human_text.is_empty() || human_text.len() > 16_000 {
            return Err(anyhow!("message must contain 1 to 16000 characters"));
        }
        if input_parts.len() > 100 {
            return Err(anyhow!("message contains too many parts"));
        }
        let mut reference_ids = Vec::new();
        for part in &input_parts {
            let ConversationInputPart::AssetReference(id) = part else {
                continue;
            };
            if !reference_ids.contains(id) {
                reference_ids.push(id.clone());
            }
        }
        let resolved_references = if reference_ids.is_empty() {
            Vec::new()
        } else {
            let provider = self
                .context_provider
                .as_ref()
                .ok_or_else(|| anyhow!("workspace references are unavailable for this thread"))?;
            provider
                .resolve_references(thread_id, &reference_ids)
                .await?
        };
        if resolved_references.len() != reference_ids.len() {
            return Err(anyhow!("one or more workspace references are unavailable"));
        }
        let references_by_id = resolved_references
            .iter()
            .map(|reference| (reference.id.as_str(), reference))
            .collect::<HashMap<_, _>>();
        let message_parts = input_parts
            .into_iter()
            .map(|part| match part {
                ConversationInputPart::Text(text) => Ok(MessagePart::Text { text }),
                ConversationInputPart::AssetReference(id) => references_by_id
                    .get(id.as_str())
                    .ok_or_else(|| anyhow!("workspace reference was not resolved: {id}"))
                    .and_then(|reference| reference_part(reference)),
            })
            .collect::<Result<Vec<_>>>()?;
        let content = message_model_text(&message_parts);
        let turn_id = Uuid::new_v4();
        let cancellation = CancellationToken::new();
        {
            let mut active = self.active.lock().await;
            if active.contains_key(&thread_id) {
                return Err(anyhow!("a turn is already running in this thread"));
            }
            active.insert(
                thread_id,
                ActiveTurn {
                    id: turn_id,
                    cancellation: cancellation.clone(),
                },
            );
        }
        let prior = match self.store.list_messages(thread_id) {
            Ok(messages) => messages,
            Err(error) => {
                self.active.lock().await.remove(&thread_id);
                return Err(error);
            }
        };
        let prior_events = match self.store.list_events(thread_id, None) {
            Ok(events) => events,
            Err(error) => {
                self.active.lock().await.remove(&thread_id);
                return Err(error);
            }
        };
        let trusted_context = if let Some(provider) = &self.context_provider {
            match provider.context_for_thread(thread_id).await {
                Ok(context) => augment_context_with_references(context, &resolved_references),
                Err(error) => {
                    self.active.lock().await.remove(&thread_id);
                    return Err(error);
                }
            }
        } else {
            None
        };
        let user = Message {
            id: Uuid::new_v4(),
            thread_id,
            role: MessageRole::User,
            parts: message_parts,
            created_at: chrono::Utc::now(),
        };
        if let Err(error) = self.store.append_message(user.clone()) {
            self.active.lock().await.remove(&thread_id);
            return Err(error);
        }
        let service = self.clone();
        tokio::spawn(async move {
            let request = runtime::RuntimeTurnRequest {
                provider: service.provider.clone(),
                tools: service.tools.clone(),
                workspace: service.workspace.clone(),
                thread_id,
                turn_id,
                user_message_id: user.id,
                content,
                conversation: history::project_history(&prior, &prior_events),
                sender: None,
                workspace_context: trusted_context,
                cancellation: Some(cancellation),
            };
            service.drive_turn(request).await;
            service.active.lock().await.remove(&thread_id);
        });
        Ok((user, turn_id))
    }

    pub async fn cancel_turn(&self, thread_id: Uuid, turn_id: Option<Uuid>) -> Result<bool> {
        self.ensure_thread(thread_id)?;
        let active = self.active.lock().await;
        let Some(turn) = active.get(&thread_id) else {
            return Ok(false);
        };
        if turn_id.is_some_and(|requested| requested != turn.id) {
            return Ok(false);
        }
        turn.cancellation.cancel();
        Ok(true)
    }

    async fn drive_turn(&self, mut request: runtime::RuntimeTurnRequest) {
        let thread_id = request.thread_id;
        let turn_id = request.turn_id;
        let (sender, mut receiver) = tokio::sync::mpsc::unbounded_channel();
        let sink = self.clone();
        let persistence = tokio::spawn(async move {
            while let Some(payload) = receiver.recv().await {
                if let Err(error) = sink.persist_payload(thread_id, turn_id, payload).await {
                    eprintln!("failed to persist turn event: {error:#}");
                }
            }
        });
        request.sender = Some(sender);
        let result = runtime::run_once(request).await;
        let _ = persistence.await;
        if let Err(error) = result {
            let _ = self
                .persist_payload(
                    thread_id,
                    turn_id,
                    AgentEventPayload::Error {
                        message: error.to_string(),
                    },
                )
                .await;
        }
    }

    async fn persist_payload(
        &self,
        thread_id: Uuid,
        turn_id: Uuid,
        payload: AgentEventPayload,
    ) -> Result<()> {
        let Some(payload) = conversation_payload(payload) else {
            return Ok(());
        };
        let message = match &payload {
            AgentEventPayload::AssistantMessage { message } => Some(message.clone()),
            _ => None,
        };
        let event = AgentEvent::new(thread_id, Some(turn_id), 0, payload);
        let mut committed = self
            .store
            .append_conversation_batch(message.into_iter().collect(), vec![event])?;
        if let Some(mut event) = committed.pop() {
            if let AgentEventPayload::ToolCallFinished { result } = &mut event.payload {
                *result = result.conversation_summary(event.id);
            }
            self.publish(event).await;
        }
        Ok(())
    }
}

fn augment_context_with_references(
    context: Option<String>,
    references: &[WorkspaceReference],
) -> Option<String> {
    if references.is_empty() {
        return context;
    }
    let workspace = context
        .and_then(|value| serde_json::from_str::<serde_json::Value>(&value).ok())
        .unwrap_or(serde_json::Value::Null);
    Some(
        serde_json::json!({
            "workspace": workspace,
            "selectedReferences": references,
        })
        .to_string(),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use opentopia_core::provider::{MockProvider, ModelRequest, ModelResponse};
    use opentopia_core::settings::ProviderHealthCheck;
    use std::time::Duration;

    struct SlowProvider;

    #[async_trait]
    impl ModelProvider for SlowProvider {
        async fn complete(&self, request: ModelRequest) -> Result<ModelResponse> {
            tokio::time::sleep(Duration::from_secs(30)).await;
            MockProvider.complete(request).await
        }

        async fn check_health(&self) -> Result<ProviderHealthCheck> {
            MockProvider.check_health().await
        }
    }

    #[tokio::test]
    async fn completed_turn_is_saved_and_can_be_reloaded() {
        let store = Arc::new(SqliteSessionStore::open(":memory:").unwrap());
        let service = ConversationService::new(
            store.clone(),
            Arc::new(MockProvider),
            runtime::default_registry(),
            std::env::temp_dir(),
        );
        let thread = service.create_thread(Some("reload test".into())).unwrap();
        let mut events = service.subscribe(thread.id).await;
        let (user, turn_id) = service
            .send_message(thread.id, vec![ConversationInputPart::Text("hello".into())])
            .await
            .unwrap();
        let mut saw_finish = false;
        for _ in 0..40 {
            let event = tokio::time::timeout(Duration::from_secs(5), events.recv())
                .await
                .expect("the turn should emit an event")
                .unwrap();
            if event.turn_id == Some(turn_id)
                && matches!(event.payload, AgentEventPayload::TurnFinished { .. })
            {
                saw_finish = true;
                break;
            }
        }
        assert!(saw_finish);
        let messages = store
            .list_conversation_message_page(thread.id, None, None, 60)
            .unwrap();
        assert!(messages.iter().any(|message| message.id == user.id));
        assert!(messages
            .iter()
            .any(|message| message.role == MessageRole::Assistant));
        let saved_events = store
            .list_conversation_event_page(thread.id, None, None, 250)
            .unwrap();
        assert!(saved_events
            .iter()
            .any(|event| event.turn_id == Some(turn_id)));
    }

    #[tokio::test]
    async fn active_turn_can_be_cancelled_and_finishes_without_an_error() {
        let store = Arc::new(SqliteSessionStore::open(":memory:").unwrap());
        let service = ConversationService::new(
            store.clone(),
            Arc::new(SlowProvider),
            runtime::default_registry(),
            std::env::temp_dir(),
        );
        let thread = service.create_thread(Some("cancel test".into())).unwrap();
        let mut events = service.subscribe(thread.id).await;
        let (_, turn_id) = service
            .send_message(
                thread.id,
                vec![ConversationInputPart::Text("please wait".into())],
            )
            .await
            .unwrap();

        loop {
            let event = tokio::time::timeout(Duration::from_secs(5), events.recv())
                .await
                .expect("the turn should start")
                .unwrap();
            if event.turn_id == Some(turn_id)
                && matches!(event.payload, AgentEventPayload::ProviderRequestSent { .. })
            {
                break;
            }
        }
        assert!(service.cancel_turn(thread.id, Some(turn_id)).await.unwrap());

        let mut cancelled = false;
        let mut failed = false;
        loop {
            let event = tokio::time::timeout(Duration::from_secs(5), events.recv())
                .await
                .expect("the cancelled turn should terminate")
                .unwrap();
            if event.turn_id != Some(turn_id) {
                continue;
            }
            cancelled |= matches!(event.payload, AgentEventPayload::TurnCancelled { .. });
            failed |= matches!(event.payload, AgentEventPayload::Error { .. });
            if matches!(event.payload, AgentEventPayload::TurnFinished { .. }) {
                break;
            }
        }
        assert!(cancelled);
        assert!(!failed);
    }
}
