use super::insert_new_node;
use crate::product::application::workspace_nodes::{
    CreatePromptedMediaObject, SaveWorkspaceObjectPrompt, SavedWorkspaceObjectPrompt,
    UndoWorkspaceObjectPrompt,
};
use crate::product::domain::{
    MediaId, ProductError, ProductResult, WorkspaceNode, WorkspaceObjectType,
};
use crate::product::infrastructure::sqlite::support::{append_event, immediate, remember, replay};
use chrono::Utc;
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::json;
use uuid::Uuid;

pub(super) fn create_prompted(
    connection: &mut Connection,
    mut command: CreatePromptedMediaObject,
) -> ProductResult<WorkspaceNode> {
    let transaction = immediate(connection)?;
    if let Some(value) = replay(&transaction, &command.idempotency)? {
        return Ok(value);
    }
    let node = insert_new_node(&transaction, &mut command.node)?;
    let kind = node
        .object_type
        .ok_or_else(|| ProductError::Storage("media object type is missing".to_owned()))?;
    let mime_type = match kind {
        WorkspaceObjectType::Image => "image/png",
        WorkspaceObjectType::Video => "video/mp4",
        WorkspaceObjectType::Text => {
            return Err(ProductError::Validation(
                "a prompted media object must be an image or video".to_owned(),
            ))
        }
    };
    transaction.execute(
        "INSERT INTO media_items
         (id, project_id, storyboard_id, kind, role, name, prompt, mime_type,
          status, revision, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, 'custom', ?5, ?6, ?7, 'placeholder', 1, ?8, ?8)",
        params![
            node.id,
            node.project_id.to_string(),
            node.storyboard_id.to_string(),
            kind.as_str(),
            node.name,
            command.prompt,
            mime_type,
            node.created_at.to_rfc3339(),
        ],
    )?;
    append_event(
        &transaction,
        node.project_id,
        "workspaceNode.created",
        json!({ "nodeId": node.id, "storyboardId": node.storyboard_id }),
    )?;
    remember(&transaction, &command.idempotency, &node)?;
    transaction.commit()?;
    Ok(node)
}

pub(super) fn save_prompt(
    connection: &mut Connection,
    command: SaveWorkspaceObjectPrompt,
) -> ProductResult<SavedWorkspaceObjectPrompt> {
    let transaction = immediate(connection)?;
    if let Some(value) = replay(&transaction, &command.idempotency)? {
        return Ok(value);
    }
    let current = transaction
        .query_row(
            "SELECT node.id, node.object_type, media.id, media.prompt, media.revision
             FROM workspace_nodes node
             JOIN media_items media ON media.id = node.target_id
               AND media.project_id = node.project_id
               AND media.storyboard_id = node.storyboard_id
             WHERE (node.id = ?1 OR node.target_id = ?1)
               AND node.project_id = ?2 AND node.storyboard_id = ?3
               AND node.kind = 'object' AND node.object_type IN ('image', 'video')
               AND node.target_type = 'media' AND media.deleted_at IS NULL
             ORDER BY CASE WHEN node.id = ?1 THEN 0 ELSE 1 END
             LIMIT 1",
            params![
                command.target_id,
                command.project_id.to_string(),
                command.storyboard_id.to_string()
            ],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, i64>(4)?,
                ))
            },
        )
        .optional()?
        .ok_or(ProductError::NotFound)?;
    let (object_id, object_type, media_id, current_prompt, actual_revision) = current;
    if actual_revision != command.expected_revision {
        return Err(ProductError::RevisionConflict {
            expected: command.expected_revision,
            actual: actual_revision,
        });
    }
    let updated_at = Utc::now();
    transaction.execute(
        "INSERT OR IGNORE INTO workspace_object_prompt_history
         (project_id, storyboard_id, object_id, media_id, prompt, media_revision, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
        params![
            command.project_id.to_string(),
            command.storyboard_id.to_string(),
            object_id,
            media_id,
            current_prompt,
            actual_revision,
            updated_at.to_rfc3339(),
        ],
    )?;
    let affected = transaction.execute(
        "UPDATE media_items SET prompt = ?1, revision = revision + 1, updated_at = ?2
         WHERE id = ?3 AND project_id = ?4 AND storyboard_id = ?5
           AND revision = ?6 AND deleted_at IS NULL",
        params![
            command.prompt,
            updated_at.to_rfc3339(),
            media_id,
            command.project_id.to_string(),
            command.storyboard_id.to_string(),
            command.expected_revision,
        ],
    )?;
    if affected != 1 {
        return Err(ProductError::RevisionConflict {
            expected: command.expected_revision,
            actual: actual_revision,
        });
    }
    transaction.execute(
        "UPDATE workspace_nodes SET unseen_update_at = ?1
         WHERE id = ?2 AND project_id = ?3 AND storyboard_id = ?4",
        params![
            updated_at.to_rfc3339(),
            object_id,
            command.project_id.to_string(),
            command.storyboard_id.to_string(),
        ],
    )?;
    let result = SavedWorkspaceObjectPrompt {
        object_id,
        media_id: MediaId(
            Uuid::parse_str(&media_id)
                .map_err(|_| ProductError::Storage("invalid workspace media ID".to_owned()))?,
        ),
        object_type: WorkspaceObjectType::parse(&object_type)?,
        prompt: command.prompt,
        revision: actual_revision + 1,
    };
    append_event(
        &transaction,
        command.project_id,
        "media.updated",
        json!({
            "mediaId": result.media_id,
            "storyboardId": command.storyboard_id,
            "revision": result.revision,
        }),
    )?;
    remember(&transaction, &command.idempotency, &result)?;
    transaction.commit()?;
    Ok(result)
}

