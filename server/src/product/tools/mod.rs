use crate::product::application::proposals::{CreateProposal, ProposalService};
use crate::product::application::workspace_threads::WorkspaceThreadStore;
use crate::product::domain::{
    AssetBindingId, ChangeProposal, MediaId, ProductError, ProductResult, ProjectId,
    ProposalSource, ProposalTarget, StoryboardId,
};
use anyhow::{Context, Result};
use async_trait::async_trait;
use opentopia_core::model::{ToolCall, ToolResult};
use opentopia_core::tools::{
    Tool, ToolExecutionPolicy, ToolInvocationContext, ToolRegistry, ToolSideEffect,
};
use serde::Deserialize;
use serde_json::{json, Value};
use std::sync::Arc;
use uuid::Uuid;

const SCRIPT_TOOL_NAME: &str = "propose_script_change";
const MEDIA_PROMPT_TOOL_NAME: &str = "propose_media_prompt_change";

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
struct BoundStoryboardScope {
    project_id: ProjectId,
    storyboard_id: StoryboardId,
}

#[derive(Clone)]
pub struct WorkspaceThreadScopeResolver {
    store: Arc<dyn WorkspaceThreadStore>,
}

impl WorkspaceThreadScopeResolver {
    pub fn new(store: Arc<dyn WorkspaceThreadStore>) -> Self {
        Self { store }
    }

    async fn resolve(&self, thread_id: Uuid) -> ProductResult<BoundStoryboardScope> {
        let binding = self
            .store
            .find_by_thread(thread_id)
            .await?
            .ok_or(ProductError::NotFound)?;
        Ok(BoundStoryboardScope {
            project_id: binding.project_id,
            storyboard_id: binding.storyboard_id,
        })
    }
}

#[derive(Clone)]
struct ProductToolServices {
    proposals: ProposalService,
    scope: WorkspaceThreadScopeResolver,
}

pub fn register_product_tools(
    registry: &mut ToolRegistry,
    proposals: ProposalService,
    scope: WorkspaceThreadScopeResolver,
) {
    let services = ProductToolServices { proposals, scope };
    registry.register(Arc::new(ProposeScriptChangeTool {
        services: services.clone(),
    }));
    registry.register(Arc::new(ProposeMediaPromptChangeTool { services }));
}

struct ProposeScriptChangeTool {
    services: ProductToolServices,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ScriptChangeInput {
    proposed_text: String,
    summary: String,
}

#[async_trait]
impl Tool for ProposeScriptChangeTool {
    fn name(&self) -> &str {
        SCRIPT_TOOL_NAME
    }

    fn description(&self) -> &str {
        "Propose a complete script replacement for the storyboard bound to this conversation. The proposal is saved as pending and does not change the script until the user confirms it."
    }

    fn schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "proposedText": { "type": "string", "minLength": 1, "maxLength": 20000 },
                "summary": { "type": "string", "minLength": 1, "maxLength": 300 }
            },
            "required": ["proposedText", "summary"],
            "additionalProperties": false
        })
    }

    fn execution_policy(&self, _call: &ToolCall) -> ToolExecutionPolicy {
        proposal_execution_policy()
    }

    async fn execute(&self, call: ToolCall, ctx: ToolInvocationContext) -> Result<ToolResult> {
        let input: ScriptChangeInput = serde_json::from_value(call.input.clone())
            .context("propose_script_change received invalid input")?;
        let invocation = invocation_scope(&ctx)?;
        let scope = self.services.scope.resolve(invocation.thread_id).await?;
        let proposal = self
            .services
            .proposals
            .create(CreateProposal {
                project_id: scope.project_id,
                storyboard_id: scope.storyboard_id,
                target: ProposalTarget::Script {
                    storyboard_id: scope.storyboard_id,
                },
                proposed_value: input.proposed_text,
                summary: input.summary,
                source: invocation.source(call.id),
            })
            .await?;
        proposal_result(call.id, proposal, "脚本修改已提交，等待用户确认。")
    }
}

