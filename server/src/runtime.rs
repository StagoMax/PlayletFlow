use anyhow::{anyhow, Context, Result};
use async_trait::async_trait;
use opentopia_core::model::{AgentEventPayload, ExperienceMode, ToolCall, ToolResult};
use opentopia_core::model_context::{
    CompiledModelContext, ContextCacheScope, ContextItemKind, ContextRole, ContextSensitivity,
    ModelContextItem,
};
use opentopia_core::policy::PermissionMode;
use opentopia_core::provider::{
    configured_provider_from_settings, negotiate_provider_settings, ModelProvider,
};
use opentopia_core::settings::{AppSettings, ProviderSettings};
use opentopia_core::tools::{Tool, ToolInvocationContext, ToolRegistry};
use opentopia_core::{
    AgentCore, AgentRunConfig, AgentRunIdentity, AgentTurnDriver, AgentTurnInput,
    CapabilityProjection, ExecutionAuthority, LocalSandboxConfig,
};
use serde_json::{json, Value};
use std::path::PathBuf;
use std::sync::Arc;
use uuid::Uuid;

/// A harmless tool that exercises the complete provider -> runtime -> tool ->
/// provider loop. Product agents can replace the registry without changing the
/// conversation API.
pub struct RuntimeProbeTool;

#[async_trait]
impl Tool for RuntimeProbeTool {
    fn name(&self) -> &str {
        "runtime_probe"
    }

    fn description(&self) -> &str {
        "Return the supplied short text to verify that tool execution works."
    }

    fn schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": { "text": { "type": "string" } },
            "required": ["text"],
            "additionalProperties": false
        })
    }

    async fn execute(&self, call: ToolCall, _ctx: ToolInvocationContext) -> Result<ToolResult> {
        let text = call
            .input
            .get("text")
            .and_then(Value::as_str)
            .context("runtime_probe requires text")?;
        Ok(ToolResult::text(call.id, text, json!({"probe": true})))
    }
}

pub async fn configured_provider() -> Result<Arc<dyn ModelProvider>> {
    let mut settings = provider_settings()?;
    let negotiation = negotiate_provider_settings(&settings)
        .await
        .context("model provider connection negotiation failed")?;
    if !negotiation.health.reachable || !negotiation.health.model_available {
        return Err(anyhow!(
            "model provider is unreachable or model is unavailable: {}",
            negotiation
                .health
                .error
                .as_deref()
                .unwrap_or("no reason reported")
        ));
    }
    if let Some(report) = negotiation
        .health
        .openai_compatibility
        .filter(|report| report.applies_to(&settings.base_url, &settings.model))
    {
        settings.apply_openai_compatibility_report(report);
    } else {
        for profile in negotiation.adapter_profiles {
            if profile.applies_to(&settings.base_url, &settings.model) {
                settings.apply_adapter_profile(profile);
            }
        }
    }
    configured_provider_from_settings(&settings).ok_or_else(|| {
        anyhow!(
            "Model provider is not configured; set OPENTOPIA_API_KEY, OPENTOPIA_MODEL, and OPENTOPIA_OPENAI_BASE_URL"
        )
    })
}

/// Cloud instances are ephemeral, so connection negotiation must not run on
/// every cold start. The first real turn uses OpenTopia's portable tool-capable
/// profile; connection diagnostics remain available in the local setup path.
pub fn configured_cloud_provider() -> Result<Arc<dyn ModelProvider>> {
    let mut settings = provider_settings()?;
    if settings.active_adapter_profile().is_none() {
        if let Some(profile) = settings.provisional_adapter_profile_for_model(&settings.model) {
            settings.apply_adapter_profile(profile);
        }
    }
    configured_provider_from_settings(&settings).ok_or_else(|| {
        anyhow!(
            "Model provider is not configured; set OPENTOPIA_API_KEY, OPENTOPIA_MODEL, and OPENTOPIA_OPENAI_BASE_URL"
        )
    })
}

fn provider_settings() -> Result<ProviderSettings> {
    let Ok(database) = std::env::var("VIDEOFLOW_OPENTOPIA_DB") else {
        return Ok(ProviderSettings::from_env());
    };
    let provider_id = std::env::var("VIDEOFLOW_PROVIDER_ID")
        .context("VIDEOFLOW_PROVIDER_ID is required with VIDEOFLOW_OPENTOPIA_DB")?;
    let conn = rusqlite::Connection::open_with_flags(
        database,
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
    )?;
    let settings_json: String = conn.query_row(
        "SELECT settings_json FROM app_settings WHERE id = 1",
        [],
        |row| row.get(0),
    )?;
    let app: AppSettings = serde_json::from_str(&settings_json)?;
    app.providers
        .into_iter()
        .find(|provider| provider.id == provider_id)
        .ok_or_else(|| anyhow!("provider id not found in OpenTopia settings"))
}

