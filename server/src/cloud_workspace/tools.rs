use super::{CloudDocument, CloudWorkspaceStore};
use crate::prompt_references::{
    compose_referenced_prompt, PromptReferenceSource, ReferencedPrompt,
};
use anyhow::{anyhow, bail, Context, Result};
use async_trait::async_trait;
use chrono::Utc;
use opentopia_core::model::{ToolCall, ToolResult};
use opentopia_core::tools::{
    Tool, ToolExecutionPolicy, ToolInvocationContext, ToolRegistry, ToolSideEffect,
};
use serde_json::{json, Value};
use std::sync::Arc;
use uuid::Uuid;

const NAMES: [&str; 7] = [
    "create_workspace_object",
    "save_workspace_object_prompt",
    "search_storyboard_assets",
    "read_storyboard_asset",
    "propose_text_patch",
    "propose_image_prompt_change",
    "propose_video_prompt_change",
];

#[derive(Clone)]
struct Scope {
    store: CloudWorkspaceStore,
    token: Uuid,
    project_id: String,
    storyboard_id: String,
}

struct CloudTool {
    kind: usize,
    scope: Scope,
}

pub fn registry_for(
    store: CloudWorkspaceStore,
    token: Uuid,
    project_id: String,
    storyboard_id: String,
) -> ToolRegistry {
    let mut registry = crate::runtime::default_registry();
    let scope = Scope {
        store,
        token,
        project_id,
        storyboard_id,
    };
    for kind in 0..NAMES.len() {
        registry.register(Arc::new(CloudTool {
            kind,
            scope: scope.clone(),
        }));
    }
    registry
}

pub fn scope_context(snapshot: &Value, project_id: &str, storyboard_id: &str) -> Result<String> {
    let workspace = workspace(snapshot, project_id, storyboard_id)?;
    let resources = resources(snapshot, project_id, storyboard_id)?;
    let folders = flatten_tree(workspace.get("navigationTree").unwrap_or(&Value::Null))
        .into_iter()
        .filter(|node| node.get("kind").and_then(Value::as_str) == Some("folder"))
        .map(|node| json!({"id": node.get("id"), "name": node.get("name")}))
        .collect::<Vec<_>>();
    let summary = json!({
        "projectId": project_id,
        "storyboardId": storyboard_id,
        "storyboardName": workspace.pointer("/storyboard/name"),
        "folders": folders,
        "resources": resources.iter().map(|item| json!({"id":item.id,"kind":item.kind,"name":item.name,"revision":item.revision})).collect::<Vec<_>>(),
    });
    Ok(serde_json::to_string(&summary)?)
}

#[derive(Clone)]
struct Resource {
    id: String,
    kind: String,
    name: String,
    role: Option<String>,
    content: Option<String>,
    status: Option<String>,
    revision: i64,
    editable: bool,
}

impl Resource {
    fn matches_id(&self, id: &str) -> bool {
        self.id == id
            || (self.role.as_deref() == Some("script")
                && self.id.strip_prefix("script-") == Some(id))
    }

    fn full(&self) -> Value {
        json!({"id":self.id,"kind":self.kind,"name":self.name,"role":self.role,
            "content":self.content,"status":self.status,"revision":self.revision,
            "editable":self.editable,"generationInput":null})
    }
    fn brief(&self) -> Value {
        json!({"id":self.id,"kind":self.kind,"name":self.name,"role":self.role,
            "status":self.status,"revision":self.revision,"editable":self.editable})
    }
}

fn workspace<'a>(snapshot: &'a Value, project_id: &str, storyboard_id: &str) -> Result<&'a Value> {
    if snapshot.pointer("/project/id").and_then(Value::as_str) != Some(project_id) {
        bail!("project not found");
    }
    snapshot
        .get("workspaces")
        .and_then(|value| value.get(storyboard_id))
        .context("storyboard not found")
}

fn flatten_tree(value: &Value) -> Vec<&Value> {
    let mut result = Vec::new();
    let mut stack = value
        .as_array()
        .map_or_else(Vec::new, |items| items.iter().collect::<Vec<_>>());
    while let Some(node) = stack.pop() {
        result.push(node);
        if let Some(children) = node.get("children").and_then(Value::as_array) {
            stack.extend(children.iter());
        }
    }
    result
}

