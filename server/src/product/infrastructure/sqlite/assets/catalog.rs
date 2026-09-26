use super::mapping::{asset_view_from_row, load_asset_view};
use crate::product::application::assets::{
    AssetPage, AssetQuery, AssetView, CreateAsset, CreateRepresentation, UpdateAsset,
};
use crate::product::domain::{AssetId, ProductError, ProductResult, ProjectId};
use crate::product::infrastructure::sqlite::support::{
    append_event, immediate, next_position, remember, replay, revision_error,
};
use chrono::Utc;
use rusqlite::types::Value;
use rusqlite::{params, params_from_iter, Connection, OptionalExtension, Transaction};
use serde_json::json;

const ASSET_VIEW_COLUMNS: &str =
    "a.id, a.project_id, a.kind, a.name, a.description, a.canonical_prompt,
     a.revision, a.created_at, a.updated_at, a.deleted_at,
     (SELECT COUNT(*) FROM asset_bindings b WHERE b.asset_id = a.id)";

pub(super) fn list(connection: &Connection, query: AssetQuery) -> ProductResult<AssetPage> {
    ensure_project(connection, query.project_id)?;
    let mut filter = "a.project_id = ? AND a.deleted_at IS NULL".to_owned();
    let mut values = vec![Value::Text(query.project_id.to_string())];
    if let Some(kind) = query.kind {
        filter.push_str(" AND a.kind = ?");
        values.push(Value::Text(kind.as_str().to_owned()));
    }
    if let Some(search) = query.query {
        filter.push_str(
            " AND (a.name LIKE ? ESCAPE '\\' OR COALESCE(a.description, '') LIKE ? ESCAPE '\\')",
        );
        let search = format!("%{}%", escape_like(&search));
        values.push(Value::Text(search.clone()));
        values.push(Value::Text(search));
    }
    let total: i64 = connection.query_row(
        &format!("SELECT COUNT(*) FROM assets a WHERE {filter}"),
        params_from_iter(values.iter()),
        |row| row.get(0),
    )?;
    if let Some(cursor) = query.cursor {
        let cursor_name = connection
            .query_row(
                "SELECT name FROM assets WHERE id = ?1 AND project_id = ?2 AND deleted_at IS NULL",
                params![cursor.to_string(), query.project_id.to_string()],
                |row| row.get::<_, String>(0),
            )
            .optional()?
            .ok_or_else(|| ProductError::Validation("invalid asset cursor".to_owned()))?;
        filter
            .push_str(" AND (lower(a.name) > lower(?) OR (lower(a.name) = lower(?) AND a.id > ?))");
        values.push(Value::Text(cursor_name.clone()));
        values.push(Value::Text(cursor_name));
        values.push(Value::Text(cursor.to_string()));
    }
    values.push(Value::Integer(query.limit.saturating_add(1) as i64));
    let sql = format!(
        "SELECT {ASSET_VIEW_COLUMNS} FROM assets a WHERE {filter}
         ORDER BY lower(a.name), a.id LIMIT ?"
    );
    let mut statement = connection.prepare(&sql)?;
    let mut items = statement
        .query_map(params_from_iter(values.iter()), asset_view_from_row)?
        .collect::<Result<Vec<_>, _>>()?;
    let has_more = items.len() > query.limit;
    items.truncate(query.limit);
    for item in &mut items {
        item.asset.representations = load_asset_view(connection, query.project_id, item.asset.id)?
            .map(|view| view.asset.representations)
            .unwrap_or_default();
    }
    let next_cursor = has_more
        .then(|| items.last().map(|view| view.asset.id.to_string()))
        .flatten();
    Ok(AssetPage {
        items,
        next_cursor,
        total: total.try_into().unwrap_or_default(),
    })
}

pub(super) fn create(
    connection: &mut Connection,
    command: CreateAsset,
) -> ProductResult<AssetView> {
    let transaction = immediate(connection)?;
    if let Some(value) = replay(&transaction, &command.idempotency)? {
        return Ok(value);
    }
    ensure_project(&transaction, command.asset.project_id)?;
    transaction.execute(
        "INSERT INTO assets
         (id, project_id, kind, name, description, canonical_prompt, revision, created_at, updated_at, deleted_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, NULL)",
        params![
            command.asset.id.to_string(),
            command.asset.project_id.to_string(),
            command.asset.kind.as_str(),
            command.asset.name,
            command.asset.description,
            command.asset.canonical_prompt,
            command.asset.revision,
            command.asset.created_at.to_rfc3339(),
            command.asset.updated_at.to_rfc3339(),
        ],
    )?;
    let view = required_asset(&transaction, command.asset.project_id, command.asset.id)?;
    append_event(
        &transaction,
        command.asset.project_id,
        "asset.created",
        json!({ "assetId": command.asset.id }),
    )?;
    remember(&transaction, &command.idempotency, &view)?;
    transaction.commit()?;
    Ok(view)
}

