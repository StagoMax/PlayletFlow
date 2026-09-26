use crate::product::application::proposals::{CreateProposal, ProposalService};
use crate::product::application::workspace_threads::{StoryboardResource, WorkspaceThreadStore};
use crate::product::domain::{
    AssetBindingId, ChangeProposal, GenerationInputSelection, MediaId, ProductError, ProductResult,
    ProjectId, ProposalSource, ProposalTarget, StoryboardId,
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

mod prompt;
mod resources;

use prompt::{ProposeImagePromptChangeTool, ProposeVideoPromptChangeTool};
use resources::{ReadStoryboardAssetTool, SearchStoryboardAssetsTool};

const SEARCH_TOOL_NAME: &str = "search_storyboard_assets";
const READ_TOOL_NAME: &str = "read_storyboard_asset";
const TEXT_TOOL_NAME: &str = "propose_text_patch";
const IMAGE_TOOL_NAME: &str = "propose_image_prompt_change";
const VIDEO_TOOL_NAME: &str = "propose_video_prompt_change";

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

impl ProductToolServices {
    async fn resources(&self, thread_id: Uuid) -> ProductResult<Vec<StoryboardResource>> {
        self.scope.store.list_resources(thread_id).await
    }
}

pub fn register_product_tools(
    registry: &mut ToolRegistry,
    proposals: ProposalService,
    scope: WorkspaceThreadScopeResolver,
) {
    let services = ProductToolServices { proposals, scope };
    registry.register(Arc::new(SearchStoryboardAssetsTool {
        services: services.clone(),
    }));
    registry.register(Arc::new(ReadStoryboardAssetTool {
        services: services.clone(),
    }));
    registry.register(Arc::new(ProposeTextPatchTool {
        services: services.clone(),
    }));
    registry.register(Arc::new(ProposeImagePromptChangeTool {
        services: services.clone(),
    }));
    registry.register(Arc::new(ProposeVideoPromptChangeTool { services }));
}

struct ProposeTextPatchTool {
    services: ProductToolServices,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct TextPatchInput {
    target_id: Uuid,
    base_revision: i64,
    old_text: String,
    new_text: String,
    summary: String,
}

#[async_trait]
impl Tool for ProposeTextPatchTool {
    fn name(&self) -> &str {
        TEXT_TOOL_NAME
    }

    fn description(&self) -> &str {
        "Apply one exact-context text replacement to the selected storyboard script and save the result as a proposal for user confirmation. Read the resource first to obtain its ID and revision."
    }

    fn schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "targetId": { "type": "string", "format": "uuid" },
                "baseRevision": { "type": "integer", "minimum": 1 },
                "oldText": { "type": "string", "minLength": 1 },
                "newText": { "type": "string" },
                "summary": { "type": "string", "minLength": 1, "maxLength": 300 }
            },
            "required": ["targetId", "baseRevision", "oldText", "newText", "summary"],
            "additionalProperties": false
        })
    }

    fn execution_policy(&self, _call: &ToolCall) -> ToolExecutionPolicy {
        proposal_execution_policy()
    }

    async fn execute(&self, call: ToolCall, ctx: ToolInvocationContext) -> Result<ToolResult> {
        let input: TextPatchInput = serde_json::from_value(call.input.clone())
            .context("propose_text_patch received invalid input")?;
        let invocation = invocation_scope(&ctx)?;
        let scope = self.services.scope.resolve(invocation.thread_id).await?;
        if input.target_id != scope.storyboard_id.0 {
            return Err(ProductError::NotFound.into());
        }
        let resource = self
            .services
            .resources(invocation.thread_id)
            .await?
            .into_iter()
            .find(|item| item.kind == "text" && item.id == input.target_id.to_string())
            .ok_or(ProductError::NotFound)?;
        if resource.revision != input.base_revision {
            return Err(ProductError::RevisionConflict {
                expected: input.base_revision,
                actual: resource.revision,
            }
            .into());
        }
        let current = resource.content.ok_or(ProductError::NotFound)?;
        if input.old_text.is_empty() || current.matches(&input.old_text).count() != 1 {
            return Err(ProductError::Validation(
                "oldText must match exactly once in the current text".into(),
            )
            .into());
        }
        let proposed_text = current.replacen(&input.old_text, &input.new_text, 1);
        let proposal = self
            .services
            .proposals
            .create(CreateProposal {
                project_id: scope.project_id,
                storyboard_id: scope.storyboard_id,
                target: ProposalTarget::Script {
                    storyboard_id: scope.storyboard_id,
                },
                proposed_value: proposed_text,
                proposed_input: None,
                summary: input.summary,
                source: invocation.source(call.id),
            })
            .await?;
        proposal_result(call.id, proposal, "脚本修改已提交，等待用户确认。")
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
        "proposedInput": proposal.proposed_input,
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

fn read_policy() -> ToolExecutionPolicy {
    ToolExecutionPolicy {
        read_only: true,
        idempotent: true,
        parallel_safe: true,
        side_effect: ToolSideEffect::None,
        resource_keys: Vec::new(),
    }
}

#[cfg(test)]
mod tests;