fn resources(snapshot: &Value, project_id: &str, storyboard_id: &str) -> Result<Vec<Resource>> {
    let ws = workspace(snapshot, project_id, storyboard_id)?;
    let script_id = format!("script-{storyboard_id}");
    let script = ws
        .pointer("/storyboard/script")
        .context("script not found")?;
    let mut result = vec![Resource {
        id: script_id.clone(),
        kind: "text".into(),
        name: "片段脚本".into(),
        role: Some("script".into()),
        content: script
            .get("text")
            .and_then(Value::as_str)
            .map(str::to_owned),
        status: None,
        revision: script.get("revision").and_then(Value::as_i64).unwrap_or(1),
        editable: true,
    }];
    let nodes = flatten_tree(ws.get("navigationTree").unwrap_or(&Value::Null));
    for node in nodes {
        if node.get("kind").and_then(Value::as_str) != Some("object") {
            continue;
        }
        let Some(kind) = node.get("objectType").and_then(Value::as_str) else {
            continue;
        };
        if kind == "text"
            && (node.pointer("/selection/kind").and_then(Value::as_str) == Some("script")
                || node.get("id").and_then(Value::as_str) == Some(script_id.as_str()))
        {
            continue;
        }
        let Some(object_id) = node.get("id").and_then(Value::as_str) else {
            continue;
        };
        if kind == "text" {
            result.push(Resource {
                id: object_id.to_owned(),
                kind: "text".into(),
                name: node
                    .get("name")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_owned(),
                role: Some("emptyObject".into()),
                content: None,
                status: None,
                revision: node.get("revision").and_then(Value::as_i64).unwrap_or(1),
                editable: false,
            });
            continue;
        }
        let Some(media) = snapshot
            .get("objectMedia")
            .and_then(|map| map.get(object_id))
        else {
            // Bound asset navigation nodes are listed from assetGroups below.
            // A tree node alone has no writable media resource.
            continue;
        };
        result.push(Resource {
            id: media
                .get("id")
                .and_then(Value::as_str)
                .unwrap_or(object_id)
                .to_owned(),
            kind: kind.to_owned(),
            name: node
                .get("name")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_owned(),
            role: media.get("role").and_then(Value::as_str).map(str::to_owned),
            content: media
                .get("prompt")
                .and_then(Value::as_str)
                .map(str::to_owned),
            status: media
                .get("status")
                .and_then(Value::as_str)
                .map(str::to_owned),
            revision: media.get("revision").and_then(Value::as_i64).unwrap_or(1),
            editable: true,
        });
    }
    for group in ["assetGroups", "videoGroups"] {
        for item in ws
            .get(group)
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .flat_map(|group| {
                group
                    .get("items")
                    .and_then(Value::as_array)
                    .into_iter()
                    .flatten()
            })
        {
            let Some(media) = item.get("media") else {
                continue;
            };
            let Some(media_id) = media.get("id").and_then(Value::as_str) else {
                continue;
            };
            let kind = media.get("kind").and_then(Value::as_str).unwrap_or("image");
            if !result
                .iter()
                .any(|entry| entry.id == media_id && entry.kind == kind)
            {
                result.push(Resource {
                    id: media_id.to_owned(),
                    kind: kind.into(),
                    name: media
                        .get("name")
                        .and_then(Value::as_str)
                        .unwrap_or("")
                        .into(),
                    role: media.get("role").and_then(Value::as_str).map(str::to_owned),
                    content: media
                        .get("prompt")
                        .and_then(Value::as_str)
                        .map(str::to_owned),
                    status: media
                        .get("status")
                        .and_then(Value::as_str)
                        .map(str::to_owned),
                    revision: media.get("revision").and_then(Value::as_i64).unwrap_or(1),
                    editable: false,
                });
            }
            if let Some(binding_id) = item.get("id").and_then(Value::as_str) {
                result.push(Resource {
                    id: binding_id.to_owned(),
                    kind: "assetBinding".into(),
                    name: media
                        .get("name")
                        .and_then(Value::as_str)
                        .unwrap_or("")
                        .into(),
                    role: Some(kind.into()),
                    content: media
                        .get("prompt")
                        .and_then(Value::as_str)
                        .map(str::to_owned),
                    status: media
                        .get("status")
                        .and_then(Value::as_str)
                        .map(str::to_owned),
                    revision: media.get("revision").and_then(Value::as_i64).unwrap_or(1),
                    editable: true,
                });
            }
        }
    }
    Ok(result)
}

fn string<'a>(value: &'a Value, field: &str) -> Result<&'a str> {
    value
        .get(field)
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| anyhow!("{field} is required"))
}

fn revision(value: &Value) -> Result<i64> {
    value
        .get("baseRevision")
        .and_then(Value::as_i64)
        .filter(|value| *value > 0)
        .context("baseRevision must be positive")
}

fn output(call: Uuid, payload: Value) -> Result<ToolResult> {
    Ok(ToolResult::text(
        call,
        serde_json::to_string(&payload)?,
        payload,
    ))
}