struct ProposeMediaPromptChangeTool {
    services: ProductToolServices,
}

#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "camelCase")]
enum PromptTargetType {
    Media,
    AssetBinding,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct MediaPromptChangeInput {
    target_type: PromptTargetType,
    target_id: Uuid,
    proposed_prompt: String,
    summary: String,
}

#[async_trait]
impl Tool for ProposeMediaPromptChangeTool {
    fn name(&self) -> &str {
        MEDIA_PROMPT_TOOL_NAME
    }

    fn description(&self) -> &str {
        "Propose a prompt replacement for media or an asset binding visible in the storyboard bound to this conversation. The proposal is saved as pending and regeneration starts only after user confirmation."
    }

    fn schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "targetType": { "type": "string", "enum": ["media", "assetBinding"] },
                "targetId": { "type": "string", "format": "uuid" },
                "proposedPrompt": { "type": "string", "minLength": 1, "maxLength": 10000 },
                "summary": { "type": "string", "minLength": 1, "maxLength": 300 }
            },
            "required": ["targetType", "targetId", "proposedPrompt", "summary"],
            "additionalProperties": false
        })
    }

    fn execution_policy(&self, _call: &ToolCall) -> ToolExecutionPolicy {
        proposal_execution_policy()
    }

    async fn execute(&self, call: ToolCall, ctx: ToolInvocationContext) -> Result<ToolResult> {
        let input: MediaPromptChangeInput = serde_json::from_value(call.input.clone())
            .context("propose_media_prompt_change received invalid input")?;
        let invocation = invocation_scope(&ctx)?;
        let scope = self.services.scope.resolve(invocation.thread_id).await?;
        let target = match input.target_type {
            PromptTargetType::Media => ProposalTarget::MediaPrompt {
                media_id: MediaId(input.target_id),
            },
            PromptTargetType::AssetBinding => ProposalTarget::AssetBindingPrompt {
                binding_id: AssetBindingId(input.target_id),
            },
        };
        let proposal = self
            .services
            .proposals
            .create(CreateProposal {
                project_id: scope.project_id,
                storyboard_id: scope.storyboard_id,
                target,
                proposed_value: input.proposed_prompt,
                summary: input.summary,
                source: invocation.source(call.id),
            })
            .await?;
        proposal_result(
            call.id,
            proposal,
            "提示词修改已提交，确认后才会应用并创建生成任务。",
        )
    }
}

#[derive(Clone, Copy)]
struct InvocationScope {
    thread_id: Uuid,
    turn_id: Uuid,
}

impl InvocationScope {
    fn source(self, tool_call_id: Uuid) -> ProposalSource {
        ProposalSource {
            thread_id: self.thread_id,
            turn_id: self.turn_id,
            tool_call_id: tool_call_id.to_string(),
        }
    }
}

fn invocation_scope(ctx: &ToolInvocationContext) -> Result<InvocationScope> {
    Ok(InvocationScope {
        thread_id: ctx
            .thread_id
            .context("product proposal tools require a bound conversation thread")?,
        turn_id: ctx
            .agent_turn_id
            .context("product proposal tools require an active turn")?,
    })
}

fn proposal_result(call_id: Uuid, proposal: ChangeProposal, message: &str) -> Result<ToolResult> {
    let payload = json!({
        "proposalId": proposal.id,
        "status": proposal.status,
        "targetType": proposal.target.target_type(),
        "targetId": proposal.target.target_id(),
        "baseRevision": proposal.base_revision,
        "summary": proposal.summary,
        "message": message,
    });
    Ok(ToolResult::text(
        call_id,
        serde_json::to_string(&payload)?,
        payload,
    ))
}

fn proposal_execution_policy() -> ToolExecutionPolicy {
    ToolExecutionPolicy {
        read_only: false,
        idempotent: true,
        parallel_safe: false,
        side_effect: ToolSideEffect::SessionMutation,
        resource_keys: vec!["videoflow:change-proposals".into()],
    }
}

#[cfg(test)]
mod tests;
