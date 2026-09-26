use super::ProductDatabase;
use crate::product::application::media::{
    MediaCursor, MediaListQuery, MediaPage, MediaRepository, UpdateMediaMetadata,
};
use crate::product::domain::{
    AssetId, MediaId, MediaItem, MediaKind, MediaOwner, MediaRole, MediaStatus, ProductError,
    ProductResult, ProjectId, StoryboardId,
};
use async_trait::async_trait;
use chrono::{DateTime, Utc};
use rusqlite::types::{Type, Value};
use rusqlite::{params, params_from_iter, Connection, Row, TransactionBehavior};
use std::convert::TryFrom;
use uuid::Uuid;

const MEDIA_COLUMNS: &str = "id, project_id, asset_id, storyboard_id, kind, role, name, prompt, \
    mime_type, source_object_key, thumbnail_object_key, width, height, duration_ms, status, \
    revision, created_at, updated_at, deleted_at";

#[derive(Clone, Debug)]
pub struct SqliteMediaRepository {
    database: ProductDatabase,
}

impl SqliteMediaRepository {
    pub fn new(database: ProductDatabase) -> Self {
        Self { database }
    }

    async fn run<T, F>(&self, operation: F) -> ProductResult<T>
    where
        T: Send + 'static,
        F: FnOnce(Connection) -> ProductResult<T> + Send + 'static,
    {
        let database = self.database.clone();
        tokio::task::spawn_blocking(move || operation(database.connect()?))
            .await
            .map_err(|error| ProductError::Storage(error.to_string()))?
    }
}

#[async_trait]
impl MediaRepository for SqliteMediaRepository {
    async fn find_media(
        &self,
        project_id: ProjectId,
        id: MediaId,
    ) -> ProductResult<Option<MediaItem>> {
        self.run(move |connection| find_media(&connection, project_id, id))
            .await
    }

    async fn list_storyboard_media(&self, query: &MediaListQuery) -> ProductResult<MediaPage> {
        let query = query.clone();
        self.run(move |connection| list_storyboard_media(&connection, &query))
            .await
    }

    async fn insert_media(&self, media: &MediaItem) -> ProductResult<()> {
        let media = media.clone();
        self.run(move |connection| insert_media(&connection, &media))
            .await
    }

    async fn update_media_metadata(
        &self,
        update: &UpdateMediaMetadata,
    ) -> ProductResult<MediaItem> {
        let update = update.clone();
        self.run(move |mut connection| update_media_metadata(&mut connection, &update))
            .await
    }

    async fn soft_delete_storyboard_media(
        &self,
        project_id: ProjectId,
        media_id: MediaId,
        expected_revision: i64,
    ) -> ProductResult<()> {
        self.run(move |mut connection| {
            soft_delete_storyboard_media(&mut connection, project_id, media_id, expected_revision)
        })
        .await
    }
}

fn find_media(
    connection: &Connection,
    project_id: ProjectId,
    media_id: MediaId,
) -> ProductResult<Option<MediaItem>> {
    let sql = format!(
        "SELECT {MEDIA_COLUMNS} FROM media_items \
         WHERE id = ?1 AND project_id = ?2 AND deleted_at IS NULL"
    );
    let mut statement = connection.prepare(&sql)?;
    let mut rows = statement.query(params![media_id.to_string(), project_id.to_string()])?;
    rows.next()?.map(map_media).transpose().map_err(Into::into)
}

fn list_storyboard_media(
    connection: &Connection,
    query: &MediaListQuery,
) -> ProductResult<MediaPage> {
    let exists: bool = connection.query_row(
        "SELECT EXISTS(SELECT 1 FROM storyboards \
         WHERE id = ?1 AND project_id = ?2 AND deleted_at IS NULL)",
        params![
            query.storyboard_id.to_string(),
            query.project_id.to_string()
        ],
        |row| row.get(0),
    )?;
    if !exists {
        return Err(ProductError::NotFound);
    }

    let (base_filter, base_values) = media_filter(query);
    let count_sql = format!("SELECT COUNT(*) FROM media_items WHERE {base_filter}");
    let total: i64 =
        connection.query_row(&count_sql, params_from_iter(base_values.iter()), |row| {
            row.get(0)
        })?;

    let mut page_filter = base_filter;
    let mut page_values = base_values;
    if let Some(cursor) = &query.cursor {
        page_filter.push_str(" AND (created_at < ? OR (created_at = ? AND id < ?))");
        let created_at = cursor.created_at.to_rfc3339();
        page_values.push(Value::Text(created_at.clone()));
        page_values.push(Value::Text(created_at));
        page_values.push(Value::Text(cursor.id.to_string()));
    }
    page_values.push(Value::Integer((query.limit.saturating_add(1)) as i64));
    let page_sql = format!(
        "SELECT {MEDIA_COLUMNS} FROM media_items WHERE {page_filter} \
         ORDER BY created_at DESC, id DESC LIMIT ?"
    );
    let mut statement = connection.prepare(&page_sql)?;
    let mut items = statement
        .query_map(params_from_iter(page_values.iter()), map_media)?
        .collect::<Result<Vec<_>, _>>()?;
    let has_more = items.len() > query.limit;
    items.truncate(query.limit);
    let next_cursor = has_more.then(|| {
        let last = items.last().expect("a page with more results is not empty");
        MediaCursor {
            created_at: last.created_at,
            id: last.id,
        }
        .encode()
    });
    Ok(MediaPage {
        items,
        next_cursor,
        total: usize::try_from(total)
            .map_err(|_| ProductError::Storage("media count exceeds platform size".into()))?,
    })
}