fn referenced_prompt(
    snapshot: &Value,
    project_id: &str,
    storyboard_id: &str,
    prompt: &str,
    input: &Value,
    generation_media_ids: &[String],
) -> Result<ReferencedPrompt> {
    let reference_ids = input
        .get("referenceIds")
        .map(|value| {
            value
                .as_array()
                .context("referenceIds must be an array")?
                .iter()
                .map(|item| {
                    item.as_str()
                        .map(str::to_owned)
                        .context("referenceIds must contain strings")
                })
                .collect::<Result<Vec<_>>>()
        })
        .transpose()?
        .unwrap_or_default();
    let sources = resources(snapshot, project_id, storyboard_id)?
        .into_iter()
        .map(|item| PromptReferenceSource {
            is_script: item.role.as_deref() == Some("script"),
            id: item.id,
            kind: item.kind,
            name: item.name,
        })
        .collect::<Vec<_>>();
    compose_referenced_prompt(prompt, &reference_ids, generation_media_ids, &sources)
        .map_err(|message| anyhow!(message))
}

#[async_trait]
impl Tool for CloudTool {
    fn name(&self) -> &str {
        NAMES[self.kind]
    }
    fn description(&self) -> &str {
        match self.kind {
            0 => "Create an image or video object with a saved prompt in the current storyboard folder. Pass stable asset IDs in referenceIds so @mentions display as asset references. This does not start generation.",
            1 => "Save a prompt directly in an existing storyboard-owned image or video object without generation. Search or read first for ID, revision, and referenced asset IDs; pass asset IDs in referenceIds.",
            2 => "Search the current storyboard script, bound assets, images and videos by name or content. For prompt referenceIds use image/video IDs; assetBinding IDs are prompt targets. Returns stable IDs and revisions; supports pagination.",
            3 => "Read a storyboard resource by kind and ID returned by search_storyboard_assets.",
            4 => "Propose one exact-context replacement in the current script for user confirmation.",
            5 => "Propose an image prompt for user confirmation. Image IDs in input become visible asset references; pass additional @mentioned IDs in referenceIds. Use save_workspace_object_prompt when only saving prompt text.",
            _ => "Propose a video prompt for user confirmation. Image IDs in input become visible asset references; pass additional @mentioned IDs in referenceIds. Use save_workspace_object_prompt when only saving prompt text.",
        }
    }
    fn schema(&self) -> Value {
        match self.kind {
            0 => {
                json!({"type":"object","properties":{"parentId":{"type":["string","null"]},"name":{"type":"string"},"objectType":{"type":"string","enum":["image","video"]},"prompt":{"type":"string"},"referenceIds":{"type":"array","items":{"type":"string"},"uniqueItems":true}},"required":["parentId","name","objectType","prompt"],"additionalProperties":false})
            }
            1 => {
                json!({"type":"object","properties":{"targetId":{"type":"string"},"baseRevision":{"type":"integer","minimum":1},"prompt":{"type":"string"},"referenceIds":{"type":"array","items":{"type":"string"},"uniqueItems":true}},"required":["targetId","baseRevision","prompt"],"additionalProperties":false})
            }
            2 => {
                json!({"type":"object","properties":{"query":{"type":"string"},"kind":{"type":"string","enum":["text","assetBinding","image","video"]},"offset":{"type":"integer","minimum":0},"limit":{"type":"integer","minimum":1,"maximum":100}},"additionalProperties":false})
            }
            3 => {
                json!({"type":"object","properties":{"kind":{"type":"string","enum":["text","assetBinding","image","video"]},"id":{"type":"string"}},"required":["kind","id"],"additionalProperties":false})
            }
            4 => {
                json!({"type":"object","properties":{"targetId":{"type":"string"},"baseRevision":{"type":"integer","minimum":1},"oldText":{"type":"string"},"newText":{"type":"string"},"summary":{"type":"string"}},"required":["targetId","baseRevision","oldText","newText","summary"],"additionalProperties":false})
            }
            5 => {
                json!({"type":"object","properties":{"targetType":{"type":"string","enum":["media","assetBinding"]},"targetId":{"type":"string"},"baseRevision":{"type":"integer","minimum":1},"proposedPrompt":{"type":"string"},"referenceIds":{"type":"array","items":{"type":"string"},"uniqueItems":true},"input":{"type":"object"},"summary":{"type":"string"}},"required":["targetType","targetId","baseRevision","proposedPrompt","input","summary"],"additionalProperties":false})
            }
            _ => {
                json!({"type":"object","properties":{"targetId":{"type":"string"},"baseRevision":{"type":"integer","minimum":1},"proposedPrompt":{"type":"string"},"referenceIds":{"type":"array","items":{"type":"string"},"uniqueItems":true},"input":{"type":"object"},"summary":{"type":"string"}},"required":["targetId","baseRevision","proposedPrompt","input","summary"],"additionalProperties":false})
            }
        }
    }
    fn execution_policy(&self, _: &ToolCall) -> ToolExecutionPolicy {
        let read_only = self.kind == 2 || self.kind == 3;
        ToolExecutionPolicy {
            read_only,
            idempotent: read_only,
            parallel_safe: read_only,
            side_effect: if read_only {
                ToolSideEffect::None
            } else {
                ToolSideEffect::SessionMutation
            },
            resource_keys: if read_only {
                Vec::new()
            } else {
                vec!["videoflow:cloud-workspace".into()]
            },
        }
    }
    async fn execute(&self, call: ToolCall, ctx: ToolInvocationContext) -> Result<ToolResult> {
        let scope = &self.scope;
        let input = &call.input;
        let payload = match self.kind {
            2 | 3 => {
                let doc = scope
                    .store
                    .get(scope.token)
                    .await?
                    .context("workspace not found")?
                    .document;
                let items = resources(&doc.snapshot, &scope.project_id, &scope.storyboard_id)?;
                if self.kind == 2 {
                    let query = input
                        .get("query")
                        .and_then(Value::as_str)
                        .unwrap_or("")
                        .to_lowercase();
                    let kind = input.get("kind").and_then(Value::as_str);
                    let matches = items
                        .into_iter()
                        .filter(|item| kind.is_none_or(|kind| item.kind == kind))
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
                    let offset = input.get("offset").and_then(Value::as_u64).unwrap_or(0) as usize;
                    let limit = input
                        .get("limit")
                        .and_then(Value::as_u64)
                        .unwrap_or(50)
                        .min(100) as usize;
                    json!({"total":matches.len(),"offset":offset,
                        "items":matches.into_iter().skip(offset).take(limit).map(|item|item.brief()).collect::<Vec<_>>()})
                } else {
                    items
                        .into_iter()
                        .find(|item| {
                            item.matches_id(string(input, "id").unwrap_or(""))
                                && item.kind == string(input, "kind").unwrap_or("")
                        })
                        .context("resource not found")?
                        .full()
                }
            }
            0 => {
                scope
                    .store
                    .mutate(scope.token, |doc| {
                        create_object(doc, &scope.project_id, &scope.storyboard_id, input)
                    })
                    .await?
            }
            1 => {
                scope
                    .store
                    .mutate(scope.token, |doc| {
                        save_prompt(doc, &scope.project_id, &scope.storyboard_id, input)
                    })
                    .await?
            }
            _ => {
                let thread_id = ctx.thread_id.context("thread is required")?;
                let turn_id = ctx.agent_turn_id.context("turn is required")?;
                scope
                    .store
                    .mutate(scope.token, |doc| {
                        propose(doc, scope, self.kind, input, thread_id, turn_id, call.id)
                    })
                    .await?
            }
        };
        output(call.id, payload)
    }
}