pub fn default_registry() -> ToolRegistry {
    let mut tools = ToolRegistry::default();
    tools.register(Arc::new(RuntimeProbeTool));
    tools
}

pub fn conversation_context() -> CompiledModelContext {
    CompiledModelContext {
        items: vec![ModelContextItem::text(
            ContextItemKind::BaseInstructions,
            ContextRole::System,
            "videoflow.runtime",
            "You are an assistant in a web application. Answer the user's request. Use only available tools when they help. Never invent a tool result.",
            ContextCacheScope::Stable,
            ContextSensitivity::Public,
        )],
        prompt_cache_key: None,
    }
}

pub async fn run_once(
    provider: Arc<dyn ModelProvider>,
    tools: ToolRegistry,
    workspace: PathBuf,
    thread_id: Uuid,
    turn_id: Uuid,
    user_message_id: Uuid,
    content: String,
    conversation: Vec<opentopia_core::provider::ModelConversationMessage>,
    sender: Option<opentopia_core::AgentEventSender>,
) -> Result<opentopia_core::AgentTurnResult> {
    let authority = ExecutionAuthority::new(
        workspace.clone(),
        PermissionMode::Unrestricted,
        LocalSandboxConfig::default(),
        CapabilityProjection::unrestricted(),
    )?;
    let prepared = AgentCore::new(provider, tools)
        .begin_run(
            AgentRunConfig::using_current_provider(authority, AgentRunIdentity::root(turn_id, 1))
                .with_experience_mode(ExperienceMode::Work),
        )?
        .finalize()?;
    let context = prepared.prepare_turn(
        AgentTurnInput {
            thread_id,
            user_message_id,
            workspace_root: workspace,
            content,
            user_content: Vec::new(),
            context_summary: None,
            conversation,
            permission_mode: PermissionMode::Unrestricted,
            context_budget: None,
            provider_cursor: None,
            store: None,
            cancellation: None,
        },
        Some(conversation_context()),
    )?;
    let result = AgentTurnDriver::run_turn(&prepared, context, sender).await?;
    if let opentopia_core::AgentTurnOutcome::Completed = result.outcome {
        return Ok(result);
    }
    let terminal = result
        .events
        .iter()
        .rev()
        .find_map(|event| match event {
            AgentEventPayload::Error { message } => Some(message.as_str()),
            _ => None,
        })
        .unwrap_or("turn did not complete");
    Err(anyhow!(terminal.to_owned()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use opentopia_core::model::AgentEventPayload;
    use opentopia_core::provider::{
        MockProvider, ModelFinishReason, ModelRequest, ModelResponse, ProviderToolCall,
    };
    use opentopia_core::settings::ProviderHealthCheck;
    use std::sync::atomic::{AtomicUsize, Ordering};

    struct ToolCallingProvider(AtomicUsize);

    #[async_trait]
    impl ModelProvider for ToolCallingProvider {
        async fn complete(&self, _request: ModelRequest) -> Result<ModelResponse> {
            if self.0.fetch_add(1, Ordering::SeqCst) == 0 {
                Ok(ModelResponse {
                    text: String::new(),
                    tool_calls: vec![ProviderToolCall {
                        id: "probe-call-1".into(),
                        name: "runtime_probe".into(),
                        arguments: json!({ "text": "probe-ok" }),
                    }],
                    usage: None,
                    response_id: None,
                    provider_items: Vec::new(),
                    finish_reason: ModelFinishReason::ToolCalls,
                })
            } else {
                Ok(ModelResponse::text("probe complete"))
            }
        }

        async fn check_health(&self) -> Result<ProviderHealthCheck> {
            MockProvider.check_health().await
        }
    }

    #[tokio::test]
    async fn model_tool_result_returns_to_same_turn() {
        let provider: Arc<dyn ModelProvider> = Arc::new(ToolCallingProvider(AtomicUsize::new(0)));
        let result = run_once(
            provider,
            default_registry(),
            std::env::temp_dir(),
            Uuid::new_v4(),
            Uuid::new_v4(),
            Uuid::new_v4(),
            "Call the probe tool.".into(),
            Vec::new(),
            None,
        )
        .await
        .expect("the tool loop completes");
        assert!(result
            .events
            .iter()
            .any(|event| matches!(event, AgentEventPayload::ToolCallStarted { .. })));
        assert!(result.events.iter().any(|event| matches!(
            event,
            AgentEventPayload::ToolCallFinished { result } if result.output == "probe-ok"
        )));
        assert!(result
            .events
            .iter()
            .any(|event| matches!(event, AgentEventPayload::AssistantMessage { .. })));
    }
}