fn media_filter(query: &MediaListQuery) -> (String, Vec<Value>) {
    let mut filter = "project_id = ? AND storyboard_id = ? AND deleted_at IS NULL".to_owned();
    let mut values = vec![
        Value::Text(query.project_id.to_string()),
        Value::Text(query.storyboard_id.to_string()),
    ];
    if !query.roles.is_empty() {
        filter.push_str(" AND role IN (");
        filter.push_str(&vec!["?"; query.roles.len()].join(", "));
        filter.push(')');
        values.extend(
            query
                .roles
                .iter()
                .map(|role| Value::Text(role.as_storage_str().to_owned())),
        );
    }
    (filter, values)
}

fn insert_media(connection: &Connection, media: &MediaItem) -> ProductResult<()> {
    let (asset_id, storyboard_id) = match media.owner {
        MediaOwner::Asset { asset_id } => (Some(asset_id.to_string()), None),
        MediaOwner::Storyboard { storyboard_id } => (None, Some(storyboard_id.to_string())),
    };
    connection.execute(
        "INSERT INTO media_items (id, project_id, asset_id, storyboard_id, kind, role, name, \
         prompt, mime_type, source_object_key, thumbnail_object_key, width, height, duration_ms, \
         status, revision, created_at, updated_at, deleted_at) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19)",
        params![
            media.id.to_string(),
            media.project_id.to_string(),
            asset_id,
            storyboard_id,
            media.kind.as_storage_str(),
            media.role.as_storage_str(),
            media.name,
            media.prompt,
            media.mime_type,
            media.source_object_key,
            media.thumbnail_object_key,
            media.width,
            media.height,
            media.duration_ms,
            media.status.as_storage_str(),
            media.revision,
            media.created_at.to_rfc3339(),
            media.updated_at.to_rfc3339(),
            media.deleted_at.map(|value| value.to_rfc3339()),
        ],
    )?;
    Ok(())
}

fn update_media_metadata(
    connection: &mut Connection,
    update: &UpdateMediaMetadata,
) -> ProductResult<MediaItem> {
    let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let current = find_media(&transaction, update.project_id, update.media_id)?
        .ok_or(ProductError::NotFound)?;
    if current.revision != update.expected_revision {
        return Err(ProductError::RevisionConflict {
            expected: update.expected_revision,
            actual: current.revision,
        });
    }
    let updated_at = Utc::now().to_rfc3339();
    let affected = transaction.execute(
        "UPDATE media_items SET name = ?1, prompt = ?2, revision = revision + 1, updated_at = ?3 \
         WHERE id = ?4 AND project_id = ?5 AND revision = ?6 AND deleted_at IS NULL",
        params![
            update.name,
            update.prompt,
            updated_at,
            update.media_id.to_string(),
            update.project_id.to_string(),
            update.expected_revision,
        ],
    )?;
    if affected != 1 {
        return Err(ProductError::RevisionConflict {
            expected: update.expected_revision,
            actual: current.revision,
        });
    }
    let media = find_media(&transaction, update.project_id, update.media_id)?
        .ok_or(ProductError::NotFound)?;
    transaction.commit()?;
    Ok(media)
}