fn create_object(
    doc: &mut CloudDocument,
    project_id: &str,
    storyboard_id: &str,
    input: &Value,
) -> Result<Value> {
    let name = string(input, "name")?;
    let prompt = string(input, "prompt")?;
    let object_type = string(input, "objectType")?;
    if !["image", "video"].contains(&object_type)
        || name.chars().count() > 120
        || prompt.chars().count() > 10_000
    {
        bail!("invalid object input");
    }
    let parent = input.get("parentId").and_then(Value::as_str);
    let ws = workspace(&doc.snapshot, project_id, storyboard_id)?;
    let prompt = referenced_prompt(&doc.snapshot, project_id, storyboard_id, prompt, input, &[])?;
    if let Some(parent_id) = parent {
        if !flatten_tree(ws.get("navigationTree").unwrap_or(&Value::Null))
            .iter()
            .any(|node| {
                node.get("kind").and_then(Value::as_str) == Some("folder")
                    && node.get("id").and_then(Value::as_str) == Some(parent_id)
            })
        {
            bail!("folder not found");
        }
    }
    let id = Uuid::new_v4().to_string();
    let now = Utc::now().to_rfc3339();
    let node = json!({"kind":"object","id":id,"name":name,"objectType":object_type,
        "mediaId":id,"unseenUpdateAt":null,
        "selection":{"kind":"emptyObject","objectId":id,"objectType":object_type}});
    let tree = doc.snapshot["workspaces"][storyboard_id]["navigationTree"]
        .as_array_mut()
        .context("invalid navigation tree")?;
    if let Some(parent_id) = parent {
        if !append_to_folder(tree, parent_id, node) {
            bail!("folder not found");
        }
    } else {
        tree.push(node);
    }
    doc.snapshot["objectMedia"][&id] = json!({
        "id":id,"projectId":project_id,"owner":{"type":"storyboard","storyboardId":storyboard_id},
        "kind":object_type,"role":"custom","name":name,"prompt":prompt.value,
        "mimeType":if object_type == "video" {"video/mp4"} else {"image/png"},
        "width":null,"height":null,"durationMs":null,"status":"placeholder","revision":1,
        "thumbnail":null,"preview":null,"generation":null,"createdAt":now,"updatedAt":now,
    });
    Ok(
        json!({"objectId":id,"mediaId":id,"parentId":parent,"name":name,"objectType":object_type,
        "mediaStatus":"placeholder","generationRequested":false,"referenceIds":prompt.reference_ids,
        "message":"对象和提示词已创建，未发送生成。"}),
    )
}

