use super::mapping::{ensure_storyboard, load_section_view, section_view_from_row};
use crate::product::application::assets::{
    AssetSectionView, CreateSection, DeleteSection, DeleteSectionBindings, ReorderSection,
    UpdateSection,
};
use crate::product::domain::{AssetSectionId, ProductError, ProductResult};
use crate::product::infrastructure::sqlite::support::{
    append_event, format_position, immediate, next_position, remember, replay, revision_error,
    POSITION_STEP,
};
use chrono::Utc;
use rusqlite::{params, Connection, OptionalExtension, Transaction};
use serde_json::json;
use std::collections::HashMap;

pub(super) fn list(
    connection: &Connection,
    project_id: crate::product::domain::ProjectId,
    storyboard_id: crate::product::domain::StoryboardId,
) -> ProductResult<Vec<AssetSectionView>> {
    ensure_storyboard(connection, project_id, storyboard_id)?;
    let mut statement = connection.prepare(
        "SELECT s.id, s.project_id, s.storyboard_id, s.parent_id, s.name, s.kind, s.position, s.revision,
                (SELECT COUNT(*) FROM asset_bindings b WHERE b.section_id = s.id)
         FROM asset_sections s WHERE s.storyboard_id = ?1 AND s.project_id = ?2
         ORDER BY s.position, s.id",
    )?;
    let result = statement
        .query_map(
            params![storyboard_id.to_string(), project_id.to_string()],
            section_view_from_row,
        )?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(result)
}

pub(super) fn create(
    connection: &mut Connection,
    mut command: CreateSection,
) -> ProductResult<AssetSectionView> {
    let transaction = immediate(connection)?;
    if let Some(value) = replay(&transaction, &command.idempotency)? {
        return Ok(value);
    }
    ensure_storyboard(
        &transaction,
        command.section.project_id,
        command.section.storyboard_id,
    )?;
    validate_parent(&transaction, &command.section, command.section.parent_id)?;
    command.section.position = next_position(
        &transaction,
        "asset_sections",
        "storyboard_id",
        &command.section.storyboard_id.to_string(),
    )?;
    let now = Utc::now().to_rfc3339();
    transaction.execute(
        "INSERT INTO asset_sections
         (id, project_id, storyboard_id, parent_id, name, kind, position, revision, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?9)",
        params![
            command.section.id.to_string(),
            command.section.project_id.to_string(),
            command.section.storyboard_id.to_string(),
            command.section.parent_id.map(|id| id.to_string()),
            command.section.name,
            command.section.kind.as_str(),
            command.section.position,
            command.section.revision,
            now,
        ],
    )?;
    let view = load_section_view(
        &transaction,
        command.section.project_id,
        command.section.storyboard_id,
        command.section.id,
    )?
    .ok_or(ProductError::NotFound)?;
    append_event(
        &transaction,
        command.section.project_id,
        "assetSection.created",
        json!({ "sectionId": command.section.id, "storyboardId": command.section.storyboard_id }),
    )?;
    remember(&transaction, &command.idempotency, &view)?;
    transaction.commit()?;
    Ok(view)
}

pub(super) fn update(
    connection: &mut Connection,
    command: UpdateSection,
) -> ProductResult<AssetSectionView> {
    let transaction = immediate(connection)?;
    let current = load_section_view(
        &transaction,
        command.project_id,
        command.storyboard_id,
        command.section_id,
    )?
    .ok_or(ProductError::NotFound)?;
    validate_parent(&transaction, &current.section, command.parent_id)?;
    let changed = transaction.execute(
        "UPDATE asset_sections SET parent_id = ?1, name = ?2, kind = ?3,
                revision = revision + 1, updated_at = ?4
         WHERE id = ?5 AND storyboard_id = ?6 AND project_id = ?7 AND revision = ?8",
        params![
            command.parent_id.map(|id| id.to_string()),
            command.name,
            command.kind.as_str(),
            Utc::now().to_rfc3339(),
            command.section_id.to_string(),
            command.storyboard_id.to_string(),
            command.project_id.to_string(),
            command.expected_revision,
        ],
    )?;
    if changed == 0 {
        return Err(revision_error(
            actual_revision(&transaction, command.section_id)?,
            command.expected_revision,
        ));
    }
    let view = load_section_view(
        &transaction,
        command.project_id,
        command.storyboard_id,
        command.section_id,
    )?
    .ok_or(ProductError::NotFound)?;
    append_event(
        &transaction,
        command.project_id,
        "assetSection.updated",
        json!({ "sectionId": command.section_id, "storyboardId": command.storyboard_id }),
    )?;
    transaction.commit()?;
    Ok(view)
}

