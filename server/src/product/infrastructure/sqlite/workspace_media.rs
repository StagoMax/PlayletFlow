use super::ProductDatabase;
use crate::product::domain::{MediaId, ProductError, ProductResult, ProjectId, StoryboardId};
use rusqlite::{params, OptionalExtension, TransactionBehavior};
use uuid::Uuid;

#[derive(Clone)]
pub struct SqliteWorkspaceMediaRepository {
    database: ProductDatabase,
}

impl SqliteWorkspaceMediaRepository {
    pub fn new(database: ProductDatabase) -> Self {
        Self { database }
    }

    #[allow(clippy::too_many_arguments)]
    pub async fn insert_generation_input(
        &self,
        project_id: ProjectId,
        storyboard_id: StoryboardId,
        media_id: MediaId,
        name: String,
        object_key: String,
        mime_type: String,
        width: i64,
        height: i64,
    ) -> ProductResult<()> {
        let database = self.database.clone();
        tokio::task::spawn_blocking(move || {
            let connection = database.connect()?;
            let now = chrono::Utc::now().to_rfc3339();
            connection.execute(
                "INSERT OR IGNORE INTO media_items (id, project_id, storyboard_id, kind, role, name, \
                 mime_type, source_object_key, width, height, status, revision, created_at, updated_at) \
                 VALUES (?1, ?2, ?3, 'image', 'custom', ?4, ?5, ?6, ?7, ?8, 'ready', 1, ?9, ?9)",
                params![media_id.to_string(), project_id.to_string(), storyboard_id.to_string(),
                    name, mime_type, object_key, width, height, now],
            )?;
            let matches: bool = connection.query_row(
                "SELECT EXISTS(SELECT 1 FROM media_items WHERE id = ?1 AND project_id = ?2 \
                 AND storyboard_id = ?3 AND source_object_key = ?4 AND kind = 'image' AND status = 'ready')",
                params![media_id.to_string(), project_id.to_string(), storyboard_id.to_string(), object_key],
                |row| row.get(0),
            )?;
            if !matches {
                return Err(ProductError::Validation("generation input ID is already in use".into()));
            }
            Ok(())
        })
        .await
        .map_err(|error| ProductError::Storage(error.to_string()))?
    }

    pub async fn ensure(
        &self,
        project_id: ProjectId,
        storyboard_id: StoryboardId,
        node_id: String,
    ) -> ProductResult<MediaId> {
        let database = self.database.clone();
        tokio::task::spawn_blocking(move || {
            let mut connection = database.connect()?;
            let transaction =
                connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
            let (kind, name, target_type, target_id): (String, String, String, Option<String>) =
                transaction
                    .query_row(
                        "SELECT object_type, name, target_type, target_id FROM workspace_nodes \
                     WHERE id = ?1 AND project_id = ?2 AND storyboard_id = ?3 AND kind = 'object'",
                        params![node_id, project_id.to_string(), storyboard_id.to_string()],
                        |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
                    )
                    .optional()?
                    .ok_or(ProductError::NotFound)?;
            let mime_type = match kind.as_str() {
                "image" => "image/png",
                "video" => "video/mp4",
                _ => {
                    return Err(ProductError::Validation(
                        "this object cannot contain media".into(),
                    ))
                }
            };
            if target_type == "media" {
                let id = target_id
                    .ok_or_else(|| ProductError::Storage("media target is missing".into()))?;
                let id = Uuid::parse_str(&id)
                    .map_err(|_| ProductError::Storage("invalid media target".into()))?;
                return Ok(MediaId(id));
            }
            if target_type != "empty" {
                return Err(ProductError::Validation(
                    "this object cannot contain media".into(),
                ));
            }
            let media_id = MediaId(
                Uuid::parse_str(&node_id)
                    .map_err(|_| ProductError::Validation("object id must be a UUID".into()))?,
            );
            let now = chrono::Utc::now().to_rfc3339();
            transaction.execute(
                "INSERT INTO media_items (id, project_id, storyboard_id, kind, role, name, \
                 mime_type, status, revision, created_at, updated_at) \
                 VALUES (?1, ?2, ?3, ?4, 'custom', ?5, ?6, 'placeholder', 1, ?7, ?7)",
                params![
                    media_id.to_string(),
                    project_id.to_string(),
                    storyboard_id.to_string(),
                    kind,
                    name,
                    mime_type,
                    now
                ],
            )?;
            transaction.execute(
                "UPDATE workspace_nodes SET target_type = 'media', target_id = ?1, \
                 revision = revision + 1, updated_at = ?2 WHERE id = ?3",
                params![media_id.to_string(), now, node_id],
            )?;
            transaction.commit()?;
            Ok(media_id)
        })
        .await
        .map_err(|error| ProductError::Storage(error.to_string()))?
    }

    #[allow(clippy::too_many_arguments)]
    pub async fn attach_upload(
        &self,
        project_id: ProjectId,
        storyboard_id: StoryboardId,
        node_id: String,
        media_id: MediaId,
        object_key: String,
        mime_type: String,
        width: i64,
        height: i64,
        duration_ms: Option<i64>,
    ) -> ProductResult<()> {
        let database = self.database.clone();
        tokio::task::spawn_blocking(move || {
            let connection = database.connect()?;
            let affected = connection.execute(
                "UPDATE media_items SET source_object_key = ?1, thumbnail_object_key = NULL, \
                 mime_type = ?2, width = ?3, height = ?4, duration_ms = ?5, \
                 status = 'ready', revision = revision + 1, updated_at = ?6 \
                 WHERE id = ?7 AND project_id = ?8 AND storyboard_id = ?9 \
                 AND EXISTS (SELECT 1 FROM workspace_nodes WHERE id = ?10 \
                   AND project_id = ?8 AND storyboard_id = ?9 AND target_type = 'media' AND target_id = ?7)",
                params![object_key, mime_type, width, height, duration_ms,
                    chrono::Utc::now().to_rfc3339(), media_id.to_string(), project_id.to_string(),
                    storyboard_id.to_string(), node_id],
            )?;
            if affected == 0 { return Err(ProductError::NotFound); }
            Ok(())
        })
        .await
        .map_err(|error| ProductError::Storage(error.to_string()))?
    }
}