fn soft_delete_storyboard_media(
    connection: &mut Connection,
    project_id: ProjectId,
    media_id: MediaId,
    expected_revision: i64,
) -> ProductResult<()> {
    let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let current = find_media(&transaction, project_id, media_id)?.ok_or(ProductError::NotFound)?;
    if current.storyboard_id().is_none() {
        return Err(ProductError::Conflict {
            code: "MEDIA_NOT_STORYBOARD_OWNED",
            message: "shared asset media cannot be deleted from a storyboard endpoint".into(),
        });
    }
    if current.revision != expected_revision {
        return Err(ProductError::RevisionConflict {
            expected: expected_revision,
            actual: current.revision,
        });
    }
    let in_use: bool = transaction.query_row(
        "SELECT EXISTS(SELECT 1 FROM asset_bindings WHERE derived_media_id = ?1)",
        [media_id.to_string()],
        |row| row.get(0),
    )?;
    if in_use {
        return Err(ProductError::Conflict {
            code: "MEDIA_IN_USE",
            message: "media is still used by a storyboard asset binding".into(),
        });
    }
    let affected = transaction.execute(
        "UPDATE media_items SET deleted_at = ?1, updated_at = ?1, revision = revision + 1 \
         WHERE id = ?2 AND project_id = ?3 AND revision = ?4 AND deleted_at IS NULL",
        params![
            Utc::now().to_rfc3339(),
            media_id.to_string(),
            project_id.to_string(),
            expected_revision,
        ],
    )?;
    if affected != 1 {
        return Err(ProductError::RevisionConflict {
            expected: expected_revision,
            actual: current.revision,
        });
    }
    transaction.commit()?;
    Ok(())
}

fn map_media(row: &Row<'_>) -> rusqlite::Result<MediaItem> {
    let id = media_id(row.get::<_, String>(0)?, 0)?;
    let project_id = project_id(row.get::<_, String>(1)?, 1)?;
    let asset_id = row
        .get::<_, Option<String>>(2)?
        .map(|value| asset_id(value, 2))
        .transpose()?;
    let storyboard_id = row
        .get::<_, Option<String>>(3)?
        .map(|value| storyboard_id(value, 3))
        .transpose()?;
    let owner = match (asset_id, storyboard_id) {
        (Some(asset_id), None) => MediaOwner::Asset { asset_id },
        (None, Some(storyboard_id)) => MediaOwner::Storyboard { storyboard_id },
        _ => return Err(conversion_error(3, "media owner is invalid")),
    };
    let kind_text = row.get::<_, String>(4)?;
    let kind = MediaKind::from_storage_str(&kind_text)
        .ok_or_else(|| conversion_error(4, "unknown media kind"))?;
    let role_text = row.get::<_, String>(5)?;
    let role = MediaRole::from_api_str(&role_text)
        .ok_or_else(|| conversion_error(5, "unknown media role"))?;
    let status_text = row.get::<_, String>(14)?;
    let status = MediaStatus::from_storage_str(&status_text)
        .ok_or_else(|| conversion_error(14, "unknown media status"))?;
    Ok(MediaItem {
        id,
        project_id,
        owner,
        kind,
        role,
        name: row.get(6)?,
        prompt: row.get(7)?,
        mime_type: row.get(8)?,
        source_object_key: row.get(9)?,
        thumbnail_object_key: row.get(10)?,
        width: row.get(11)?,
        height: row.get(12)?,
        duration_ms: row.get(13)?,
        status,
        revision: row.get(15)?,
        created_at: date_time(row.get(16)?, 16)?,
        updated_at: date_time(row.get(17)?, 17)?,
        deleted_at: row
            .get::<_, Option<String>>(18)?
            .map(|value| date_time(value, 18))
            .transpose()?,
    })
}

fn media_id(value: String, index: usize) -> rusqlite::Result<MediaId> {
    parse_uuid(value, index).map(MediaId)
}

fn project_id(value: String, index: usize) -> rusqlite::Result<ProjectId> {
    parse_uuid(value, index).map(ProjectId)
}

fn asset_id(value: String, index: usize) -> rusqlite::Result<AssetId> {
    parse_uuid(value, index).map(AssetId)
}

fn storyboard_id(value: String, index: usize) -> rusqlite::Result<StoryboardId> {
    parse_uuid(value, index).map(StoryboardId)
}

fn parse_uuid(value: String, index: usize) -> rusqlite::Result<Uuid> {
    Uuid::parse_str(&value).map_err(|error| {
        rusqlite::Error::FromSqlConversionFailure(index, Type::Text, Box::new(error))
    })
}

fn date_time(value: String, index: usize) -> rusqlite::Result<DateTime<Utc>> {
    DateTime::parse_from_rfc3339(&value)
        .map(|value| value.with_timezone(&Utc))
        .map_err(|error| {
            rusqlite::Error::FromSqlConversionFailure(index, Type::Text, Box::new(error))
        })
}

fn conversion_error(index: usize, message: &'static str) -> rusqlite::Error {
    rusqlite::Error::FromSqlConversionFailure(
        index,
        Type::Text,
        Box::new(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            message,
        )),
    )
}
