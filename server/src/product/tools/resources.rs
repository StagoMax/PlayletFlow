use super::*;

pub(super) struct SearchStoryboardAssetsTool {
    pub(super) services: ProductToolServices,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SearchInput {
    #[serde(default)]
    query: String,
    kind: Option<String>,
    #[serde(default)]
    offset: usize,
    limit: Option<usize>,
}

#[async_trait]
impl Tool for SearchStoryboardAssetsTool {
    fn name(&self) -> &str {
        SEARCH_TOOL_NAME
    }

    fn description(&self) -> &str {
        "Search the current storyboard's text, bound assets, images, and videos by name or content. Returns stable IDs and revisions for read/edit calls; use offset for more results."
    }

    fn schema(&self) -> Value {
        json!({"type":"object","properties":{
            "query":{"type":"string"},
            "kind":{"type":"string","enum":["text","assetBinding","image","video"]},
            "offset":{"type":"integer","minimum":0},
            "limit":{"type":"integer","minimum":1,"maximum":100}
        },"additionalProperties":false})
    }

    fn execution_policy(&self, _call: &ToolCall) -> ToolExecutionPolicy {
        read_policy()
    }

    async fn execute(&self, call: ToolCall, ctx: ToolInvocationContext) -> Result<ToolResult> {
        let input: SearchInput = serde_json::from_value(call.input.clone())?;
        let thread_id = invocation_scope(&ctx)?.thread_id;
        let query = input.query.to_lowercase();
        let matches = self
            .services
            .resources(thread_id)
            .await?
            .into_iter()
            .filter(|item| input.kind.as_deref().is_none_or(|kind| item.kind == kind))
            .filter(|item| {
                query.is_empty()
                    || item.name.to_lowercase().contains(&query)
                    || item
                        .content
                        .as_deref()
                        .unwrap_or("")
                        .to_lowercase()
                        .contains(&query)
            })
            .collect::<Vec<_>>();
        let total = matches.len();
        let items = matches
            .into_iter()
            .skip(input.offset)
            .take(input.limit.unwrap_or(50).min(100))
            .map(|item| {
                json!({
                    "id": item.id, "kind": item.kind, "name": item.name,
                    "role": item.role, "status": item.status,
                    "revision": item.revision, "editable": item.editable,
                })
            })
            .collect::<Vec<_>>();
        let payload = json!({"total":total,"offset":input.offset,"items":items});
        Ok(ToolResult::text(
            call.id,
            serde_json::to_string(&payload)?,
            payload,
        ))
    }
}

pub(super) struct ReadStoryboardAssetTool {
    pub(super) services: ProductToolServices,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ReadInput {
    kind: String,
    id: String,
}

#[async_trait]
impl Tool for ReadStoryboardAssetTool {
    fn name(&self) -> &str {
        READ_TOOL_NAME
    }

    fn description(&self) -> &str {
        "Read current storyboard resource content, prompt, status, and revision by the ID and kind returned by search_storyboard_assets."
    }

    fn schema(&self) -> Value {
        json!({"type":"object","properties":{
            "kind":{"type":"string","enum":["text","assetBinding","image","video"]},
            "id":{"type":"string"}
        },"required":["kind","id"],"additionalProperties":false})
    }

    fn execution_policy(&self, _call: &ToolCall) -> ToolExecutionPolicy {
        read_policy()
    }

    async fn execute(&self, call: ToolCall, ctx: ToolInvocationContext) -> Result<ToolResult> {
        let input: ReadInput = serde_json::from_value(call.input.clone())?;
        let thread_id = invocation_scope(&ctx)?.thread_id;
        let item = self
            .services
            .resources(thread_id)
            .await?
            .into_iter()
            .find(|item| item.kind == input.kind && item.id == input.id)
            .ok_or(ProductError::NotFound)?;
        let payload = serde_json::to_value(item)?;
        Ok(ToolResult::text(
            call.id,
            serde_json::to_string(&payload)?,
            payload,
        ))
    }
}
