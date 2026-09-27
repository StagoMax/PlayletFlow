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
    #[serde(default)]
    reference_ids: Vec<String>,
}

#[async_trait]
impl Tool for CreateWorkspaceObjectTool {
    fn name(&self) -> &str {
        CREATE_OBJECT_TOOL_NAME
    }

    fn description(&self) -> &str {
        "Create an image or video object in the current storyboard and save its prompt without generation. For asset @mentions, pass the stable IDs returned by search_storyboard_assets in referenceIds; they become visible asset references in the prompt editor. Use a folder ID as parentId, or null for the root."
    }

    fn schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "parentId": { "type": ["string", "null"], "minLength": 1, "maxLength": 200 },
                "name": { "type": "string", "minLength": 1, "maxLength": 120 },
                "objectType": { "type": "string", "enum": ["image", "video"] },
                "prompt": { "type": "string", "minLength": 1, "maxLength": 10000 },
                "referenceIds": { "type": "array", "items": { "type": "string" }, "uniqueItems": true }
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
        let prompt = self
            .services
            .referenced_prompt(
                invocation.thread_id,
                &input.prompt,
                &input.reference_ids,
                &[],
            )
            .await?;
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
                    prompt: prompt.value,
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
            "referenceIds": prompt.reference_ids,
            "message": "对象和提示词已创建，未发送生成。"
        });
        Ok(ToolResult::text(
            call.id,
            serde_json::to_string(&payload)?,
            payload,
        ))
    }
}