pub(super) fn delete(connection: &mut Connection, command: DeleteSection) -> ProductResult<()> {
    let transaction = immediate(connection)?;
    let current = load_section_view(
        &transaction,
        command.project_id,
        command.storyboard_id,
        command.section_id,
    )?
    .ok_or(ProductError::NotFound)?;
    if current.section.revision != command.expected_revision {
        return Err(ProductError::RevisionConflict {
            expected: command.expected_revision,
            actual: current.section.revision,
        });
    }
    let subtree = subtree_ids(&transaction, command.section_id)?;
    if let DeleteSectionBindings::Move { target_section_id } = command.bindings {
        if subtree.contains(&target_section_id) {
            return Err(ProductError::Validation(
                "target section cannot be inside the deleted subtree".to_owned(),
            ));
        }
        load_section_view(
            &transaction,
            command.project_id,
            command.storyboard_id,
            target_section_id,
        )?
        .ok_or(ProductError::NotFound)?;
        move_bindings(&transaction, &subtree, target_section_id)?;
    }
    transaction.execute(
        "DELETE FROM asset_sections WHERE id = ?1 AND storyboard_id = ?2 AND project_id = ?3",
        params![
            command.section_id.to_string(),
            command.storyboard_id.to_string(),
            command.project_id.to_string()
        ],
    )?;
    append_event(
        &transaction,
        command.project_id,
        "assetSection.deleted",
        json!({ "sectionId": command.section_id, "storyboardId": command.storyboard_id }),
    )?;
    transaction.commit()?;
    Ok(())
}

pub(super) fn reorder(
    connection: &mut Connection,
    command: ReorderSection,
) -> ProductResult<AssetSectionView> {
    let transaction = immediate(connection)?;
    if let Some(value) = replay(&transaction, &command.idempotency)? {
        return Ok(value);
    }
    let current = load_section_view(
        &transaction,
        command.project_id,
        command.storyboard_id,
        command.section_id,
    )?
    .ok_or(ProductError::NotFound)?;
    if current.section.revision != command.expected_revision {
        return Err(ProductError::RevisionConflict {
            expected: command.expected_revision,
            actual: current.section.revision,
        });
    }
    let mut siblings = sibling_ids(
        &transaction,
        command.storyboard_id,
        current.section.parent_id,
    )?;
    siblings.retain(|id| *id != command.section_id);
    let insert_at = insertion_index(&siblings, command.before_id, command.after_id)?;
    siblings.insert(insert_at, command.section_id);
    persist_order(&transaction, &siblings, command.section_id)?;
    let view = load_section_view(
        &transaction,
        command.project_id,
        command.storyboard_id,
        command.section_id,
    )?
    .ok_or(ProductError::NotFound)?;
    append_event(
        &transaction,
        command.project_id,
        "assetSection.reordered",
        json!({ "sectionId": command.section_id, "storyboardId": command.storyboard_id }),
    )?;
    remember(&transaction, &command.idempotency, &view)?;
    transaction.commit()?;
    Ok(view)
}

fn validate_parent(
    transaction: &Transaction<'_>,
    section: &crate::product::domain::AssetSection,
    parent_id: Option<AssetSectionId>,
) -> ProductResult<()> {
    let Some(parent_id) = parent_id else {
        return Ok(());
    };
    if parent_id == section.id {
        return Err(ProductError::Validation(
            "section cannot be its own parent".to_owned(),
        ));
    }
    let parent = load_section_view(
        transaction,
        section.project_id,
        section.storyboard_id,
        parent_id,
    )?
    .ok_or(ProductError::NotFound)?;
    if parent.section.parent_id.is_some() {
        return Err(ProductError::Validation(
            "asset sections support at most two levels".to_owned(),
        ));
    }
    let has_children: bool = transaction.query_row(
        "SELECT EXISTS(SELECT 1 FROM asset_sections WHERE parent_id = ?1)",
        [section.id.to_string()],
        |row| row.get(0),
    )?;
    if has_children {
        return Err(ProductError::Validation(
            "a section with children cannot become a child".to_owned(),
        ));
    }
    Ok(())
}

fn actual_revision(
    transaction: &Transaction<'_>,
    section_id: AssetSectionId,
) -> ProductResult<Option<i64>> {
    transaction
        .query_row(
            "SELECT revision FROM asset_sections WHERE id = ?1",
            [section_id.to_string()],
            |row| row.get(0),
        )
        .optional()
        .map_err(Into::into)
}

fn subtree_ids(
    transaction: &Transaction<'_>,
    section_id: AssetSectionId,
) -> ProductResult<Vec<AssetSectionId>> {
    let mut statement = transaction.prepare(
        "SELECT id FROM asset_sections WHERE id = ?1 OR parent_id = ?1 ORDER BY position",
    )?;
    let values = statement
        .query_map([section_id.to_string()], |row| {
            super::mapping::section_id_from_row(row, 0)
        })?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(values)
}

