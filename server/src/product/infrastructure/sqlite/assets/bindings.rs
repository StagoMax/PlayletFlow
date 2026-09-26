use super::mapping::{binding_from_row, ensure_storyboard, load_binding_view, load_section_view};
use crate::product::application::assets::{
    AssetBindingView, CopyAssetBindings, CopyAssetBindingsResult, CopySkipped, CreateBindings,
    DeleteBinding, UpdateBinding,
};
use crate::product::domain::{
    AssetBindingId, AssetId, AssetKind, AssetSectionId, ProductError, ProductResult, ProjectId,
    StoryboardId,
};
use crate::product::infrastructure::sqlite::support::{
    append_event, format_position, immediate, next_position, remember, replay, revision_error,
    POSITION_STEP,
};
use chrono::Utc;
use rusqlite::{params, Connection, OptionalExtension, Transaction};
use serde_json::json;
use std::collections::{HashMap, HashSet};
use std::str::FromStr;
use uuid::Uuid;

pub(super) fn list(
    connection: &Connection,
    project_id: ProjectId,
    storyboard_id: StoryboardId,
) -> ProductResult<Vec<AssetBindingView>> {
    ensure_storyboard(connection, project_id, storyboard_id)?;
    let mut statement = connection.prepare(
        "SELECT id, project_id, storyboard_id, section_id, asset_id, position,
                prompt_override, derived_media_id, revision, created_at, updated_at
         FROM asset_bindings WHERE storyboard_id = ?1 AND project_id = ?2 ORDER BY position, id",
    )?;
    let bindings = statement
        .query_map(
            params![storyboard_id.to_string(), project_id.to_string()],
            binding_from_row,
        )?
        .collect::<Result<Vec<_>, _>>()?;
    bindings
        .into_iter()
        .map(|binding| {
            load_binding_view(connection, project_id, storyboard_id, binding.id)?
                .ok_or(ProductError::NotFound)
        })
        .collect()
}

pub(super) fn create(
    connection: &mut Connection,
    mut command: CreateBindings,
) -> ProductResult<Vec<AssetBindingView>> {
    let transaction = immediate(connection)?;
    if let Some(value) = replay(&transaction, &command.idempotency)? {
        return Ok(value);
    }
    ensure_storyboard(&transaction, command.project_id, command.storyboard_id)?;
    load_section_view(
        &transaction,
        command.project_id,
        command.storyboard_id,
        command.section_id,
    )?
    .ok_or(ProductError::NotFound)?;
    let mut next = last_binding_position(&transaction, command.storyboard_id)?;
    for binding in &mut command.bindings {
        ensure_asset(&transaction, command.project_id, binding.asset_id)?;
        if binding_exists(&transaction, command.storyboard_id, binding.asset_id)? {
            return Err(ProductError::Conflict {
                code: "DUPLICATE_BINDING",
                message: "asset is already bound to this storyboard".to_owned(),
            });
        }
        next += POSITION_STEP;
        binding.position = format_position(next);
        insert_binding(&transaction, binding)?;
    }
    let views = command
        .bindings
        .iter()
        .map(|binding| {
            load_binding_view(
                &transaction,
                command.project_id,
                command.storyboard_id,
                binding.id,
            )?
            .ok_or(ProductError::NotFound)
        })
        .collect::<ProductResult<Vec<_>>>()?;
    append_event(
        &transaction,
        command.project_id,
        "assetBindings.created",
        json!({
            "storyboardId": command.storyboard_id,
            "bindingIds": command.bindings.iter().map(|item| item.id).collect::<Vec<_>>()
        }),
    )?;
    remember(&transaction, &command.idempotency, &views)?;
    transaction.commit()?;
    Ok(views)
}