fn append_to_folder(nodes: &mut Vec<Value>, id: &str, node: Value) -> bool {
    for item in nodes {
        if item.get("id").and_then(Value::as_str) == Some(id)
            && item.get("kind").and_then(Value::as_str) == Some("folder")
        {
            if let Some(children) = item.get_mut("children").and_then(Value::as_array_mut) {
                children.push(node);
                return true;
            }
        }
        if let Some(children) = item.get_mut("children").and_then(Value::as_array_mut) {
            if append_to_folder(children, id, node.clone()) {
                return true;
            }
        }
    }
    false
}

fn save_prompt(
    doc: &mut CloudDocument,
    project_id: &str,
    storyboard_id: &str,
    input: &Value,
) -> Result<Value> {
    let target_id = string(input, "targetId")?;
    let base = revision(input)?;
    let prompt = string(input, "prompt")?;
    if prompt.chars().count() > 10_000 {
        bail!("prompt is too long");
    }
    let resource = resources(&doc.snapshot, project_id, storyboard_id)?
        .into_iter()
        .find(|item| {
            item.id == target_id
                && item.editable
                && ["image", "video"].contains(&item.kind.as_str())
        })
        .context("editable media not found")?;
    if resource.revision != base {
        bail!("media revision changed");
    }
    let prompt = referenced_prompt(&doc.snapshot, project_id, storyboard_id, prompt, input, &[])?;
    let (object_id, media) = doc
        .snapshot
        .get_mut("objectMedia")
        .and_then(Value::as_object_mut)
        .context("media map missing")?
        .iter_mut()
        .find(|(_, media)| media.get("id").and_then(Value::as_str) == Some(target_id))
        .context("media not found")?;
    media["prompt"] = json!(prompt.value);
    media["revision"] = json!(base + 1);
    media["updatedAt"] = json!(Utc::now().to_rfc3339());
    Ok(
        json!({"objectId":object_id,"mediaId":target_id,"objectType":resource.kind,
        "revision":base+1,"generationRequested":false,"referenceIds":prompt.reference_ids,
        "message":"提示词已写入对象输入框，未发送生成。"}),
    )
}

fn propose(
    doc: &mut CloudDocument,
    scope: &Scope,
    kind: usize,
    input: &Value,
    thread_id: Uuid,
    turn_id: Uuid,
    call_id: Uuid,
) -> Result<Value> {
    let target_id = string(input, "targetId")?;
    let base = revision(input)?;
    let resource = resources(&doc.snapshot, &scope.project_id, &scope.storyboard_id)?
        .into_iter()
        .find(|item| item.matches_id(target_id))
        .context("resource not found")?;
    if !resource.editable || resource.revision != base {
        bail!("resource revision changed or is read only");
    }
    let (target, proposed, proposed_input) = if kind == 4 {
        if resource.kind != "text" {
            bail!("script target required");
        }
        let old = string(input, "oldText")?;
        let current = resource.content.as_deref().context("script empty")?;
        if current.matches(old).count() != 1 {
            bail!("oldText must match exactly once");
        }
        let new_text = input
            .get("newText")
            .and_then(Value::as_str)
            .context("newText is required")?;
        (
            json!({"type":"script","storyboardId":scope.storyboard_id}),
            current.replacen(old, new_text, 1),
            Value::Null,
        )
    } else {
        let target_type = input
            .get("targetType")
            .and_then(Value::as_str)
            .unwrap_or("media");
        if kind == 5
            && !((target_type == "media" && resource.kind == "image")
                || (target_type == "assetBinding"
                    && resource.kind == "assetBinding"
                    && resource.role.as_deref() == Some("image")))
        {
            bail!("image target mismatch");
        }
        if kind == 6 && (resource.kind != "video" || input.get("targetType").is_some()) {
            bail!("video target mismatch");
        }
        let target = if target_type == "assetBinding" {
            json!({"type":"assetBindingPrompt","bindingId":target_id})
        } else {
            json!({"type":"mediaPrompt","mediaId":target_id})
        };
        let proposed = string(input, "proposedPrompt")?.to_owned();
        if proposed.chars().count() > 10_000 {
            bail!("prompt is too long");
        }
        let generation_input = input
            .get("input")
            .cloned()
            .context("generation input required")?;
        let _: crate::product::domain::GenerationInputSelection =
            serde_json::from_value(generation_input.clone()).context("invalid generation input")?;
        if kind == 5
            && generation_input.get("type").and_then(Value::as_str) == Some("firstLastFrames")
        {
            bail!("image prompts cannot use first/last frames");
        }
        let media_ids = match generation_input.get("type").and_then(Value::as_str) {
            Some("referenceImages") => generation_input
                .get("mediaIds")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .filter_map(Value::as_str)
                .map(str::to_owned)
                .collect::<Vec<_>>(),
            Some("firstLastFrames") => ["firstFrameMediaId", "lastFrameMediaId"]
                .into_iter()
                .filter_map(|key| generation_input.get(key).and_then(Value::as_str))
                .map(str::to_owned)
                .collect::<Vec<_>>(),
            _ => Vec::new(),
        };
        let proposed = referenced_prompt(
            &doc.snapshot,
            &scope.project_id,
            &scope.storyboard_id,
            &proposed,
            input,
            &media_ids,
        )?
        .value;
        (target, proposed, generation_input)
    };
    let summary = string(input, "summary")?;
    if summary.chars().count() > 300 {
        bail!("summary too long");
    }
    let id = Uuid::new_v4().to_string();
    let proposal = json!({"id":id,"projectId":scope.project_id,"storyboardId":scope.storyboard_id,
        "target":target,"baseRevision":base,"beforeValue":resource.content.unwrap_or_default(),
        "proposedValue":proposed,"proposedInput":proposed_input,"summary":summary,"status":"pending",
        "source":{"threadId":thread_id,"turnId":turn_id,"toolCallId":call_id.to_string()},
        "revision":1,"createdAt":Utc::now().to_rfc3339(),"resolvedAt":null});
    doc.proposals.push(proposal);
    Ok(
        json!({"proposalId":id,"status":"pending","targetType":target.get("type"),
        "targetId":target_id,"baseRevision":base,"proposedInput":proposed_input,"summary":summary,
        "message":"修改已提交，等待用户确认。"}),
    )
}

