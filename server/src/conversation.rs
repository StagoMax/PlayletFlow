use anyhow::{anyhow, Result};
use async_trait::async_trait;
use opentopia_core::model::{
    AgentEvent, AgentEventPayload, ExperienceMode, Message, MessageRole, Thread,
};
use opentopia_core::provider::{ModelConversationMessage, ModelProvider};
use opentopia_core::store::{SessionStore, SqliteSessionStore};
use opentopia_core::tools::ToolRegistry;
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use tokio::sync::{broadcast, Mutex};
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

use crate::{conversation_events::conversation_payload, history, runtime};

#[async_trait]
pub trait ConversationContextProvider: Send + Sync {
    async fn context_for_thread(&self, thread_id: Uuid) -> Result<Option<String>>;
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

    pub async fn send_message(&self, thread_id: Uuid, content: String) -> Result<(Message, Uuid)> {
        self.ensure_thread(thread_id)?;
        let content = content.trim().to_owned();
        if content.is_empty() || content.len() > 16_000 {
            return Err(anyhow!("message must contain 1 to 16000 characters"));
        }
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
                Ok(context) => context,
                Err(error) => {
                    self.active.lock().await.remove(&thread_id);
                    return Err(error);
                }
            }
        } else {
            None
        };
        let user = Message::text(thread_id, MessageRole::User, content.clone());
        if let Err(error) = self.store.append_message(user.clone()) {
            self.active.lock().await.remove(&thread_id);
            return Err(error);
        }
        let service = self.clone();
        tokio::spawn(async move {
            service
                .drive_turn(
                    thread_id,
                    turn_id,
                    user.id,
                    content,
                    history::project_history(&prior, &prior_events),
                    trusted_context,
                    cancellation,
                )
                .await;
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

    async fn drive_turn(
        &self,
        thread_id: Uuid,
        turn_id: Uuid,
        user_message_id: Uuid,
        content: String,
        conversation: Vec<ModelConversationMessage>,
        trusted_context: Option<String>,
        cancellation: CancellationToken,
    ) {
        let (sender, mut receiver) = tokio::sync::mpsc::unbounded_channel();
        let sink = self.clone();
        let persistence = tokio::spawn(async move {
            while let Some(payload) = receiver.recv().await {
                if let Err(error) = sink.persist_payload(thread_id, turn_id, payload).await {
                    eprintln!("failed to persist turn event: {error:#}");
                }
            }
        });
        let result = runtime::run_once_with_context_and_cancellation(
            self.provider.clone(),
            self.tools.clone(),
            self.workspace.clone(),
            thread_id,
            turn_id,
            user_message_id,
            content,
            conversation,
            Some(sender),
            trusted_context,
            Some(cancellation),
        )
        .await;
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
            .send_message(thread.id, "hello".into())
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
            .send_message(thread.id, "please wait".into())
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