pub(super) fn undo_prompt(
    connection: &mut Connection,
    command: UndoWorkspaceObjectPrompt,
) -> ProductResult<SavedWorkspaceObjectPrompt> {
    let transaction = immediate(connection)?;
    if let Some(value) = replay(&transaction, &command.idempotency)? {
        return Ok(value);
    }
    let current = transaction
        .query_row(
            "SELECT node.id, node.object_type, media.id, media.revision
             FROM workspace_nodes node
             JOIN media_items media ON media.id = node.target_id
               AND media.project_id = node.project_id
               AND media.storyboard_id = node.storyboard_id
             WHERE (node.id = ?1 OR node.target_id = ?1)
               AND node.project_id = ?2 AND node.storyboard_id = ?3
               AND node.kind = 'object' AND node.object_type IN ('image', 'video')
               AND node.target_type = 'media' AND media.deleted_at IS NULL
             ORDER BY CASE WHEN node.id = ?1 THEN 0 ELSE 1 END
             LIMIT 1",
            params![
                command.target_id,
                command.project_id.to_string(),
                command.storyboard_id.to_string()
            ],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, i64>(3)?,
                ))
            },
        )
        .optional()?
        .ok_or(ProductError::NotFound)?;
    let (object_id, object_type, media_id, actual_revision) = current;
    if actual_revision != command.expected_revision {
        return Err(ProductError::RevisionConflict {
            expected: command.expected_revision,
            actual: actual_revision,
        });
    }
    let history = transaction
        .query_row(
            "SELECT id, prompt FROM workspace_object_prompt_history
             WHERE project_id = ?1 AND storyboard_id = ?2 AND object_id = ?3
               AND media_id = ?4 AND undone_at IS NULL
             ORDER BY id DESC LIMIT 1",
            params![
                command.project_id.to_string(),
                command.storyboard_id.to_string(),
                object_id,
                media_id,
            ],
            |row| Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?)),
        )
        .optional()?
        .ok_or_else(|| ProductError::Validation("no earlier prompt version is available".into()))?;
    let updated_at = Utc::now();
    let affected = transaction.execute(
        "UPDATE media_items SET prompt = ?1, revision = revision + 1, updated_at = ?2
         WHERE id = ?3 AND project_id = ?4 AND storyboard_id = ?5
           AND revision = ?6 AND deleted_at IS NULL",
        params![
            history.1,
            updated_at.to_rfc3339(),
            media_id,
            command.project_id.to_string(),
            command.storyboard_id.to_string(),
            command.expected_revision,
        ],
    )?;
    if affected != 1 {
        return Err(ProductError::RevisionConflict {
            expected: command.expected_revision,
            actual: actual_revision,
        });
    }
    transaction.execute(
        "UPDATE workspace_object_prompt_history SET undone_at = ?1 WHERE id = ?2",
        params![updated_at.to_rfc3339(), history.0],
    )?;
    transaction.execute(
        "UPDATE workspace_nodes SET unseen_update_at = NULL
         WHERE id = ?1 AND project_id = ?2 AND storyboard_id = ?3",
        params![
            object_id,
            command.project_id.to_string(),
            command.storyboard_id.to_string(),
        ],
    )?;
    let result = SavedWorkspaceObjectPrompt {
        object_id,
        media_id: MediaId(
            Uuid::parse_str(&media_id)
                .map_err(|_| ProductError::Storage("invalid workspace media ID".to_owned()))?,
        ),
        object_type: WorkspaceObjectType::parse(&object_type)?,
        prompt: history.1,
        revision: actual_revision + 1,
    };
    append_event(
        &transaction,
        command.project_id,
        "media.promptUndone",
        json!({
            "mediaId": result.media_id,
            "storyboardId": command.storyboard_id,
            "revision": result.revision,
        }),
    )?;
    remember(&transaction, &command.idempotency, &result)?;
    transaction.commit()?;
    Ok(result)
}