pub fn apply_proposed_value(
    snapshot: &mut Value,
    storyboard_id: &str,
    target: &Value,
    expected_revision: i64,
    proposed: &str,
) -> Result<Value> {
    match target.get("type").and_then(Value::as_str) {
        Some("script") => {
            let script = &mut snapshot["workspaces"][storyboard_id]["storyboard"]["script"];
            if script.get("revision").and_then(Value::as_i64) != Some(expected_revision) {
                bail!("target changed");
            }
            script["text"] = json!(proposed);
            script["revision"] = json!(expected_revision + 1);
            script["updatedAt"] = json!(Utc::now().to_rfc3339());
            Ok(json!({"type":"script","revision":expected_revision+1}))
        }
        Some("mediaPrompt") => {
            let id = target
                .get("mediaId")
                .and_then(Value::as_str)
                .context("media id missing")?;
            let (_, media) = snapshot
                .get_mut("objectMedia")
                .and_then(Value::as_object_mut)
                .context("media map missing")?
                .iter_mut()
                .find(|(_, media)| media.get("id").and_then(Value::as_str) == Some(id))
                .context("media not found")?;
            if media.get("revision").and_then(Value::as_i64) != Some(expected_revision) {
                bail!("target changed");
            }
            media["prompt"] = json!(proposed);
            media["revision"] = json!(expected_revision + 1);
            media["updatedAt"] = json!(Utc::now().to_rfc3339());
            Ok(json!({"type":"mediaPrompt","revision":expected_revision+1}))
        }
        Some("assetBindingPrompt") => {
            let id = target
                .get("bindingId")
                .and_then(Value::as_str)
                .context("binding id missing")?;
            let ws = &mut snapshot["workspaces"][storyboard_id];
            for group_name in ["assetGroups", "videoGroups"] {
                if let Some(groups) = ws.get_mut(group_name).and_then(Value::as_array_mut) {
                    for group in groups {
                        if let Some(items) = group.get_mut("items").and_then(Value::as_array_mut) {
                            if let Some(item) = items
                                .iter_mut()
                                .find(|item| item.get("id").and_then(Value::as_str) == Some(id))
                            {
                                let media = &mut item["media"];
                                if media.get("revision").and_then(Value::as_i64)
                                    != Some(expected_revision)
                                {
                                    bail!("target changed");
                                }
                                media["prompt"] = json!(proposed);
                                media["revision"] = json!(expected_revision + 1);
                                media["updatedAt"] = json!(Utc::now().to_rfc3339());
                                return Ok(
                                    json!({"type":"assetBindingPrompt","revision":expected_revision+1}),
                                );
                            }
                        }
                    }
                }
            }
            bail!("binding not found")
        }
        _ => bail!("unsupported proposal target"),
    }
}