pub(super) fn update(
    connection: &mut Connection,
    command: UpdateBinding,
) -> ProductResult<AssetBindingView> {
    let transaction = immediate(connection)?;
    load_section_view(
        &transaction,
        command.project_id,
        command.storyboard_id,
        command.section_id,
    )?
    .ok_or(ProductError::NotFound)?;
    let current = load_binding_view(
        &transaction,
        command.project_id,
        command.storyboard_id,
        command.binding_id,
    )?
    .ok_or(ProductError::NotFound)?;
    if current.binding.revision != command.expected_revision {
        return Err(ProductError::RevisionConflict {
            expected: command.expected_revision,
            actual: current.binding.revision,
        });
    }
    if command.before_id.is_some() || command.after_id.is_some() {
        reorder_bindings(
            &transaction,
            command.storyboard_id,
            command.binding_id,
            command.before_id,
            command.after_id,
        )?;
    }
    let changed = transaction.execute(
        "UPDATE asset_bindings SET section_id = ?1, prompt_override = ?2,
                revision = revision + 1, updated_at = ?3
         WHERE id = ?4 AND storyboard_id = ?5 AND project_id = ?6 AND revision = ?7",
        params![
            command.section_id.to_string(),
            command.prompt_override,
            Utc::now().to_rfc3339(),
            command.binding_id.to_string(),
            command.storyboard_id.to_string(),
            command.project_id.to_string(),
            command.expected_revision,
        ],
    )?;
    if changed == 0 {
        return Err(revision_error(
            binding_revision(&transaction, command.binding_id)?,
            command.expected_revision,
        ));
    }
    let view = load_binding_view(
        &transaction,
        command.project_id,
        command.storyboard_id,
        command.binding_id,
    )?
    .ok_or(ProductError::NotFound)?;
    append_event(
        &transaction,
        command.project_id,
        "assetBinding.updated",
        json!({ "storyboardId": command.storyboard_id, "bindingId": command.binding_id }),
    )?;
    transaction.commit()?;
    Ok(view)
}

pub(super) fn delete(connection: &mut Connection, command: DeleteBinding) -> ProductResult<()> {
    let transaction = immediate(connection)?;
    let changed = transaction.execute(
        "DELETE FROM asset_bindings
         WHERE id = ?1 AND storyboard_id = ?2 AND project_id = ?3 AND revision = ?4",
        params![
            command.binding_id.to_string(),
            command.storyboard_id.to_string(),
            command.project_id.to_string(),
            command.expected_revision
        ],
    )?;
    if changed == 0 {
        return Err(revision_error(
            binding_revision(&transaction, command.binding_id)?,
            command.expected_revision,
        ));
    }
    append_event(
        &transaction,
        command.project_id,
        "assetBinding.deleted",
        json!({ "storyboardId": command.storyboard_id, "bindingId": command.binding_id }),
    )?;
    transaction.commit()?;
    Ok(())
}

pub(super) fn copy(
    connection: &mut Connection,
    command: CopyAssetBindings,
) -> ProductResult<CopyAssetBindingsResult> {
    let transaction = immediate(connection)?;
    if let Some(value) = replay(&transaction, &command.idempotency)? {
        return Ok(value);
    }
    let input = crate::product::application::assets::CopyAssetBindingsInput {
        project_id: command.project_id,
        source_storyboard_id: command.source_storyboard_id,
        target_storyboard_id: command.target_storyboard_id,
        binding_ids: command.binding_ids,
        include_section_structure: command.include_section_structure,
        target_section_id: command.target_section_id,
        include_prompt_overrides: command.include_prompt_overrides,
    };
    let result = copy_in_transaction(&transaction, &input)?;
    remember(&transaction, &command.idempotency, &result)?;
    transaction.commit()?;
    Ok(result)
}

