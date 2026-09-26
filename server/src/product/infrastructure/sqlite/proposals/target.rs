use crate::product::domain::{
    MediaId, MediaKind, ProductError, ProductResult, ProjectId, ProposalTarget, StoryboardId,
};
use crate::product::infrastructure::sqlite::support::revision_error;
use chrono::Utc;
use rusqlite::{params, Connection, OptionalExtension, Transaction};

pub(crate) struct TargetSnapshot {
    pub value: String,
    pub revision: i64,
}

pub(crate) fn ensure_storyboard(
    connection: &Connection,
    project_id: ProjectId,
    storyboard_id: StoryboardId,
) -> ProductResult<()> {
    let exists: bool = connection.query_row(
        "SELECT EXISTS(SELECT 1 FROM storyboards \
         WHERE id = ?1 AND project_id = ?2 AND deleted_at IS NULL)",
        params![storyboard_id.to_string(), project_id.to_string()],
        |row| row.get(0),
    )?;
    if exists {
        Ok(())
    } else {
        Err(ProductError::NotFound)
    }
}

pub(crate) fn snapshot(
    connection: &Connection,
    project_id: ProjectId,
    storyboard_id: StoryboardId,
    target: &ProposalTarget,
) -> ProductResult<Option<TargetSnapshot>> {
    let snapshot = match target {
        ProposalTarget::Script {
            storyboard_id: target_storyboard_id,
        } if *target_storyboard_id == storyboard_id => connection
            .query_row(
                "SELECT script.text, script.revision FROM storyboard_scripts script \
                 JOIN storyboards board ON board.id = script.storyboard_id \
                 WHERE script.storyboard_id = ?1 AND board.project_id = ?2 \
                   AND board.deleted_at IS NULL",
                params![storyboard_id.to_string(), project_id.to_string()],
                map_snapshot,
            )
            .optional()?,
        ProposalTarget::Script { .. } => None,
        ProposalTarget::MediaPrompt { media_id } => connection
            .query_row(
                "SELECT COALESCE(prompt, ''), revision FROM media_items \
                 WHERE id = ?1 AND project_id = ?2 AND deleted_at IS NULL \
                   AND (storyboard_id = ?3 OR EXISTS( \
                       SELECT 1 FROM asset_bindings binding \
                       JOIN assets asset ON asset.id = binding.asset_id \
                          AND asset.project_id = binding.project_id \
                       WHERE binding.asset_id = media_items.asset_id \
                         AND binding.project_id = media_items.project_id \
                         AND binding.storyboard_id = ?3 AND asset.deleted_at IS NULL \
                   ))",
                params![media_id.to_string(), project_id.to_string(), storyboard_id.to_string()],
                map_snapshot,
            )
            .optional()?,
        ProposalTarget::AssetBindingPrompt { binding_id } => connection
            .query_row(
                "SELECT COALESCE(binding.prompt_override, asset.canonical_prompt, ''), binding.revision \
                 FROM asset_bindings binding \
                 JOIN assets asset ON asset.id = binding.asset_id AND asset.project_id = binding.project_id \
                 JOIN storyboards board ON board.id = binding.storyboard_id \
                    AND board.project_id = binding.project_id \
                 WHERE binding.id = ?1 AND binding.project_id = ?2 AND binding.storyboard_id = ?3 \
                   AND asset.deleted_at IS NULL AND board.deleted_at IS NULL",
                params![binding_id.to_string(), project_id.to_string(), storyboard_id.to_string()],
                map_snapshot,
            )
            .optional()?,
    };
    Ok(snapshot)
}

pub(crate) fn apply(
    tx: &Transaction<'_>,
    project_id: ProjectId,
    storyboard_id: StoryboardId,
    target: &ProposalTarget,
    proposed_value: &str,
    expected_revision: i64,
) -> ProductResult<i64> {
    let now = Utc::now().to_rfc3339();
    let changed = match target {
        ProposalTarget::Script {
            storyboard_id: target_storyboard_id,
        } if *target_storyboard_id == storyboard_id => tx.execute(
            "UPDATE storyboard_scripts SET text = ?1, revision = revision + 1, updated_at = ?2 \
             WHERE storyboard_id = ?3 AND revision = ?4 \
               AND EXISTS(SELECT 1 FROM storyboards WHERE id = ?3 AND project_id = ?5 \
                          AND deleted_at IS NULL)",
            params![proposed_value, now, storyboard_id.to_string(), expected_revision, project_id.to_string()],
        )?,
        ProposalTarget::Script { .. } => 0,
        ProposalTarget::MediaPrompt { media_id } => tx.execute(
            "UPDATE media_items SET prompt = ?1, revision = revision + 1, updated_at = ?2 \
             WHERE id = ?3 AND project_id = ?4 AND revision = ?6 AND deleted_at IS NULL \
               AND (storyboard_id = ?5 OR EXISTS( \
                   SELECT 1 FROM asset_bindings binding \
                   JOIN assets asset ON asset.id = binding.asset_id \
                      AND asset.project_id = binding.project_id \
                   WHERE binding.asset_id = media_items.asset_id \
                     AND binding.project_id = media_items.project_id \
                     AND binding.storyboard_id = ?5 AND asset.deleted_at IS NULL \
               ))",
            params![proposed_value, now, media_id.to_string(), project_id.to_string(), storyboard_id.to_string(), expected_revision],
        )?,
        ProposalTarget::AssetBindingPrompt { binding_id } => tx.execute(
            "UPDATE asset_bindings SET prompt_override = ?1, revision = revision + 1, updated_at = ?2 \
             WHERE id = ?3 AND project_id = ?4 AND storyboard_id = ?5 AND revision = ?6",
            params![proposed_value, now, binding_id.to_string(), project_id.to_string(), storyboard_id.to_string(), expected_revision],
        )?,
    };
    if changed == 0 {
        let actual = snapshot(tx, project_id, storyboard_id, target)?.map(|item| item.revision);
        return Err(revision_error(actual, expected_revision));
    }
    Ok(expected_revision + 1)
}

pub(crate) fn media_kind(
    connection: &Connection,
    project_id: ProjectId,
    storyboard_id: StoryboardId,
    media_id: MediaId,
) -> ProductResult<MediaKind> {
    let kind = connection
        .query_row(
            "SELECT kind FROM media_items \
             WHERE id = ?1 AND project_id = ?2 AND deleted_at IS NULL \
               AND (storyboard_id = ?3 OR EXISTS( \
                   SELECT 1 FROM asset_bindings binding \
                   JOIN assets asset ON asset.id = binding.asset_id \
                      AND asset.project_id = binding.project_id \
                   WHERE binding.asset_id = media_items.asset_id \
                     AND binding.project_id = media_items.project_id \
                     AND binding.storyboard_id = ?3 AND asset.deleted_at IS NULL \
               ))",
            params![
                media_id.to_string(),
                project_id.to_string(),
                storyboard_id.to_string()
            ],
            |row| row.get::<_, String>(0),
        )
        .optional()?
        .ok_or(ProductError::NotFound)?;
    MediaKind::from_storage_str(&kind)
        .ok_or_else(|| ProductError::Storage("unknown media kind".into()))
}

fn map_snapshot(row: &rusqlite::Row<'_>) -> rusqlite::Result<TargetSnapshot> {
    Ok(TargetSnapshot {
        value: row.get(0)?,
        revision: row.get(1)?,
    })
}
