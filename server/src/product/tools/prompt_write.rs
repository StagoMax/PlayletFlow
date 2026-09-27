use super::*;
use crate::product::application::workspace_nodes::SaveWorkspaceObjectPromptInput;

pub(super) struct SaveWorkspaceObjectPromptTool {
    pub(super) services: ProductToolServices,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SaveWorkspaceObjectPromptToolInput {
    target_id: Uuid,
    base_revision: i64,
    prompt: String,
}

#[async_trait]
impl Tool for SaveWorkspaceObjectPromptTool {
    fn name(&self) -> &str {
        SAVE_OBJECT_PROMPT_TOOL_NAME
    }

    fn description(&self) -> &str {
        "Save a prompt directly into an existing image or video object's prompt editor without generating media. Use this when the user asks to write, fill, draft, revise, or generate only a prompt. The new prompt becomes the only visible current version; the previous version is retained for the user's Ctrl+Z undo. Read or search first for targetId and baseRevision. This never creates a proposal or a generation job."
    }

    fn schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "targetId": { "type": "string", "format": "uuid" },
                "baseRevision": { "type": "integer", "minimum": 1 },
                "prompt": { "type": "string", "minLength": 1, "maxLength": 10000 }
            },
            "required": ["targetId", "baseRevision", "prompt"],
            "additionalProperties": false
        })
    }

    fn execution_policy(&self, _call: &ToolCall) -> ToolExecutionPolicy {
        workspace_mutation_policy()
    }

    async fn execute(&self, call: ToolCall, ctx: ToolInvocationContext) -> Result<ToolResult> {
        let input: SaveWorkspaceObjectPromptToolInput = serde_json::from_value(call.input.clone())
            .context("save_workspace_object_prompt received invalid input")?;
        let invocation = invocation_scope(&ctx)?;
        let scope = self.services.scope.resolve(invocation.thread_id).await?;
        let target_id = input.target_id.to_string();
        let resource = self
            .services
            .resources(invocation.thread_id)
            .await?
            .into_iter()
            .find(|item| item.id == target_id && matches!(item.kind.as_str(), "image" | "video"))
            .ok_or(ProductError::NotFound)?;
        if !resource.editable {
            return Err(ProductError::Validation(
                "only storyboard-owned image or video objects can be updated directly".into(),
            )
            .into());
        }
        let saved = self
            .services
            .workspace_nodes
            .save_object_prompt(
                SaveWorkspaceObjectPromptInput {
                    project_id: scope.project_id,
                    storyboard_id: scope.storyboard_id,
                    target_id,
                    prompt: input.prompt,
                    expected_revision: input.base_revision,
                },
                call.id.to_string(),
            )
            .await?;
        let payload = json!({
            "objectId": saved.object_id,
            "mediaId": saved.media_id,
            "objectType": saved.object_type,
            "revision": saved.revision,
            "generationRequested": false,
            "message": "提示词已写入对象输入框，未发送生成。"
        });
        Ok(ToolResult::text(
            call.id,
            serde_json::to_string(&payload)?,
            payload,
        ))
    }
}