pub fn apply_generation_state(
    snapshot: &mut Value,
    storyboard_id: &str,
    target: &Value,
    job: &Value,
) -> Result<()> {
    if job.is_null() {
        return Ok(());
    }
    match target.get("type").and_then(Value::as_str) {
        Some("mediaPrompt") => {
            let id = target
                .get("mediaId")
                .and_then(Value::as_str)
                .context("media id missing")?;
            let media = snapshot
                .get_mut("objectMedia")
                .and_then(Value::as_object_mut)
                .context("media map missing")?
                .values_mut()
                .find(|media| media.get("id").and_then(Value::as_str) == Some(id))
                .context("media not found")?;
            set_generation_fields(media, job);
            Ok(())
        }
        Some("assetBindingPrompt") => {
            let id = target
                .get("bindingId")
                .and_then(Value::as_str)
                .context("binding id missing")?;
            let ws = &mut snapshot["workspaces"][storyboard_id];
            for key in ["assetGroups", "videoGroups"] {
                if let Some(groups) = ws.get_mut(key).and_then(Value::as_array_mut) {
                    for group in groups {
                        if let Some(items) = group.get_mut("items").and_then(Value::as_array_mut) {
                            if let Some(item) = items
                                .iter_mut()
                                .find(|item| item.get("id").and_then(Value::as_str) == Some(id))
                            {
                                let media =
                                    item.get_mut("media").context("binding media not found")?;
                                set_generation_fields(media, job);
                                return Ok(());
                            }
                        }
                    }
                }
            }
            bail!("binding media not found")
        }
        _ => Ok(()),
    }
}

