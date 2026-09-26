use super::support::{append_event, immediate, remember, replay, time_from_row, uuid_from_row};
use super::ProductDatabase;
use crate::product::application::idempotency::IdempotencyContext;
use crate::product::application::workspace_threads::{
    StoryboardAssetContext, StoryboardContext, StoryboardMediaContext, StoryboardScriptContext,
    WorkspaceThreadStore,
};
use crate::product::domain::{
    ProductError, ProductResult, ProjectId, StoryboardId, WorkspaceThreadBinding,
};
use async_trait::async_trait;
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::json;
use uuid::Uuid;

#[derive(Clone)]
pub struct SqliteWorkspaceThreadStore {
    database: ProductDatabase,
}

impl SqliteWorkspaceThreadStore {
    pub fn new(database: ProductDatabase) -> Self {
        Self { database }
    }

    async fn run<T, F>(&self, operation: F) -> ProductResult<T>
    where
        T: Send + 'static,
        F: FnOnce(&mut Connection) -> ProductResult<T> + Send + 'static,
    {
        let database = self.database.clone();
        tokio::task::spawn_blocking(move || {
            let mut connection = database.connect()?;
            operation(&mut connection)
        })
        .await
        .map_err(|error| ProductError::Storage(error.to_string()))?
    }
}

#[async_trait]
impl WorkspaceThreadStore for SqliteWorkspaceThreadStore {
    async fn validate_scope(
        &self,
        project_id: ProjectId,
        storyboard_id: StoryboardId,
    ) -> ProductResult<()> {
        self.run(move |connection| {
            let exists = connection
                .query_row(
                    "SELECT 1 FROM storyboards
                     WHERE id = ?1 AND project_id = ?2 AND deleted_at IS NULL",
                    params![storyboard_id.to_string(), project_id.to_string()],
                    |_| Ok(()),
                )
                .optional()?;
            exists.ok_or(ProductError::NotFound)
        })
        .await
    }

    async fn find_latest(
        &self,
        project_id: ProjectId,
        storyboard_id: StoryboardId,
    ) -> ProductResult<Option<WorkspaceThreadBinding>> {
        self.run(move |connection| {
            connection
                .query_row(
                    "SELECT project_id, storyboard_id, thread_id, created_at
                     FROM workspace_thread_bindings
                     WHERE project_id = ?1 AND storyboard_id = ?2
                     ORDER BY created_at DESC, rowid DESC LIMIT 1",
                    params![project_id.to_string(), storyboard_id.to_string()],
                    binding_from_row,
                )
                .optional()
                .map_err(Into::into)
        })
        .await
    }

    async fn list(
        &self,
        project_id: ProjectId,
        storyboard_id: StoryboardId,
    ) -> ProductResult<Vec<WorkspaceThreadBinding>> {
        self.run(move |connection| {
            let mut statement = connection.prepare(
                "SELECT project_id, storyboard_id, thread_id, created_at
                 FROM workspace_thread_bindings
                 WHERE project_id = ?1 AND storyboard_id = ?2
                 ORDER BY created_at DESC, rowid DESC",
            )?;
            let bindings = statement
                .query_map(
                    params![project_id.to_string(), storyboard_id.to_string()],
                    binding_from_row,
                )?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            Ok(bindings)
        })
        .await
    }

    async fn find_by_thread(
        &self,
        thread_id: Uuid,
    ) -> ProductResult<Option<WorkspaceThreadBinding>> {
        self.run(move |connection| {
            connection
                .query_row(
                    "SELECT project_id, storyboard_id, thread_id, created_at
                     FROM workspace_thread_bindings WHERE thread_id = ?1",
                    [thread_id.to_string()],
                    binding_from_row,
                )
                .optional()
                .map_err(Into::into)
        })
        .await
    }

    async fn replay_create(
        &self,
        idempotency: &IdempotencyContext,
    ) -> ProductResult<Option<WorkspaceThreadBinding>> {
        let idempotency = idempotency.clone();
        self.run(move |connection| {
            let transaction = immediate(connection)?;
            let binding = replay(&transaction, &idempotency)?;
            transaction.commit()?;
            Ok(binding)
        })
        .await
    }

