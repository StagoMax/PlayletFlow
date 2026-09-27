use super::*;
use crate::product::application::workspace_nodes::CreatePromptedMediaObjectInput;

pub(super) struct CreateWorkspaceObjectTool {
    pub(super) services: ProductToolServices,
}

#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "camelCase")]
enum MediaObjectType {
    Image,
    Video,
}

impl From<MediaObjectType> for WorkspaceObjectType {
    fn from(value: MediaObjectType) -> Self {
        match value {
            MediaObjectType::Image => Self::Image,
            MediaObjectType::Video => Self::Video,
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CreateWorkspaceObjectInput {
    parent_id: Option<String>,
    name: String,
    object_type: MediaObjectType,
    prompt: String,
}

#[async_trait]
impl Tool for CreateWorkspaceObjectTool {
    fn name(&self) -> &str {
        CREATE_OBJECT_TOOL_NAME
    }

    fn description(&self) -> &str {
        "Create an image or video object in a folder from the current storyboard's folder context, and save only its prompt. This never starts media generation. Use the folder's stable ID as parentId, or null for the sidebar root."
    }

    fn schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "parentId": { "type": ["string", "null"], "minLength": 1, "maxLength": 200 },
                "name": { "type": "string", "minLength": 1, "maxLength": 120 },
                "objectType": { "type": "string", "enum": ["image", "video"] },
                "prompt": { "type": "string", "minLength": 1, "maxLength": 10000 }
            },
            "required": ["parentId", "name", "objectType", "prompt"],
            "additionalProperties": false
        })
    }

    fn execution_policy(&self, _call: &ToolCall) -> ToolExecutionPolicy {
        workspace_mutation_policy()
    }

    async fn execute(&self, call: ToolCall, ctx: ToolInvocationContext) -> Result<ToolResult> {
        let input: CreateWorkspaceObjectInput = serde_json::from_value(call.input.clone())
            .context("create_workspace_object received invalid input")?;
        let invocation = invocation_scope(&ctx)?;
        let scope = self.services.scope.resolve(invocation.thread_id).await?;
        let object_type: WorkspaceObjectType = input.object_type.into();
        let node = self
            .services
            .workspace_nodes
            .create_prompted_media_object(
                CreatePromptedMediaObjectInput {
                    project_id: scope.project_id,
                    storyboard_id: scope.storyboard_id,
                    parent_id: input.parent_id,
                    name: input.name,
                    object_type,
                    prompt: input.prompt,
                },
                call.id.to_string(),
            )
            .await?;
        let payload = json!({
            "objectId": node.id,
            "mediaId": node.target_id,
            "parentId": node.parent_id,
            "name": node.name,
            "objectType": object_type,
            "mediaStatus": "placeholder",
            "generationRequested": false,
            "message": "对象和提示词已创建，未发送生成。"
        });
        Ok(ToolResult::text(
            call.id,
            serde_json::to_string(&payload)?,
            payload,
        ))
    }
}
