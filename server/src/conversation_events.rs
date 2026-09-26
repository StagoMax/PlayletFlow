use opentopia_core::model::AgentEventPayload;

/// Projects the full runtime event stream into the durable, user-visible
/// conversation protocol. Provider request/response bodies are intentionally
/// stripped: the UI needs lifecycle metadata, not duplicated model context.
pub fn conversation_payload(mut payload: AgentEventPayload) -> Option<AgentEventPayload> {
    let visible = matches!(
        &payload,
        AgentEventPayload::TurnStarted { .. }
            | AgentEventPayload::ModelRequest { .. }
            | AgentEventPayload::ProviderRequestSent { .. }
            | AgentEventPayload::ProviderRequestRetried { .. }
            | AgentEventPayload::ProviderResponseHeadersReceived { .. }
            | AgentEventPayload::ProviderFirstTokenReceived { .. }
            | AgentEventPayload::ProviderStreamProgress { .. }
            | AgentEventPayload::ProviderResponseCommitStarted { .. }
            | AgentEventPayload::ProviderResponseReceived { .. }
            | AgentEventPayload::ModelDelta { .. }
            | AgentEventPayload::ReasoningDelta { .. }
            | AgentEventPayload::ToolCallStarted { .. }
            | AgentEventPayload::ToolCallFinished { .. }
            | AgentEventPayload::AssistantMessage { .. }
            | AgentEventPayload::TokenUsage { .. }
            | AgentEventPayload::TurnFinished { .. }
            | AgentEventPayload::TurnCancelled { .. }
            | AgentEventPayload::Error { .. }
    );
    if !visible {
        return None;
    }
    match &mut payload {
        AgentEventPayload::ModelRequest { request, .. }
        | AgentEventPayload::ProviderRequestSent { body: request, .. }
        | AgentEventPayload::ProviderRequestRetried { body: request, .. }
        | AgentEventPayload::ProviderResponseReceived { body: request, .. } => {
            *request = serde_json::Value::Null;
        }
        _ => {}
    }
    Some(payload)
}
