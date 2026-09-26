use anyhow::{anyhow, Result};
use opentopia_core::model::{
    AgentEvent, AgentEventPayload, ExperienceMode, Message, MessagePart, MessageRole, Thread,
};
use opentopia_core::provider::{ModelConversationMessage, ModelConversationRole, ModelProvider};
use opentopia_core::store::{SessionStore, SqliteSessionStore};
use opentopia_core::tools::ToolRegistry;
use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::Arc;
use tokio::sync::{broadcast, Mutex};
use uuid::Uuid;

use crate::runtime;

#[derive(Clone)]
pub struct ConversationService {
    pub store: Arc<SqliteSessionStore>,
    provider: Arc<dyn ModelProvider>,
    tools: ToolRegistry,
    workspace: PathBuf,
    streams: Arc<Mutex<HashMap<Uuid, broadcast::Sender<AgentEvent>>>>,
    active: Arc<Mutex<HashSet<Uuid>>>,
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
            active: Arc::new(Mutex::new(HashSet::new())),
        }
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
        {
            let mut active = self.active.lock().await;
            if !active.insert(thread_id) {
                return Err(anyhow!("a turn is already running in this thread"));
            }
        }
        let prior = match self.store.list_messages(thread_id) {
            Ok(messages) => messages,
            Err(error) => {
                self.active.lock().await.remove(&thread_id);
                return Err(error);
            }
        };
        let user = Message::text(thread_id, MessageRole::User, content.clone());
        if let Err(error) = self.store.append_message(user.clone()) {
            self.active.lock().await.remove(&thread_id);
            return Err(error);
        }
        let turn_id = Uuid::new_v4();
        let service = self.clone();
        tokio::spawn(async move {
            service
                .drive_turn(
                    thread_id,
                    turn_id,
                    user.id,
                    content,
                    project_history(&prior),
                )
                .await;
            service.active.lock().await.remove(&thread_id);
        });
        Ok((user, turn_id))
    }

    async fn drive_turn(
        &self,
        thread_id: Uuid,
        turn_id: Uuid,
        user_message_id: Uuid,
        content: String,
        conversation: Vec<ModelConversationMessage>,
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
        let result = runtime::run_once(
            self.provider.clone(),
            self.tools.clone(),
            self.workspace.clone(),
            thread_id,
            turn_id,
            user_message_id,
            content,
            conversation,
            Some(sender),
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
        if !visible_payload(&payload) {
            return Ok(());
        }
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

fn visible_payload(payload: &AgentEventPayload) -> bool {
    matches!(
        payload,
        AgentEventPayload::TurnStarted { .. }
            | AgentEventPayload::ModelDelta { .. }
            | AgentEventPayload::ToolCallStarted { .. }
            | AgentEventPayload::ToolCallFinished { .. }
            | AgentEventPayload::AssistantMessage { .. }
            | AgentEventPayload::TurnFinished { .. }
            | AgentEventPayload::Error { .. }
    )
}

fn project_history(messages: &[Message]) -> Vec<ModelConversationMessage> {
    messages
        .iter()
        .filter_map(|message| {
            let role = match message.role {
                MessageRole::User => ModelConversationRole::User,
                MessageRole::Assistant => ModelConversationRole::Assistant,
                MessageRole::System | MessageRole::Tool => return None,
            };
            let content = message
                .parts
                .iter()
                .filter_map(|part| match part {
                    MessagePart::Text { text } => Some(text.as_str()),
                    _ => None,
                })
                .collect::<Vec<_>>()
                .join("\n");
            (!content.is_empty()).then_some(ModelConversationMessage {
                role,
                content,
                content_parts: Vec::new(),
                tool_calls: Vec::new(),
                tool_results: Vec::new(),
            })
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use opentopia_core::provider::MockProvider;
    use std::time::Duration;

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
}
