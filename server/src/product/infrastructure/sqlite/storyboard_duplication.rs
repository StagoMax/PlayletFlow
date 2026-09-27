use super::storyboard_order::allocate_after;
use super::storyboard_storage::{insert_script, insert_storyboard, load_script, load_storyboard};
use super::support::{append_event, immediate, remember, replay};
use crate::product::application::storyboards::IdempotencyContext;
use crate::product::domain::{
    ProductError, ProductResult, Storyboard, StoryboardId, StoryboardScript,
};
use chrono::Utc;
use rusqlite::{params, Connection};
use serde_json::json;
use std::collections::HashMap;
use uuid::Uuid;

pub(super) fn duplicate_storyboard(
    connection: &mut Connection,
    source_id: StoryboardId,
    mut copy: Storyboard,
    idempotency: IdempotencyContext,
) -> ProductResult<Storyboard> {
    let transaction = immediate(connection)?;
    if let Some(saved) = replay::<Storyboard>(&transaction, &idempotency)? {
        transaction.commit()?;
        return Ok(saved);
    }
    load_storyboard(&transaction, copy.project_id, source_id, false)?
        .ok_or(ProductError::NotFound)?;
    let source_script = load_script(&transaction, source_id)?.ok_or(ProductError::NotFound)?;
    copy.position = allocate_after(&transaction, copy.project_id, Some(source_id), None)?;
    insert_storyboard(&transaction, &copy)?;
    insert_script(
        &transaction,
        &StoryboardScript {
            storyboard_id: copy.id,
            text: source_script.text,
            revision: 1,
            updated_at: copy.created_at,
        },
    )?;
    let now = Utc::now().to_rfc3339();
    let source = source_id.to_string();
    let target = copy.id.to_string();
    let project = copy.project_id.to_string();

    // Media records get new IDs while their immutable stored objects can be shared.
    let mut media_map = HashMap::new();
    let media = {
        let mut statement = transaction.prepare(
            "SELECT id, kind, role, name, prompt, mime_type, source_object_key,
                    thumbnail_object_key, width, height, duration_ms, status
             FROM media_items WHERE storyboard_id = ?1 AND deleted_at IS NULL ORDER BY created_at, id",
        )?;
        let rows = statement
            .query_map([&source], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, Option<String>>(4)?,
                    row.get::<_, String>(5)?,
                    row.get::<_, Option<String>>(6)?,
                    row.get::<_, Option<String>>(7)?,
                    row.get::<_, Option<i64>>(8)?,
                    row.get::<_, Option<i64>>(9)?,
                    row.get::<_, Option<i64>>(10)?,
                    row.get::<_, String>(11)?,
                ))
            })?
            .collect::<Result<Vec<_>, _>>()?;
        rows
    };
    for (id, ..) in &media {
        media_map.insert(id.clone(), Uuid::new_v4().to_string());
    }
    for (id, kind, role, name, prompt, mime, object, thumbnail, width, height, duration, status) in
        media
    {
        let new_id = media_map[&id].clone();
        let prompt =
            prompt.map(|value| remap_prompt_references(&value, &media_map, &source, &target));
        let (status, object, thumbnail) = if status == "processing" {
            ("placeholder".to_owned(), None, None)
        } else {
            (status, object, thumbnail)
        };
        transaction.execute(
            "INSERT INTO media_items
             (id, project_id, storyboard_id, kind, role, name, prompt, mime_type,
              source_object_key, thumbnail_object_key, width, height, duration_ms, status,
              revision, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, 1, ?15, ?15)",
            params![
                new_id, project, target, kind, role, name, prompt, mime, object, thumbnail, width,
                height, duration, status, now
            ],
        )?;
    }

    let sections = {
        let mut statement = transaction.prepare(
            "SELECT id, parent_id, name, kind, position FROM asset_sections
             WHERE storyboard_id = ?1 ORDER BY (parent_id IS NOT NULL), position, id",
        )?;
        let rows = statement
            .query_map([&source], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, Option<String>>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, String>(4)?,
                ))
            })?
            .collect::<Result<Vec<_>, _>>()?;
        rows
    };
    let mut section_map = HashMap::new();
    for (id, parent, name, kind, position) in sections {
        let new_id = Uuid::new_v4().to_string();
        let new_parent = match parent {
            Some(parent) => Some(
                section_map
                    .get(&parent)
                    .cloned()
                    .ok_or_else(|| ProductError::Storage("section parent missing".to_owned()))?,
            ),
            None => None,
        };
        transaction.execute(
            "INSERT INTO asset_sections
             (id, project_id, storyboard_id, parent_id, name, kind, position, revision, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 1, ?8, ?8)",
            params![new_id, project, target, new_parent, name, kind, position, now],
        )?;
        section_map.insert(id, new_id);
    }
    let bindings = {
        let mut statement = transaction.prepare(
            "SELECT section_id, asset_id, position, prompt_override, derived_media_id
             FROM asset_bindings WHERE storyboard_id = ?1 ORDER BY position, id",
        )?;
        let rows = statement
            .query_map([&source], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, Option<String>>(3)?,
                    row.get::<_, Option<String>>(4)?,
                ))
            })?
            .collect::<Result<Vec<_>, _>>()?;
        rows
    };
    for (section, asset, position, prompt, derived) in bindings {
        let new_section = section_map
            .get(&section)
            .ok_or_else(|| ProductError::Storage("section missing".to_owned()))?;
        let new_derived = derived.as_ref().and_then(|id| media_map.get(id));
        transaction.execute(
            "INSERT INTO asset_bindings
             (id, project_id, storyboard_id, section_id, asset_id, position, prompt_override,
              derived_media_id, revision, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 1, ?9, ?9)",
            params![
                Uuid::new_v4().to_string(),
                project,
                target,
                new_section,
                asset,
                position,
                prompt.map(|value| remap_prompt_references(&value, &media_map, &source, &target)),
                new_derived,
                now
            ],
        )?;
    }

    let mut nodes = {
        let mut statement = transaction.prepare(
            "SELECT id, parent_id, kind, name, object_type, target_type, target_id, position
             FROM workspace_nodes WHERE storyboard_id = ?1 ORDER BY position, id",
        )?;
        let rows = statement
            .query_map([&source], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, Option<String>>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, Option<String>>(4)?,
                    row.get::<_, Option<String>>(5)?,
                    row.get::<_, Option<String>>(6)?,
                    row.get::<_, String>(7)?,
                ))
            })?
            .collect::<Result<Vec<_>, _>>()?;
        rows
    };
    let mut node_map = HashMap::new();
    while !nodes.is_empty() {
        let previous = nodes.len();
        let mut remaining = Vec::new();
        for (id, parent, kind, name, object_type, target_type, target_id, position) in nodes {
            if parent
                .as_ref()
                .is_some_and(|parent| !node_map.contains_key(parent))
            {
                remaining.push((
                    id,
                    parent,
                    kind,
                    name,
                    object_type,
                    target_type,
                    target_id,
                    position,
                ));
                continue;
            }
            // Media created from an empty workspace object uses the node UUID
            // as its media UUID. Preserve that identity in a copied storyboard
            // so the object keeps its upload and generation workspace.
            let new_id = if target_type.as_deref() == Some("script") {
                format!("script-{target}")
            } else if target_type.as_deref() == Some("media")
                && target_id.as_deref() == Some(id.as_str())
            {
                media_map
                    .get(&id)
                    .cloned()
                    .unwrap_or_else(|| Uuid::new_v4().to_string())
            } else {
                Uuid::new_v4().to_string()
            };
            let new_parent = parent.as_ref().and_then(|parent| node_map.get(parent));
            let mut copied_target_type = target_type.clone();
            let new_target = match target_type.as_deref() {
                Some("script") => Some(target.clone()),
                Some("media") => {
                    if let Some(id) = target_id.as_ref().and_then(|id| media_map.get(id)) {
                        Some(id.clone())
                    } else {
                        let (known, shared) = if let Some(id) = target_id.as_ref() {
                            transaction.query_row(
                                "SELECT EXISTS(SELECT 1 FROM media_items WHERE id = ?1),
                                 EXISTS(
                                   SELECT 1 FROM media_items media
                                   JOIN asset_bindings binding ON binding.asset_id = media.asset_id
                                   WHERE media.id = ?1 AND media.project_id = ?2
                                     AND media.deleted_at IS NULL
                                     AND binding.project_id = ?2 AND binding.storyboard_id = ?3
                                 )",
                                params![id, project, target],
                                |row| Ok((row.get::<_, bool>(0)?, row.get::<_, bool>(1)?)),
                            )?
                        } else {
                            (false, false)
                        };
                        // Older fixture trees may contain navigation-only media IDs.
                        // Keep those references, but clear a known deleted or out-of-scope target.
                        if shared || (!known && target_id.is_some()) {
                            target_id.clone()
                        } else {
                            copied_target_type = Some("empty".to_owned());
                            None
                        }
                    }
                }
                _ => None,
            };
            transaction.execute(
                "INSERT INTO workspace_nodes
                 (id, project_id, storyboard_id, parent_id, kind, name, object_type,
                  target_type, target_id, position, revision, created_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, 1, ?11, ?11)",
                params![
                    new_id,
                    project,
                    target,
                    new_parent,
                    kind,
                    name,
                    object_type,
                    copied_target_type,
                    new_target,
                    position,
                    now
                ],
            )?;
            node_map.insert(id, new_id);
        }
        if remaining.len() == previous {
            return Err(ProductError::Storage(
                "workspace node parent missing".to_owned(),
            ));
        }
        nodes = remaining;
    }
    append_event(
        &transaction,
        copy.project_id,
        "storyboard.created",
        json!({ "storyboardId": copy.id, "sourceStoryboardId": source_id, "revision": 1 }),
    )?;
    remember(&transaction, &idempotency, &copy)?;
    transaction.commit()?;
    Ok(copy)
}