    async fn bind(
        &self,
        binding: WorkspaceThreadBinding,
        idempotency: IdempotencyContext,
    ) -> ProductResult<WorkspaceThreadBinding> {
        self.run(move |connection| {
            let transaction = immediate(connection)?;
            if let Some(existing) = replay(&transaction, &idempotency)? {
                transaction.commit()?;
                return Ok(existing);
            }
            let scope_exists = transaction
                .query_row(
                    "SELECT 1 FROM storyboards
                     WHERE id = ?1 AND project_id = ?2 AND deleted_at IS NULL",
                    params![
                        binding.storyboard_id.to_string(),
                        binding.project_id.to_string()
                    ],
                    |_| Ok(()),
                )
                .optional()?;
            scope_exists.ok_or(ProductError::NotFound)?;
            transaction.execute(
                "INSERT INTO workspace_thread_bindings
                 (thread_id, project_id, storyboard_id, created_at)
                 VALUES (?1, ?2, ?3, ?4)",
                params![
                    binding.thread_id.to_string(),
                    binding.project_id.to_string(),
                    binding.storyboard_id.to_string(),
                    binding.created_at.to_rfc3339()
                ],
            )?;
            append_event(
                &transaction,
                binding.project_id,
                "workspaceThread.bound",
                json!({
                    "storyboardId": binding.storyboard_id,
                    "threadId": binding.thread_id,
                }),
            )?;
            remember(&transaction, &idempotency, &binding)?;
            transaction.commit()?;
            Ok(binding)
        })
        .await
    }

    async fn load_context(&self, thread_id: Uuid) -> ProductResult<Option<StoryboardContext>> {
        self.run(move |connection| {
            let header = connection
                .query_row(
                    "SELECT p.id, p.name, s.id, s.name, s.revision,
                            COALESCE(sc.text, ''), COALESCE(sc.revision, 1)
                     FROM workspace_thread_bindings wt
                     JOIN projects p ON p.id = wt.project_id
                     JOIN storyboards s ON s.id = wt.storyboard_id
                         AND s.project_id = wt.project_id AND s.deleted_at IS NULL
                     LEFT JOIN storyboard_scripts sc ON sc.storyboard_id = s.id
                     WHERE wt.thread_id = ?1",
                    [thread_id.to_string()],
                    |row| {
                        Ok(StoryboardContext {
                            project_id: ProjectId(uuid_from_row(row, 0)?),
                            project_name: row.get(1)?,
                            storyboard_id: StoryboardId(uuid_from_row(row, 2)?),
                            storyboard_name: row.get(3)?,
                            storyboard_revision: row.get(4)?,
                            script: StoryboardScriptContext {
                                text: row.get(5)?,
                                revision: row.get(6)?,
                            },
                            assets: Vec::new(),
                            media: Vec::new(),
                        })
                    },
                )
                .optional()?;
            let Some(mut context) = header else {
                return Ok(None);
            };

            let mut assets = connection.prepare(
                "SELECT ab.id, a.id, a.kind, a.name,
                        COALESCE(ab.prompt_override, a.canonical_prompt), ab.revision
                 FROM asset_bindings ab
                 JOIN assets a ON a.id = ab.asset_id AND a.project_id = ab.project_id
                 WHERE ab.storyboard_id = ?1 AND ab.project_id = ?2 AND a.deleted_at IS NULL
                 ORDER BY ab.position, ab.id LIMIT 200",
            )?;
            context.assets = assets
                .query_map(
                    params![
                        context.storyboard_id.to_string(),
                        context.project_id.to_string()
                    ],
                    |row| {
                        Ok(StoryboardAssetContext {
                            binding_id: uuid_from_row(row, 0)?,
                            asset_id: uuid_from_row(row, 1)?,
                            kind: row.get(2)?,
                            name: row.get(3)?,
                            prompt: row.get(4)?,
                            revision: row.get(5)?,
                        })
                    },
                )?
                .collect::<Result<Vec<_>, _>>()?;

            let mut media = connection.prepare(
                "SELECT id, kind, role, name, prompt, status, revision
                 FROM media_items
                 WHERE storyboard_id = ?1 AND project_id = ?2
                 ORDER BY created_at, id LIMIT 200",
            )?;
            context.media = media
                .query_map(
                    params![
                        context.storyboard_id.to_string(),
                        context.project_id.to_string()
                    ],
                    |row| {
                        Ok(StoryboardMediaContext {
                            media_id: uuid_from_row(row, 0)?,
                            kind: row.get(1)?,
                            role: row.get(2)?,
                            name: row.get(3)?,
                            prompt: row.get(4)?,
                            status: row.get(5)?,
                            revision: row.get(6)?,
                        })
                    },
                )?
                .collect::<Result<Vec<_>, _>>()?;
            Ok(Some(context))
        })
        .await
    }
}

fn binding_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<WorkspaceThreadBinding> {
    Ok(WorkspaceThreadBinding {
        project_id: ProjectId(uuid_from_row(row, 0)?),
        storyboard_id: StoryboardId(uuid_from_row(row, 1)?),
        thread_id: uuid_from_row(row, 2)?,
        created_at: time_from_row(row, 3)?,
    })
}
