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
    for (id, kind, role, name, prompt, mime, object, thumbnail, width, height, duration, status) in
        media
    {
        let new_id = Uuid::new_v4().to_string();
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
        media_map.insert(id, new_id);
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
                prompt,
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
            let new_id = if target_type.as_deref() == Some("media")
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
            let new_target = match target_type.as_deref() {
                Some("script") => Some(target.clone()),
                Some("media") => target_id
                    .as_ref()
                    .map(|id| media_map.get(id).cloned().unwrap_or_else(|| id.clone())),
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
                    target_type,
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
