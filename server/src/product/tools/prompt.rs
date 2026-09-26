use super::*;

pub(super) struct ProposeImagePromptChangeTool {
    pub(super) services: ProductToolServices,
}

pub(super) struct ProposeVideoPromptChangeTool {
    pub(super) services: ProductToolServices,
}

#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "camelCase")]
enum PromptTargetType {
    Media,
    AssetBinding,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PromptChangeInput {
    target_type: Option<PromptTargetType>,
    target_id: Uuid,
    base_revision: i64,
    proposed_prompt: String,
    input: GenerationInputSelection,
    summary: String,
}

#[async_trait]
impl Tool for ProposeImagePromptChangeTool {
    fn name(&self) -> &str {
        IMAGE_TOOL_NAME
    }

    fn description(&self) -> &str {
        "Propose an image prompt and its ordered reference images for an image or bound asset in this storyboard. Use search/read first. Nothing changes until user confirmation."
    }

    fn schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "targetType": { "type": "string", "enum": ["media", "assetBinding"] },
                "targetId": { "type": "string", "format": "uuid" },
                "baseRevision": { "type": "integer", "minimum": 1 },
                "proposedPrompt": { "type": "string", "minLength": 1, "maxLength": 10000 },
                "input": { "type": "object", "properties": {
                    "type": { "type": "string", "enum": ["textOnly", "referenceImages"] },
                    "mediaIds": { "type": "array", "items": { "type": "string", "format": "uuid" }, "maxItems": 14 }
                }, "required": ["type"], "additionalProperties": false },
                "summary": { "type": "string", "minLength": 1, "maxLength": 300 }
            },
            "required": ["targetType", "targetId", "baseRevision", "proposedPrompt", "input", "summary"],
            "additionalProperties": false
        })
    }

    fn execution_policy(&self, _call: &ToolCall) -> ToolExecutionPolicy {
        proposal_execution_policy()
    }

    async fn execute(&self, call: ToolCall, ctx: ToolInvocationContext) -> Result<ToolResult> {
        ensure_input_shape(&call.input)?;
        let input: PromptChangeInput = serde_json::from_value(call.input.clone())
            .context("propose_image_prompt_change received invalid input")?;
        if matches!(
            input.input,
            GenerationInputSelection::FirstLastFrames { .. }
        ) {
            return Err(ProductError::Validation(
                "image prompts cannot use first/last frames".into(),
            )
            .into());
        }
        propose_prompt(&self.services, call.id, ctx, input, "image").await
    }
}

#[async_trait]
impl Tool for ProposeVideoPromptChangeTool {
    fn name(&self) -> &str {
        VIDEO_TOOL_NAME
    }

    fn description(&self) -> &str {
        "Propose a video prompt. Input is textOnly, strict first/last frames, or ordered reference images. The two image input families are mutually exclusive. Read target and referenced assets first."
    }

    fn schema(&self) -> Value {
        json!({"type":"object","properties":{
            "targetId":{"type":"string","format":"uuid"},
            "baseRevision":{"type":"integer","minimum":1},
            "proposedPrompt":{"type":"string","minLength":1,"maxLength":10000},
            "input":{"type":"object","properties":{
                "type":{"type":"string","enum":["textOnly","firstLastFrames","referenceImages"]},
                "firstFrameMediaId":{"type":"string","format":"uuid"},
                "lastFrameMediaId":{"type":["string","null"],"format":"uuid"},
                "mediaIds":{"type":"array","items":{"type":"string","format":"uuid"},"maxItems":9}
            },"required":["type"],"additionalProperties":false},
            "summary":{"type":"string","minLength":1,"maxLength":300}
        },"required":["targetId","baseRevision","proposedPrompt","input","summary"],
        "additionalProperties":false})
    }

    fn execution_policy(&self, _call: &ToolCall) -> ToolExecutionPolicy {
        proposal_execution_policy()
    }

    async fn execute(&self, call: ToolCall, ctx: ToolInvocationContext) -> Result<ToolResult> {
        ensure_input_shape(&call.input)?;
        let input: PromptChangeInput = serde_json::from_value(call.input.clone())
            .context("propose_video_prompt_change received invalid input")?;
        if input.target_type.is_some() {
            return Err(ProductError::Validation("video targetType must be omitted".into()).into());
        }
        propose_prompt(&self.services, call.id, ctx, input, "video").await
    }
}

async fn propose_prompt(
    services: &ProductToolServices,
    call_id: Uuid,
    ctx: ToolInvocationContext,
    input: PromptChangeInput,
    kind: &str,
) -> Result<ToolResult> {
    let invocation = invocation_scope(&ctx)?;
    let scope = services.scope.resolve(invocation.thread_id).await?;
    let resource = services
        .resources(invocation.thread_id)
        .await?
        .into_iter()
        .find(|item| item.id == input.target_id.to_string())
        .ok_or(ProductError::NotFound)?;
    if !resource.editable {
        return Err(ProductError::Validation(
            "shared asset media is read-only in a storyboard; edit its asset binding prompt".into(),
        )
        .into());
    }
    let target = match (kind, input.target_type) {
        ("image", Some(PromptTargetType::Media)) if resource.kind == "image" => {
            ProposalTarget::MediaPrompt {
                media_id: MediaId(input.target_id),
            }
        }
        ("image", Some(PromptTargetType::AssetBinding)) if resource.kind == "assetBinding" => {
            ProposalTarget::AssetBindingPrompt {
                binding_id: AssetBindingId(input.target_id),
            }
        }
        ("video", None) if resource.kind == "video" => ProposalTarget::MediaPrompt {
            media_id: MediaId(input.target_id),
        },
        _ => {
            return Err(
                ProductError::Validation("target kind does not match prompt tool".into()).into(),
            )
        }
    };
    if resource.revision != input.base_revision {
        return Err(ProductError::RevisionConflict {
            expected: input.base_revision,
            actual: resource.revision,
        }
        .into());
    }
    let proposal = services
        .proposals
        .create(CreateProposal {
            project_id: scope.project_id,
            storyboard_id: scope.storyboard_id,
            target,
            proposed_value: input.proposed_prompt,
            proposed_input: Some(input.input),
            summary: input.summary,
            source: invocation.source(call_id),
        })
        .await?;
    proposal_result(
        call_id,
        proposal,
        "提示词修改已提交，确认后才会应用并创建生成任务。",
    )
}

fn ensure_input_shape(value: &Value) -> Result<()> {
    let input = value
        .get("input")
        .and_then(Value::as_object)
        .ok_or_else(|| ProductError::Validation("input must be an object".into()))?;
    let allowed: &[&str] = match input.get("type").and_then(Value::as_str) {
        Some("textOnly") => &["type"],
        Some("firstLastFrames") => &["type", "firstFrameMediaId", "lastFrameMediaId"],
        Some("referenceImages") => &["type", "mediaIds"],
        _ => return Err(ProductError::Validation("unsupported input mode".into()).into()),
    };
    if input.keys().any(|key| !allowed.contains(&key.as_str())) {
        return Err(
            ProductError::Validation("generation input modes cannot be mixed".into()).into(),
        );
    }
    Ok(())
}