fn set_generation_fields(media: &mut Value, job: &Value) {
    let status = job
        .get("status")
        .and_then(Value::as_str)
        .unwrap_or("queued");
    media["status"] = json!(match status {
        "succeeded" => "ready",
        "failed" | "cancelled" => "failed",
        _ => "processing",
    });
    media["generation"] = json!({"jobId":job.get("id"),"provider":job.get("provider"),
        "model":job.pointer("/spec/model"),"error":job.get("error")});
    if let Some(result) = job.get("result").filter(|value| !value.is_null()) {
        media["preview"] = json!({"url":result.get("url"),"expiresAt":result.get("expiresAt"),
            "width":result.get("width"),"height":result.get("height"),"mimeType":result.get("mimeType")});
        if media.get("kind").and_then(Value::as_str) == Some("image") {
            media["thumbnail"] = json!({"url":result.get("url"),"expiresAt":result.get("expiresAt"),
                "width":result.get("width"),"height":result.get("height")});
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn snapshot() -> Value {
        json!({
            "project":{"id":"p"}, "storyboards":[],
            "workspaces":{"s":{"storyboard":{"name":"Demo","script":{"text":"one sheep","revision":2,"updatedAt":"old"}},
                "navigationTree":[{"kind":"folder","id":"f","name":"Videos","children":[]}],
                "assetGroups":[],"videoGroups":[]}},
            "objectMedia":{}
        })
    }

    #[test]
    fn scoped_resources_include_script_and_created_media() {
        let mut document = CloudDocument {
            snapshot: snapshot(),
            proposals: vec![],
        };
        let created = create_object(
            &mut document,
            "p",
            "s",
            &json!({"parentId":"f","name":"Clip","objectType":"video","prompt":"sheep jumping"}),
        )
        .unwrap();
        let found = resources(&document.snapshot, "p", "s").unwrap();
        assert_eq!(found.len(), 2);
        assert_eq!(found[0].id, "script-s");
        assert!(found[0].matches_id("s"));
        assert!(found[0].matches_id("script-s"));
        assert_eq!(found[1].id, created["mediaId"]);
        assert_eq!(found[1].content.as_deref(), Some("sheep jumping"));
        assert!(resources(&document.snapshot, "other", "s").is_err());
    }

    #[test]
    fn scoped_resources_include_empty_text_nodes_without_duplicating_the_script() {
        let mut current = snapshot();
        current["workspaces"]["s"]["navigationTree"][0]["children"] = json!([
            {"kind":"object","id":"script-s","name":"该片段的脚本","objectType":"text",
             "selection":{"kind":"script","storyboardId":"s"}},
            {"kind":"object","id":"notes","name":"空白备注","objectType":"text",
             "revision":3,"selection":{"kind":"node","nodeId":"notes"}}
        ]);
        let found = resources(&current, "p", "s").unwrap();
        assert_eq!(found.len(), 2);
        assert_eq!(found[0].id, "script-s");
        assert_eq!(found[1].id, "notes");
        assert_eq!(found[1].role.as_deref(), Some("emptyObject"));
        assert_eq!(found[1].revision, 3);
        assert!(!found[1].editable);
    }

    #[test]
    fn bound_asset_navigation_node_does_not_create_a_fake_writable_media_resource() {
        let mut current = snapshot();
        current["workspaces"]["s"]["navigationTree"][0]["children"] = json!([
            {"kind":"object","id":"asset-node","name":"牧场","objectType":"image",
             "selection":{"kind":"item","itemId":"binding"}}
        ]);
        current["workspaces"]["s"]["assetGroups"] = json!([{
            "items":[{
                "id":"binding",
                "media":{"id":"image-1","kind":"image","name":"牧场","prompt":"晨光",
                         "status":"ready","revision":1}
            }]
        }]);
        let found = resources(&current, "p", "s").unwrap();
        assert_eq!(found.len(), 3);
        assert!(found
            .iter()
            .any(|item| item.id == "image-1" && !item.editable));
        assert!(found
            .iter()
            .any(|item| item.id == "binding" && item.editable));
        assert!(!found.iter().any(|item| item.id == "asset-node"));
    }

    #[test]
    fn saves_prompt_into_null_cloud_placeholder_without_generation() {
        let mut document = CloudDocument {
            snapshot: snapshot(),
            proposals: vec![],
        };
        document.snapshot["workspaces"]["s"]["navigationTree"][0]["children"] = json!([
            {"kind":"object","id":"clip","name":"待写提示词","objectType":"video"}
        ]);
        document.snapshot["objectMedia"]["clip"] = json!({
            "id":"clip","kind":"video","role":"custom","name":"待写提示词",
            "prompt":null,"status":"placeholder","revision":1
        });

        let saved = save_prompt(
            &mut document,
            "p",
            "s",
            &json!({"targetId":"clip","baseRevision":1,"prompt":"牧羊犬数羊"}),
        )
        .unwrap();
        assert_eq!(saved["revision"], 2);
        assert_eq!(saved["generationRequested"], false);
        assert_eq!(
            document.snapshot["objectMedia"]["clip"]["prompt"],
            "牧羊犬数羊"
        );
        assert_eq!(document.snapshot["objectMedia"]["clip"]["revision"], 2);
        assert!(document.proposals.is_empty());
    }

    #[test]
    fn cloud_tool_prompts_resolve_current_storyboard_references() {
        let mut document = CloudDocument {
            snapshot: snapshot(),
            proposals: vec![],
        };
        let image = create_object(
            &mut document,
            "p",
            "s",
            &json!({
                "parentId":null,"name":"牧羊犬","objectType":"image","prompt":"角色设定"
            }),
        )
        .unwrap();
        let image_id = image["mediaId"].as_str().unwrap().to_owned();
        let script_reference = referenced_prompt(
            &document.snapshot,
            "p",
            "s",
            "依据 @片段脚本 生成",
            &json!({"referenceIds":["script-s"]}),
            &[],
        )
        .unwrap();
        assert_eq!(script_reference.reference_ids, vec!["script-s"]);
        assert!(script_reference
            .value
            .ends_with("- 文本「片段脚本」(script-s)"));
        let legacy_script_reference = referenced_prompt(
            &document.snapshot,
            "p",
            "s",
            &script_reference.value,
            &json!({"referenceIds":["s"]}),
            &[],
        )
        .unwrap();
        assert_eq!(legacy_script_reference.value, script_reference.value);
        let video = create_object(
            &mut document,
            "p",
            "s",
            &json!({
                "parentId":null,"name":"镜头","objectType":"video",
                "prompt":"参考 @牧羊犬 拍摄","referenceIds":[image_id]
            }),
        )
        .unwrap();
        let video_id = video["mediaId"].as_str().unwrap();
        let expected_footer = format!("- 图片「牧羊犬」({image_id})");
        assert!(document.snapshot["objectMedia"][video_id]["prompt"]
            .as_str()
            .unwrap()
            .ends_with(&expected_footer));
        let saved = save_prompt(
            &mut document,
            "p",
            "s",
            &json!({
                "targetId":video_id,"baseRevision":1,"prompt":"缓慢推进",
                "referenceIds":[image_id]
            }),
        )
        .unwrap();
        assert_eq!(saved["referenceIds"], json!([image_id]));
        assert!(document.snapshot["objectMedia"][video_id]["prompt"]
            .as_str()
            .unwrap()
            .contains("缓慢推进 @牧羊犬\n\n引用资产："));
        assert!(save_prompt(
            &mut document,
            "p",
            "s",
            &json!({
                "targetId":video_id,"baseRevision":2,"prompt":"越界","referenceIds":["other"]
            })
        )
        .is_err());
    }

    #[test]
    fn proposal_apply_checks_target_revision() {
        let mut current = snapshot();
        let target = json!({"type":"script","storyboardId":"s"});
        assert!(apply_proposed_value(&mut current, "s", &target, 1, "two sheep").is_err());
        let response = apply_proposed_value(&mut current, "s", &target, 2, "two sheep").unwrap();
        assert_eq!(response, json!({"type":"script","revision":3}));
        assert_eq!(
            current["workspaces"]["s"]["storyboard"]["script"]["text"],
            "two sheep"
        );
    }
}