fn move_bindings(
    transaction: &Transaction<'_>,
    source_sections: &[AssetSectionId],
    target: AssetSectionId,
) -> ProductResult<()> {
    let mut next = transaction
        .query_row(
            "SELECT position FROM asset_bindings WHERE storyboard_id =
             (SELECT storyboard_id FROM asset_sections WHERE id = ?1)
             ORDER BY position DESC LIMIT 1",
            [target.to_string()],
            |row| row.get::<_, String>(0),
        )
        .optional()?
        .and_then(|value| value.parse::<u64>().ok())
        .unwrap_or_default();
    for section_id in source_sections {
        let mut statement = transaction
            .prepare("SELECT id FROM asset_bindings WHERE section_id = ?1 ORDER BY position, id")?;
        let ids = statement
            .query_map([section_id.to_string()], |row| row.get::<_, String>(0))?
            .collect::<Result<Vec<_>, _>>()?;
        for id in ids {
            next += POSITION_STEP;
            transaction.execute(
                "UPDATE asset_bindings SET section_id = ?1, position = ?2, revision = revision + 1,
                        updated_at = ?3 WHERE id = ?4",
                params![
                    target.to_string(),
                    format_position(next),
                    Utc::now().to_rfc3339(),
                    id
                ],
            )?;
        }
    }
    Ok(())
}

fn sibling_ids(
    transaction: &Transaction<'_>,
    storyboard_id: crate::product::domain::StoryboardId,
    parent_id: Option<AssetSectionId>,
) -> ProductResult<Vec<AssetSectionId>> {
    let mut statement = transaction.prepare(
        "SELECT id FROM asset_sections WHERE storyboard_id = ?1
         AND ((parent_id IS NULL AND ?2 IS NULL) OR parent_id = ?2) ORDER BY position, id",
    )?;
    let values = statement
        .query_map(
            params![
                storyboard_id.to_string(),
                parent_id.map(|id| id.to_string())
            ],
            |row| super::mapping::section_id_from_row(row, 0),
        )?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(values)
}

fn insertion_index(
    siblings: &[AssetSectionId],
    before: Option<AssetSectionId>,
    after: Option<AssetSectionId>,
) -> ProductResult<usize> {
    let positions = siblings
        .iter()
        .enumerate()
        .map(|(index, id)| (*id, index))
        .collect::<HashMap<_, _>>();
    let before_index = before
        .map(|id| positions.get(&id).copied())
        .transpose_option()?;
    let after_index = after
        .map(|id| positions.get(&id).copied())
        .transpose_option()?;
    if let (Some(before_index), Some(after_index)) = (before_index, after_index) {
        if after_index + 1 != before_index {
            return Err(ProductError::Validation(
                "beforeId and afterId must be adjacent".to_owned(),
            ));
        }
    }
    Ok(before_index
        .or_else(|| after_index.map(|index| index + 1))
        .unwrap_or(0))
}

fn persist_order(
    transaction: &Transaction<'_>,
    ids: &[AssetSectionId],
    target: AssetSectionId,
) -> ProductResult<()> {
    let storyboard_id: String = transaction.query_row(
        "SELECT storyboard_id FROM asset_sections WHERE id = ?1",
        [target.to_string()],
        |row| row.get(0),
    )?;
    for id in ids {
        transaction.execute(
            "UPDATE asset_sections SET position = ?1 WHERE id = ?2",
            params![format!("tmp-{}", id), id.to_string()],
        )?;
    }
    let base = transaction
        .query_row(
            "SELECT position FROM asset_sections
             WHERE storyboard_id = ?1 AND position NOT LIKE 'tmp-%'
             ORDER BY position DESC LIMIT 1",
            [storyboard_id],
            |row| row.get::<_, String>(0),
        )
        .optional()?
        .and_then(|value| value.parse::<u64>().ok())
        .unwrap_or_default();
    for (index, id) in ids.iter().enumerate() {
        transaction.execute(
            "UPDATE asset_sections SET position = ?1,
                    revision = revision + CASE WHEN id = ?2 THEN 1 ELSE 0 END,
                    updated_at = CASE WHEN id = ?2 THEN ?3 ELSE updated_at END WHERE id = ?4",
            params![
                format_position(base + (index as u64 + 1) * POSITION_STEP),
                target.to_string(),
                Utc::now().to_rfc3339(),
                id.to_string()
            ],
        )?;
    }
    Ok(())
}

trait TransposeOption<T> {
    fn transpose_option(self) -> ProductResult<Option<T>>;
}

impl<T> TransposeOption<T> for Option<Option<T>> {
    fn transpose_option(self) -> ProductResult<Option<T>> {
        match self {
            Some(None) => Err(ProductError::Validation(
                "reorder neighbor must be a sibling".to_owned(),
            )),
            Some(Some(value)) => Ok(Some(value)),
            None => Ok(None),
        }
    }
}