pub(in crate::product::infrastructure::sqlite) fn copy_in_transaction(
    transaction: &Transaction<'_>,
    command: &crate::product::application::assets::CopyAssetBindingsInput,
) -> ProductResult<CopyAssetBindingsResult> {
    ensure_storyboard(
        transaction,
        command.project_id,
        command.source_storyboard_id,
    )?;
    ensure_storyboard(
        transaction,
        command.project_id,
        command.target_storyboard_id,
    )?;
    let source_bindings = source_bindings(transaction, command)?;
    if source_bindings.len() != command.binding_ids.len() {
        return Err(ProductError::NotFound);
    }
    let section_map = if command.include_section_structure {
        copy_section_structure(transaction, command, &source_bindings)?
    } else {
        let target = command
            .target_section_id
            .ok_or_else(|| ProductError::Validation("targetSectionId is required".to_owned()))?;
        load_section_view(
            transaction,
            command.project_id,
            command.target_storyboard_id,
            target,
        )?
        .ok_or(ProductError::NotFound)?;
        source_bindings
            .iter()
            .map(|binding| (binding.section_id, target))
            .collect()
    };
    let mut result = CopyAssetBindingsResult {
        created_binding_ids: Vec::new(),
        skipped: Vec::new(),
        section_map: section_map.iter().map(|(from, to)| (*from, *to)).collect(),
    };
    let mut next = last_binding_position(transaction, command.target_storyboard_id)?;
    for source in source_bindings {
        if binding_exists(transaction, command.target_storyboard_id, source.asset_id)? {
            result.skipped.push(CopySkipped {
                binding_id: source.id,
                reason: "assetAlreadyBound".to_owned(),
            });
            continue;
        }
        next += POSITION_STEP;
        let now = Utc::now();
        let binding = crate::product::domain::AssetBinding {
            id: AssetBindingId::new(),
            project_id: command.project_id,
            storyboard_id: command.target_storyboard_id,
            section_id: *section_map.get(&source.section_id).ok_or_else(|| {
                ProductError::Storage("copied section mapping is incomplete".to_owned())
            })?,
            asset_id: source.asset_id,
            position: format_position(next),
            prompt_override: command
                .include_prompt_overrides
                .then_some(source.prompt_override)
                .flatten(),
            derived_media_id: None,
            revision: 1,
            created_at: now,
            updated_at: now,
        };
        insert_binding(transaction, &binding)?;
        result.created_binding_ids.push(binding.id);
    }
    append_event(
        transaction,
        command.project_id,
        "assetBindings.copied",
        json!({
            "sourceStoryboardId": command.source_storyboard_id,
            "targetStoryboardId": command.target_storyboard_id,
            "createdBindingIds": result.created_binding_ids
        }),
    )?;
    Ok(result)
}

fn source_bindings(
    transaction: &Transaction<'_>,
    command: &crate::product::application::assets::CopyAssetBindingsInput,
) -> ProductResult<Vec<crate::product::domain::AssetBinding>> {
    let wanted = command.binding_ids.iter().copied().collect::<HashSet<_>>();
    let mut statement = transaction.prepare(
        "SELECT id, project_id, storyboard_id, section_id, asset_id, position,
                prompt_override, derived_media_id, revision, created_at, updated_at
         FROM asset_bindings WHERE storyboard_id = ?1 AND project_id = ?2 ORDER BY position, id",
    )?;
    let all = statement
        .query_map(
            params![
                command.source_storyboard_id.to_string(),
                command.project_id.to_string()
            ],
            binding_from_row,
        )?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(all
        .into_iter()
        .filter(|item| wanted.contains(&item.id))
        .collect())
}

fn copy_section_structure(
    transaction: &Transaction<'_>,
    command: &crate::product::application::assets::CopyAssetBindingsInput,
    bindings: &[crate::product::domain::AssetBinding],
) -> ProductResult<HashMap<AssetSectionId, AssetSectionId>> {
    let mut source_ids = bindings
        .iter()
        .map(|item| item.section_id)
        .collect::<Vec<_>>();
    source_ids.sort_by_key(|id| id.0);
    source_ids.dedup();
    let mut source_sections = Vec::new();
    for id in source_ids {
        let section = load_section_record(transaction, command.source_storyboard_id, id)?;
        if let Some(parent_id) = section.parent_id {
            if !source_sections
                .iter()
                .any(|item: &SectionRecord| item.id == parent_id)
            {
                source_sections.push(load_section_record(
                    transaction,
                    command.source_storyboard_id,
                    parent_id,
                )?);
            }
        }
        source_sections.push(section);
    }
    source_sections.sort_by_key(|section| section.parent_id.is_some());
    let mut mapping = HashMap::new();
    for source in source_sections {
        let target_parent = source.parent_id.and_then(|id| mapping.get(&id).copied());
        let target = find_equivalent_section(
            transaction,
            command.target_storyboard_id,
            target_parent,
            &source.name,
            source.kind,
        )?
        .unwrap_or(create_target_section(
            transaction,
            command.project_id,
            command.target_storyboard_id,
            target_parent,
            &source,
        )?);
        mapping.insert(source.id, target);
    }
    Ok(mapping)
}

