use super::support::{append_event, immediate, remember, replay, time_from_row, uuid_from_row};
use super::ProductDatabase;
use crate::conversation_references::WorkspaceReference;
use crate::product::application::idempotency::IdempotencyContext;
use crate::product::application::workspace_threads::{
    StoryboardAssetContext, StoryboardContext, StoryboardFolderContext, StoryboardMediaContext,
    StoryboardResource, StoryboardScriptContext, WorkspaceThreadStore,
};
use crate::product::domain::{
    GenerationSpec, ProductError, ProductResult, ProjectId, StoryboardId, WorkspaceThreadBinding,
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

    async fn delete_binding(
        &self,
        project_id: ProjectId,
        storyboard_id: StoryboardId,
        thread_id: Uuid,
    ) -> ProductResult<()> {
        self.run(move |connection| {
            let transaction = immediate(connection)?;
            let deleted = transaction.execute(
                "DELETE FROM workspace_thread_bindings
                 WHERE project_id = ?1 AND storyboard_id = ?2 AND thread_id = ?3",
                params![
                    project_id.to_string(),
                    storyboard_id.to_string(),
                    thread_id.to_string()
                ],
            )?;
            if deleted == 0 {
                return Err(ProductError::NotFound);
            }
            append_event(
                &transaction,
                project_id,
                "workspaceThread.deleted",
                json!({ "storyboardId": storyboard_id, "threadId": thread_id }),
            )?;
            transaction.commit()?;
            Ok(())
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
                            folders: Vec::new(),
                            assets: Vec::new(),
                            media: Vec::new(),
                        })
                    },
                )
                .optional()?;
            let Some(mut context) = header else {
                return Ok(None);
            };

            let mut folders = connection.prepare(
                "SELECT id, parent_id, name FROM workspace_nodes
                 WHERE storyboard_id = ?1 AND project_id = ?2 AND kind = 'folder'
                 ORDER BY position, id LIMIT 200",
            )?;
            context.folders = folders
                .query_map(
                    params![
                        context.storyboard_id.to_string(),
                        context.project_id.to_string()
                    ],
                    |row| {
                        Ok(StoryboardFolderContext {
                            id: row.get(0)?,
                            parent_id: row.get(1)?,
                            name: row.get(2)?,
                        })
                    },
                )?
                .collect::<Result<Vec<_>, _>>()?;

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

    async fn list_resources(&self, thread_id: Uuid) -> ProductResult<Vec<StoryboardResource>> {
        self.run(move |connection| {
            let scope = connection.query_row(
                "SELECT wt.project_id, wt.storyboard_id FROM workspace_thread_bindings wt \
                 JOIN storyboards board ON board.id = wt.storyboard_id \
                   AND board.project_id = wt.project_id AND board.deleted_at IS NULL \
                 WHERE wt.thread_id = ?1",
                [thread_id.to_string()],
                |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
            ).optional()?.ok_or(ProductError::NotFound)?;
            let (project_id, storyboard_id) = scope;
            let mut resources = Vec::new();

            let mut scripts = connection.prepare(
                "SELECT script.text, script.revision FROM storyboard_scripts script \
                 WHERE script.storyboard_id = ?1",
            )?;
            for row in scripts.query_map([&storyboard_id], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?))
            })? {
                let (content, revision) = row?;
                resources.push(StoryboardResource {
                    id: storyboard_id.clone(), kind: "text".into(), name: "片段脚本".into(),
                    role: Some("script".into()), content: Some(content), status: None,
                    revision, editable: true, generation_input: None,
                });
            }

            let mut bindings = connection.prepare(
                "SELECT binding.id, asset.name, asset.kind, \
                        COALESCE(binding.prompt_override, asset.canonical_prompt), binding.revision \
                 FROM asset_bindings binding JOIN assets asset \
                   ON asset.id = binding.asset_id AND asset.project_id = binding.project_id \
                 WHERE binding.storyboard_id = ?1 AND binding.project_id = ?2 \
                   AND asset.deleted_at IS NULL ORDER BY binding.position, binding.id",
            )?;
            for row in bindings.query_map(params![storyboard_id, project_id], |row| {
                Ok(StoryboardResource {
                    id: row.get(0)?, kind: "assetBinding".into(), name: row.get(1)?,
                    role: row.get(2)?, content: row.get(3)?, status: None,
                    revision: row.get(4)?, editable: true, generation_input: None,
                })
            })? {
                resources.push(row?);
            }

            let mut media = connection.prepare(
                "SELECT media.id, media.kind, media.name, media.role, media.prompt, \
                        media.status, media.revision, \
                        CASE WHEN media.storyboard_id = ?2 THEN 1 ELSE 0 END \
                 FROM media_items media WHERE media.project_id = ?1 \
                   AND media.deleted_at IS NULL AND (media.storyboard_id = ?2 OR EXISTS ( \
                     SELECT 1 FROM asset_bindings binding JOIN assets asset \
                       ON asset.id = binding.asset_id AND asset.project_id = binding.project_id \
                     WHERE binding.asset_id = media.asset_id AND binding.project_id = ?1 \
                       AND binding.storyboard_id = ?2 AND asset.deleted_at IS NULL)) \
                 ORDER BY media.created_at, media.id",
            )?;
            for row in media.query_map(params![project_id, storyboard_id], |row| {
                Ok(StoryboardResource {
                    id: row.get(0)?, kind: row.get(1)?, name: row.get(2)?,
                    role: row.get(3)?, content: row.get(4)?, status: row.get(5)?,
                    revision: row.get(6)?, editable: row.get(7)?, generation_input: None,
                })
            })? {
                resources.push(row?);
            }

            let mut empty_text = connection.prepare(
                "SELECT id, name, revision FROM workspace_nodes \
                 WHERE project_id = ?1 AND storyboard_id = ?2 AND kind = 'object' \
                   AND object_type = 'text' AND target_type = 'empty' ORDER BY position, id",
            )?;
            for row in empty_text.query_map(params![project_id, storyboard_id], |row| {
                Ok(StoryboardResource {
                    id: row.get(0)?, kind: "text".into(), name: row.get(1)?,
                    role: Some("emptyObject".into()), content: None, status: None,
                    revision: row.get(2)?, editable: false, generation_input: None,
                })
            })? {
                resources.push(row?);
            }
            let mut jobs = connection.prepare(
                "SELECT target_type, target_id, generation_spec_json FROM generation_jobs \
                 WHERE project_id = ?1 AND storyboard_id = ?2 \
                 ORDER BY created_at DESC, rowid DESC",
            )?;
            for row in jobs.query_map(params![project_id, storyboard_id], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get::<_, String>(2)?))
            })? {
                let (target_type, target_id, spec_json) = row?;
                let kind = match target_type.as_str() {
                    "mediaPrompt" => None,
                    "assetBindingPrompt" => Some("assetBinding"),
                    _ => continue,
                };
                if let Some(resource) = resources.iter_mut().find(|resource| {
                    resource.id == target_id && resource.generation_input.is_none()
                        && kind.is_none_or(|kind| resource.kind == kind)
                }) {
                    let spec: GenerationSpec = serde_json::from_str(&spec_json)
                        .map_err(|error| ProductError::Storage(error.to_string()))?;
                    resource.generation_input = Some(spec.input);
                }
            }
            Ok(resources)
        }).await
    }

    async fn resolve_references(
        &self,
        thread_id: Uuid,
        reference_ids: &[String],
    ) -> ProductResult<Vec<WorkspaceReference>> {
        let reference_ids = reference_ids.to_vec();
        self.run(move |connection| {
            let mut statement = connection.prepare(
                "SELECT wn.name, wn.object_type
                 FROM workspace_thread_bindings wt
                 JOIN workspace_nodes wn
                   ON wn.project_id = wt.project_id AND wn.storyboard_id = wt.storyboard_id
                 WHERE wt.thread_id = ?1 AND wn.kind = 'object'
                   AND (wn.id = ?2 OR wn.target_id = ?2)
                 ORDER BY CASE WHEN wn.id = ?2 THEN 0 ELSE 1 END
                 LIMIT 1",
            )?;
            reference_ids
                .iter()
                .map(|reference_id| {
                    statement
                        .query_row(params![thread_id.to_string(), reference_id], |row| {
                            let name: String = row.get(0)?;
                            let kind: String = row.get(1)?;
                            Ok(WorkspaceReference {
                                id: reference_id.clone(),
                                name: if reference_id.starts_with("script-") {
                                    "片段脚本".to_owned()
                                } else {
                                    name
                                },
                                kind,
                            })
                        })
                        .optional()?
                        .ok_or(ProductError::NotFound)
                })
                .collect()
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