fn remap_prompt_references(
    prompt: &str,
    media_map: &HashMap<String, String>,
    source_storyboard: &str,
    target_storyboard: &str,
) -> String {
    const HEADER: &str = "\n\n引用资产：\n";
    let Some((body, footer)) = prompt.rsplit_once(HEADER) else {
        return prompt.to_owned();
    };
    let (references, suffix) = footer
        .split_once("\n\n")
        .map_or((footer, ""), |(references, suffix)| (references, suffix));
    let source_script = format!("script-{source_storyboard}");
    let target_script = format!("script-{target_storyboard}");
    let mut mapped = Vec::new();
    for line in references.lines() {
        let Some((label, id)) = line.rsplit_once("」(") else {
            return prompt.to_owned();
        };
        let Some(id) = id.strip_suffix(')') else {
            return prompt.to_owned();
        };
        if !["- 图片「", "- 视频「", "- 文本「"]
            .iter()
            .any(|prefix| label.starts_with(prefix))
        {
            return prompt.to_owned();
        }
        let target_id = if id == source_script {
            target_script.as_str()
        } else {
            media_map.get(id).map(String::as_str).unwrap_or(id)
        };
        mapped.push(format!("{label}」({target_id})"));
    }
    if mapped.is_empty() {
        return prompt.to_owned();
    }
    let suffix = if suffix.is_empty() {
        String::new()
    } else {
        format!("\n\n{suffix}")
    };
    format!("{body}{HEADER}{}{suffix}", mapped.join("\n"))
}