#[derive(Clone)]
struct SectionRecord {
    id: AssetSectionId,
    parent_id: Option<AssetSectionId>,
    name: String,
    kind: AssetKind,
}

fn load_section_record(
    transaction: &Transaction<'_>,
    storyboard_id: StoryboardId,
    section_id: AssetSectionId,
) -> ProductResult<SectionRecord> {
    transaction
        .query_row(
            "SELECT id, parent_id, name, kind FROM asset_sections
             WHERE id = ?1 AND storyboard_id = ?2",
            params![section_id.to_string(), storyboard_id.to_string()],
            |row| {
                let parent = row
                    .get::<_, Option<String>>(1)?
                    .map(|value| Uuid::parse_str(&value))
                    .transpose()
                    .map_err(|error| {
                        rusqlite::Error::FromSqlConversionFailure(
                            1,
                            rusqlite::types::Type::Text,
                            Box::new(error),
                        )
                    })?
                    .map(AssetSectionId::from);
                let kind = AssetKind::from_str(&row.get::<_, String>(3)?).map_err(|error| {
                    rusqlite::Error::FromSqlConversionFailure(
                        3,
                        rusqlite::types::Type::Text,
                        Box::new(error),
                    )
                })?;
                Ok(SectionRecord {
                    id: AssetSectionId::from(super::mapping::uuid_at(row, 0)?),
                    parent_id: parent,
                    name: row.get(2)?,
                    kind,
                })
            },
        )
        .optional()?
        .ok_or(ProductError::NotFound)
}

fn find_equivalent_section(
    transaction: &Transaction<'_>,
    storyboard_id: StoryboardId,
    parent_id: Option<AssetSectionId>,
    name: &str,
    kind: AssetKind,
) -> ProductResult<Option<AssetSectionId>> {
    transaction
        .query_row(
            "SELECT id FROM asset_sections WHERE storyboard_id = ?1
             AND ((parent_id IS NULL AND ?2 IS NULL) OR parent_id = ?2)
             AND name = ?3 AND kind = ?4 ORDER BY position LIMIT 1",
            params![
                storyboard_id.to_string(),
                parent_id.map(|id| id.to_string()),
                name,
                kind.as_str()
            ],
            |row| super::mapping::section_id_from_row(row, 0),
        )
        .optional()
        .map_err(Into::into)
}

fn create_target_section(
    transaction: &Transaction<'_>,
    project_id: ProjectId,
    storyboard_id: StoryboardId,
    parent_id: Option<AssetSectionId>,
    source: &SectionRecord,
) -> ProductResult<AssetSectionId> {
    let id = AssetSectionId::new();
    let position = next_position(
        transaction,
        "asset_sections",
        "storyboard_id",
        &storyboard_id.to_string(),
    )?;
    let now = Utc::now().to_rfc3339();
    transaction.execute(
        "INSERT INTO asset_sections
         (id, project_id, storyboard_id, parent_id, name, kind, position, revision, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 1, ?8, ?8)",
        params![
            id.to_string(),
            project_id.to_string(),
            storyboard_id.to_string(),
            parent_id.map(|id| id.to_string()),
            source.name,
            source.kind.as_str(),
            position,
            now
        ],
    )?;
    Ok(id)
}