pub(super) fn update(
    connection: &mut Connection,
    command: UpdateAsset,
) -> ProductResult<AssetView> {
    let transaction = immediate(connection)?;
    let changed = transaction.execute(
        "UPDATE assets SET kind = ?1, name = ?2, description = ?3, canonical_prompt = ?4,
                revision = revision + 1, updated_at = ?5
         WHERE id = ?6 AND project_id = ?7 AND deleted_at IS NULL AND revision = ?8",
        params![
            command.kind.as_str(),
            command.name,
            command.description,
            command.canonical_prompt,
            Utc::now().to_rfc3339(),
            command.asset_id.to_string(),
            command.project_id.to_string(),
            command.expected_revision,
        ],
    )?;
    if changed == 0 {
        return Err(revision_error(
            asset_revision(&transaction, command.project_id, command.asset_id)?,
            command.expected_revision,
        ));
    }
    let view = required_asset(&transaction, command.project_id, command.asset_id)?;
    append_event(
        &transaction,
        command.project_id,
        "asset.updated",
        json!({ "assetId": command.asset_id }),
    )?;
    transaction.commit()?;
    Ok(view)
}

pub(super) fn delete(
    connection: &mut Connection,
    project_id: ProjectId,
    asset_id: AssetId,
    expected_revision: i64,
) -> ProductResult<()> {
    let transaction = immediate(connection)?;
    let reference_count: i64 = transaction.query_row(
        "SELECT COUNT(*) FROM asset_bindings WHERE asset_id = ?1 AND project_id = ?2",
        params![asset_id.to_string(), project_id.to_string()],
        |row| row.get(0),
    )?;
    if reference_count > 0 {
        return Err(ProductError::Conflict {
            code: "ASSET_IN_USE",
            message: "asset must be detached from every storyboard before deletion".to_owned(),
        });
    }
    let changed = transaction.execute(
        "UPDATE assets SET deleted_at = ?1, updated_at = ?1, revision = revision + 1
         WHERE id = ?2 AND project_id = ?3 AND deleted_at IS NULL AND revision = ?4",
        params![
            Utc::now().to_rfc3339(),
            asset_id.to_string(),
            project_id.to_string(),
            expected_revision
        ],
    )?;
    if changed == 0 {
        return Err(revision_error(
            asset_revision(&transaction, project_id, asset_id)?,
            expected_revision,
        ));
    }
    append_event(
        &transaction,
        project_id,
        "asset.deleted",
        json!({ "assetId": asset_id }),
    )?;
    transaction.commit()?;
    Ok(())
}

pub(super) fn create_representation(
    connection: &mut Connection,
    mut command: CreateRepresentation,
) -> ProductResult<AssetView> {
    let transaction = immediate(connection)?;
    if let Some(value) = replay(&transaction, &command.idempotency)? {
        return Ok(value);
    }
    required_asset(
        &transaction,
        command.project_id,
        command.representation.asset_id,
    )?;
    command.representation.position = next_position(
        &transaction,
        "asset_representations",
        "asset_id",
        &command.representation.asset_id.to_string(),
    )?;
    let now = Utc::now().to_rfc3339();
    transaction.execute(
        "INSERT INTO asset_representations
         (id, project_id, asset_id, label, view_kind, media_id, position, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?8)",
        params![
            command.representation.id.to_string(),
            command.project_id.to_string(),
            command.representation.asset_id.to_string(),
            command.representation.label,
            command.representation.view_kind.as_str(),
            command.representation.media_id.map(|id| id.to_string()),
            command.representation.position,
            now,
        ],
    )?;
    transaction.execute(
        "UPDATE assets SET revision = revision + 1, updated_at = ?1
         WHERE id = ?2 AND project_id = ?3",
        params![
            now,
            command.representation.asset_id.to_string(),
            command.project_id.to_string()
        ],
    )?;
    let view = required_asset(
        &transaction,
        command.project_id,
        command.representation.asset_id,
    )?;
    append_event(
        &transaction,
        command.project_id,
        "assetRepresentation.created",
        json!({
            "assetId": command.representation.asset_id,
            "representationId": command.representation.id
        }),
    )?;
    remember(&transaction, &command.idempotency, &view)?;
    transaction.commit()?;
    Ok(view)
}

fn ensure_project(connection: &Connection, project_id: ProjectId) -> ProductResult<()> {
    let exists: bool = connection.query_row(
        "SELECT EXISTS(SELECT 1 FROM projects WHERE id = ?1)",
        [project_id.to_string()],
        |row| row.get(0),
    )?;
    if exists {
        Ok(())
    } else {
        Err(ProductError::NotFound)
    }
}

fn required_asset(
    connection: &Connection,
    project_id: ProjectId,
    asset_id: AssetId,
) -> ProductResult<AssetView> {
    load_asset_view(connection, project_id, asset_id)?.ok_or(ProductError::NotFound)
}

fn asset_revision(
    transaction: &Transaction<'_>,
    project_id: ProjectId,
    asset_id: AssetId,
) -> ProductResult<Option<i64>> {
    transaction
        .query_row(
            "SELECT revision FROM assets WHERE id = ?1 AND project_id = ?2 AND deleted_at IS NULL",
            params![asset_id.to_string(), project_id.to_string()],
            |row| row.get(0),
        )
        .optional()
        .map_err(Into::into)
}

fn escape_like(value: &str) -> String {
    value
        .replace('\\', "\\\\")
        .replace('%', "\\%")
        .replace('_', "\\_")
}
