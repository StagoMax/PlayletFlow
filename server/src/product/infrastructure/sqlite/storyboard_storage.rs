use crate::product::domain::{
    ProductError, ProductResult, Project, ProjectId, Storyboard, StoryboardCatalogEntry,
    StoryboardCounts, StoryboardId, StoryboardScript, StoryboardSnapshot,
};
use crate::product::infrastructure::sqlite::support::{
    format_position, optional_time_from_row, time_from_row, uuid_from_row, POSITION_STEP,
};
use rusqlite::{params, Connection, OptionalExtension, Row, Transaction};

pub(super) fn insert_project(
    transaction: &Transaction<'_>,
    project: &Project,
) -> ProductResult<()> {
    transaction.execute(
        "INSERT INTO projects (id, name, revision, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5)",
        params![
            project.id.to_string(),
            project.name,
            project.revision,
            project.created_at.to_rfc3339(),
            project.updated_at.to_rfc3339()
        ],
    )?;
    Ok(())
}

pub(super) fn insert_storyboard(
    transaction: &Transaction<'_>,
    storyboard: &Storyboard,
) -> ProductResult<()> {
    transaction.execute(
        "INSERT INTO storyboards
         (id, project_id, name, position, revision, created_at, updated_at, deleted_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
        params![
            storyboard.id.to_string(),
            storyboard.project_id.to_string(),
            storyboard.name,
            storyboard.position,
            storyboard.revision,
            storyboard.created_at.to_rfc3339(),
            storyboard.updated_at.to_rfc3339(),
            storyboard.deleted_at.map(|value| value.to_rfc3339())
        ],
    )?;
    Ok(())
}

pub(super) fn insert_script(
    transaction: &Transaction<'_>,
    script: &StoryboardScript,
) -> ProductResult<()> {
    transaction.execute(
        "INSERT INTO storyboard_scripts (storyboard_id, text, revision, updated_at)
         VALUES (?1, ?2, ?3, ?4)",
        params![
            script.storyboard_id.to_string(),
            script.text,
            script.revision,
            script.updated_at.to_rfc3339()
        ],
    )?;
    Ok(())
}

pub(super) fn insert_default_workspace_nodes(
    transaction: &Transaction<'_>,
    storyboard: &Storyboard,
) -> ProductResult<()> {
    let storyboard_id = storyboard.id.to_string();
    let project_id = storyboard.project_id.to_string();
    let now = storyboard.created_at.to_rfc3339();
    let script_folder = format!("folder-script-{storyboard_id}");
    for (index, (id, name)) in [
        (script_folder.clone(), "脚本"),
        (format!("folder-assets-{storyboard_id}"), "资产"),
        (format!("folder-video-{storyboard_id}"), "视频"),
    ]
    .into_iter()
    .enumerate()
    {
        transaction.execute(
            "INSERT INTO workspace_nodes
             (id, project_id, storyboard_id, parent_id, kind, name, position, revision, created_at, updated_at)
             VALUES (?1, ?2, ?3, NULL, 'folder', ?4, ?5, 1, ?6, ?6)",
            params![id, project_id, storyboard_id, name,
                format_position((index as u64 + 1) * POSITION_STEP), now],
        )?;
    }
    transaction.execute(
        "INSERT INTO workspace_nodes
         (id, project_id, storyboard_id, parent_id, kind, name, object_type,
          target_type, target_id, position, revision, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, 'object', '该片段的脚本', 'text',
                 'script', ?3, ?5, 1, ?6, ?6)",
        params![
            format!("script-{storyboard_id}"),
            project_id,
            storyboard_id,
            script_folder,
            format_position(4 * POSITION_STEP),
            now
        ],
    )?;
    Ok(())
}

pub(super) fn load_project(
    connection: &Connection,
    id: ProjectId,
) -> ProductResult<Option<Project>> {
    connection
        .query_row(
            "SELECT id, name, revision, created_at, updated_at FROM projects WHERE id = ?1",
            [id.to_string()],
            project_from_row,
        )
        .optional()
        .map_err(Into::into)
}

pub(super) fn project_from_row(row: &Row<'_>) -> rusqlite::Result<Project> {
    Ok(Project {
        id: ProjectId(uuid_from_row(row, 0)?),
        name: row.get(1)?,
        revision: row.get(2)?,
        created_at: time_from_row(row, 3)?,
        updated_at: time_from_row(row, 4)?,
    })
}

pub(super) fn load_storyboard_entries(
    connection: &Connection,
    project_id: ProjectId,
) -> ProductResult<Vec<StoryboardCatalogEntry>> {
    let mut statement = connection.prepare(
        "SELECT s.id, s.project_id, s.name, s.position, s.revision,
                s.created_at, s.updated_at, s.deleted_at,
                (SELECT COUNT(*) FROM change_proposals p
                 WHERE p.storyboard_id = s.id AND p.status IN ('pending', 'conflicted'))
         FROM storyboards s
         WHERE s.project_id = ?1 AND s.deleted_at IS NULL
         ORDER BY s.position, s.id",
    )?;
    let entries = statement
        .query_map([project_id.to_string()], storyboard_entry_from_row)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(Into::into);
    entries
}

pub(super) fn load_storyboard(
    connection: &Connection,
    project_id: ProjectId,
    storyboard_id: StoryboardId,
    include_deleted: bool,
) -> ProductResult<Option<Storyboard>> {
    let sql = if include_deleted {
        "SELECT id, project_id, name, position, revision, created_at, updated_at, deleted_at
         FROM storyboards WHERE id = ?1 AND project_id = ?2"
    } else {
        "SELECT id, project_id, name, position, revision, created_at, updated_at, deleted_at
         FROM storyboards WHERE id = ?1 AND project_id = ?2 AND deleted_at IS NULL"
    };
    connection
        .query_row(
            sql,
            params![storyboard_id.to_string(), project_id.to_string()],
            storyboard_from_row,
        )
        .optional()
        .map_err(Into::into)
}

pub(super) fn load_storyboard_snapshot(
    connection: &Connection,
    project_id: ProjectId,
    storyboard_id: StoryboardId,
    include_deleted: bool,
) -> ProductResult<Option<StoryboardSnapshot>> {
    let Some(storyboard) = load_storyboard(connection, project_id, storyboard_id, include_deleted)?
    else {
        return Ok(None);
    };
    let pending_proposal_count = connection.query_row(
        "SELECT COUNT(*) FROM change_proposals
         WHERE storyboard_id = ?1 AND status IN ('pending', 'conflicted')",
        [storyboard_id.to_string()],
        |row| row.get::<_, u64>(0),
    )?;
    let script = load_script(connection, storyboard_id)?.ok_or(ProductError::NotFound)?;
    let counts = StoryboardCounts {
        asset_bindings: connection.query_row(
            "SELECT COUNT(*) FROM asset_bindings WHERE storyboard_id = ?1",
            [storyboard_id.to_string()],
            |row| row.get(0),
        )?,
        keyframes: connection.query_row(
            "SELECT COUNT(*) FROM media_items
             WHERE storyboard_id = ?1 AND deleted_at IS NULL
               AND role IN ('firstFrame', 'lastFrame', 'keyframe')",
            [storyboard_id.to_string()],
            |row| row.get(0),
        )?,
        videos: connection.query_row(
            "SELECT COUNT(*) FROM media_items
             WHERE storyboard_id = ?1 AND deleted_at IS NULL AND role = 'generatedVideo'",
            [storyboard_id.to_string()],
            |row| row.get(0),
        )?,
    };
    Ok(Some(StoryboardSnapshot {
        entry: StoryboardCatalogEntry {
            storyboard,
            pending_proposal_count,
        },
        script,
        counts,
    }))
}

pub(super) fn storyboard_entry_from_row(row: &Row<'_>) -> rusqlite::Result<StoryboardCatalogEntry> {
    Ok(StoryboardCatalogEntry {
        storyboard: storyboard_from_row(row)?,
        pending_proposal_count: row.get(8)?,
    })
}

pub(super) fn storyboard_from_row(row: &Row<'_>) -> rusqlite::Result<Storyboard> {
    Ok(Storyboard {
        id: StoryboardId(uuid_from_row(row, 0)?),
        project_id: ProjectId(uuid_from_row(row, 1)?),
        name: row.get(2)?,
        position: row.get(3)?,
        revision: row.get(4)?,
        created_at: time_from_row(row, 5)?,
        updated_at: time_from_row(row, 6)?,
        deleted_at: optional_time_from_row(row, 7)?,
    })
}

pub(super) fn load_script(
    connection: &Connection,
    storyboard_id: StoryboardId,
) -> ProductResult<Option<StoryboardScript>> {
    connection
        .query_row(
            "SELECT storyboard_id, text, revision, updated_at
             FROM storyboard_scripts WHERE storyboard_id = ?1",
            [storyboard_id.to_string()],
            |row| {
                Ok(StoryboardScript {
                    storyboard_id: StoryboardId(uuid_from_row(row, 0)?),
                    text: row.get(1)?,
                    revision: row.get(2)?,
                    updated_at: time_from_row(row, 3)?,
                })
            },
        )
        .optional()
        .map_err(Into::into)
}

pub(super) fn require_project(connection: &Connection, project_id: ProjectId) -> ProductResult<()> {
    if load_project(connection, project_id)?.is_none() {
        return Err(ProductError::NotFound);
    }
    Ok(())
}

pub(super) fn require_active_storyboard(
    connection: &Connection,
    project_id: ProjectId,
    storyboard_id: StoryboardId,
) -> ProductResult<()> {
    if load_storyboard(connection, project_id, storyboard_id, false)?.is_none() {
        return Err(ProductError::NotFound);
    }
    Ok(())
}

pub(super) fn project_write_error(
    connection: &Connection,
    id: ProjectId,
    expected: i64,
) -> ProductResult<ProductError> {
    Ok(match load_project(connection, id)? {
        Some(project) => ProductError::RevisionConflict {
            expected,
            actual: project.revision,
        },
        None => ProductError::NotFound,
    })
}

pub(super) fn storyboard_write_error(
    connection: &Connection,
    project_id: ProjectId,
    storyboard_id: StoryboardId,
    expected: i64,
    include_deleted: bool,
) -> ProductResult<ProductError> {
    Ok(
        match load_storyboard(connection, project_id, storyboard_id, include_deleted)? {
            Some(storyboard) => ProductError::RevisionConflict {
                expected,
                actual: storyboard.revision,
            },
            None => ProductError::NotFound,
        },
    )
}