fn insert_binding(
    transaction: &Transaction<'_>,
    binding: &crate::product::domain::AssetBinding,
) -> ProductResult<()> {
    transaction.execute(
        "INSERT INTO asset_bindings
         (id, project_id, storyboard_id, section_id, asset_id, position, prompt_override,
          derived_media_id, revision, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
        params![
            binding.id.to_string(),
            binding.project_id.to_string(),
            binding.storyboard_id.to_string(),
            binding.section_id.to_string(),
            binding.asset_id.to_string(),
            binding.position,
            binding.prompt_override,
            binding.derived_media_id.map(|id| id.to_string()),
            binding.revision,
            binding.created_at.to_rfc3339(),
            binding.updated_at.to_rfc3339(),
        ],
    )?;
    Ok(())
}

fn ensure_asset(
    transaction: &Transaction<'_>,
    project_id: ProjectId,
    asset_id: AssetId,
) -> ProductResult<()> {
    let exists: bool = transaction.query_row(
        "SELECT EXISTS(SELECT 1 FROM assets WHERE id = ?1 AND project_id = ?2 AND deleted_at IS NULL)",
        params![asset_id.to_string(), project_id.to_string()],
        |row| row.get(0),
    )?;
    if exists {
        Ok(())
    } else {
        Err(ProductError::NotFound)
    }
}

fn binding_exists(
    transaction: &Transaction<'_>,
    storyboard_id: StoryboardId,
    asset_id: AssetId,
) -> ProductResult<bool> {
    transaction
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM asset_bindings WHERE storyboard_id = ?1 AND asset_id = ?2)",
            params![storyboard_id.to_string(), asset_id.to_string()],
            |row| row.get(0),
        )
        .map_err(Into::into)
}

fn last_binding_position(
    transaction: &Transaction<'_>,
    storyboard_id: StoryboardId,
) -> ProductResult<u64> {
    Ok(transaction
        .query_row(
            "SELECT position FROM asset_bindings WHERE storyboard_id = ?1 ORDER BY position DESC LIMIT 1",
            [storyboard_id.to_string()],
            |row| row.get::<_, String>(0),
        )
        .optional()?
        .and_then(|value| value.parse().ok())
        .unwrap_or_default())
}

fn binding_revision(
    transaction: &Transaction<'_>,
    binding_id: AssetBindingId,
) -> ProductResult<Option<i64>> {
    transaction
        .query_row(
            "SELECT revision FROM asset_bindings WHERE id = ?1",
            [binding_id.to_string()],
            |row| row.get(0),
        )
        .optional()
        .map_err(Into::into)
}

fn reorder_bindings(
    transaction: &Transaction<'_>,
    storyboard_id: StoryboardId,
    target: AssetBindingId,
    before: Option<AssetBindingId>,
    after: Option<AssetBindingId>,
) -> ProductResult<()> {
    let mut statement = transaction
        .prepare("SELECT id FROM asset_bindings WHERE storyboard_id = ?1 ORDER BY position, id")?;
    let mut ids = statement
        .query_map([storyboard_id.to_string()], |row| {
            super::mapping::binding_id_from_row(row, 0)
        })?
        .collect::<Result<Vec<_>, _>>()?;
    ids.retain(|id| *id != target);
    let before_index = neighbor_index(&ids, before)?;
    let after_index = neighbor_index(&ids, after)?;
    if let (Some(before_index), Some(after_index)) = (before_index, after_index) {
        if after_index + 1 != before_index {
            return Err(ProductError::Validation(
                "beforeId and afterId must be adjacent".to_owned(),
            ));
        }
    }
    let index = before_index
        .or_else(|| after_index.map(|value| value + 1))
        .unwrap_or_default();
    ids.insert(index, target);
    for id in &ids {
        transaction.execute(
            "UPDATE asset_bindings SET position = ?1 WHERE id = ?2",
            params![format!("tmp-{id}"), id.to_string()],
        )?;
    }
    for (index, id) in ids.iter().enumerate() {
        transaction.execute(
            "UPDATE asset_bindings SET position = ?1 WHERE id = ?2",
            params![
                format_position((index as u64 + 1) * POSITION_STEP),
                id.to_string()
            ],
        )?;
    }
    Ok(())
}

fn neighbor_index<T: Copy + Eq>(ids: &[T], neighbor: Option<T>) -> ProductResult<Option<usize>> {
    match neighbor {
        Some(neighbor) => ids
            .iter()
            .position(|id| *id == neighbor)
            .map(Some)
            .ok_or_else(|| ProductError::Validation("reorder neighbor was not found".to_owned())),
        None => Ok(None),
    }
}
