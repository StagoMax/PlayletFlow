use opentopia_core::model::{
    AgentEvent, AgentEventPayload, Message, MessagePart, MessageRole, ToolResult,
};
use opentopia_core::provider::{
    ModelConversationMessage, ModelConversationRole, ProviderToolCall, ProviderToolResult,
};
use opentopia_core::tool_result_is_error;
use std::collections::HashMap;
use uuid::Uuid;

/// Rebuild the provider transcript from durable messages and canonical tool
/// events. The browser can keep its compact projection independently.
pub fn project_history(
    messages: &[Message],
    events: &[AgentEvent],
) -> Vec<ModelConversationMessage> {
    let mut turn_by_user = HashMap::<Uuid, Uuid>::new();
    let mut tool_events_by_turn = HashMap::<Uuid, Vec<&AgentEvent>>::new();
    for event in events {
        let Some(turn_id) = event.turn_id else {
            continue;
        };
        match &event.payload {
            AgentEventPayload::TurnStarted { user_message_id } => {
                turn_by_user.insert(*user_message_id, turn_id);
            }
            AgentEventPayload::ToolCallStarted { .. }
            | AgentEventPayload::ToolCallFinished { .. } => {
                tool_events_by_turn.entry(turn_id).or_default().push(event);
            }
            _ => {}
        }
    }
    let mut projected = Vec::new();
    for message in messages {
        let role = match message.role {
            MessageRole::User => ModelConversationRole::User,
            MessageRole::Assistant => ModelConversationRole::Assistant,
            MessageRole::System | MessageRole::Tool => continue,
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
        if !content.is_empty() {
            projected.push(ModelConversationMessage {
                role,
                content,
                content_parts: Vec::new(),
                tool_calls: Vec::new(),
                tool_results: Vec::new(),
            });
        }
        if role == ModelConversationRole::User {
            if let Some(turn_id) = turn_by_user.get(&message.id) {
                if let Some(events) = tool_events_by_turn.get(turn_id) {
                    projected.extend(project_tool_exchanges(events));
                }
            }
        }
    }
    projected
}

fn project_tool_exchanges(events: &[&AgentEvent]) -> Vec<ModelConversationMessage> {
    let results = events
        .iter()
        .filter_map(|event| match &event.payload {
            AgentEventPayload::ToolCallFinished { result } => Some((result.call_id, result)),
            _ => None,
        })
        .collect::<HashMap<_, _>>();
    let mut projected = Vec::new();
    for event in events {
        let AgentEventPayload::ToolCallStarted { call } = &event.payload else {
            continue;
        };
        let Some(result) = results.get(&call.id) else {
            continue;
        };
        let provider_id = result
            .metadata
            .get("providerToolCallId")
            .and_then(serde_json::Value::as_str)
            .filter(|id| !id.is_empty())
            .map(str::to_owned)
            .unwrap_or_else(|| call.id.to_string());
        projected.push(ModelConversationMessage {
            role: ModelConversationRole::Assistant,
            content: String::new(),
            content_parts: Vec::new(),
            tool_calls: vec![ProviderToolCall {
                id: provider_id.clone(),
                name: call.name.clone(),
                arguments: call.input.clone(),
            }],
            tool_results: Vec::new(),
        });
        projected.push(ModelConversationMessage {
            role: ModelConversationRole::Tool,
            content: String::new(),
            content_parts: Vec::new(),
            tool_calls: Vec::new(),
            tool_results: vec![provider_result(provider_id, &call.name, result)],
        });
    }
    projected
}

fn provider_result(provider_id: String, name: &str, result: &ToolResult) -> ProviderToolResult {
    ProviderToolResult {
        call_id: provider_id,
        name: name.to_owned(),
        output: result.output.clone(),
        content: result.content_or_legacy_text(),
        is_error: tool_result_is_error(result),
        metadata: result.metadata.clone(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use opentopia_core::model::{ToolCall, ToolResult};
    use serde_json::json;

    #[test]
    fn replays_the_provider_tool_call_id_and_full_result() {
        let thread = Uuid::new_v4();
        let turn = Uuid::new_v4();
        let user = Message::text(thread, MessageRole::User, "run probe");
        let assistant = Message::text(thread, MessageRole::Assistant, "probe complete");
        let call = ToolCall::new("runtime_probe", json!({"text": "probe-ok"}));
        let result = ToolResult::text(
            call.id,
            "probe-ok",
            json!({"providerToolCallId": "call_123"}),
        );
        let events = vec![
            AgentEvent::new(
                thread,
                Some(turn),
                1,
                AgentEventPayload::TurnStarted {
                    user_message_id: user.id,
                },
            ),
            AgentEvent::new(
                thread,
                Some(turn),
                2,
                AgentEventPayload::ToolCallStarted { call },
            ),
            AgentEvent::new(
                thread,
                Some(turn),
                3,
                AgentEventPayload::ToolCallFinished { result },
            ),
        ];
        let history = project_history(&[user, assistant], &events);
        assert_eq!(history.len(), 4);
        assert_eq!(history[1].tool_calls[0].id, "call_123");
        assert_eq!(history[2].tool_results[0].call_id, "call_123");
        assert_eq!(history[2].tool_results[0].output, "probe-ok");
        assert_eq!(history[3].content, "probe complete");
    }
}
