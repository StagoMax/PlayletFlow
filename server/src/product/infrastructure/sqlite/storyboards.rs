use crate::product::application::storyboards::{
    CreatedStoryboardRecord, IdempotencyContext, ReorderStoryboard, ReuseStoryboardAssets,
    StoryboardCatalogRepository,
};
use crate::product::domain::{
    ProductError, ProductResult, Project, ProjectId, Storyboard, StoryboardCatalogEntry,
    StoryboardId, StoryboardScript, StoryboardSnapshot,
};
use crate::product::infrastructure::sqlite::storyboard_order::*;
use crate::product::infrastructure::sqlite::storyboard_storage::*;
use crate::product::infrastructure::sqlite::support::{
    append_event, format_position, immediate, remember, replay, POSITION_STEP,
};
use crate::product::infrastructure::sqlite::ProductDatabase;
use async_trait::async_trait;
use chrono::Utc;
use rusqlite::{params, Connection};
use serde_json::json;

#[derive(Clone)]
pub struct SqliteStoryboardRepository {
    database: ProductDatabase,
}

impl SqliteStoryboardRepository {
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
impl StoryboardCatalogRepository for SqliteStoryboardRepository {
    async fn list_projects(&self) -> ProductResult<Vec<Project>> {
        self.run(|connection| {
            let mut statement = connection.prepare(
                "SELECT id, name, revision, created_at, updated_at
                 FROM projects ORDER BY updated_at DESC, id",
            )?;
            let projects = statement
                .query_map([], project_from_row)?
                .collect::<Result<Vec<_>, _>>()
                .map_err(Into::into);
            projects
        })
        .await
    }

    async fn find_project(&self, id: ProjectId) -> ProductResult<Option<Project>> {
        self.run(move |connection| load_project(connection, id))
            .await
    }

    async fn create_project(
        &self,
        project: Project,
        mut first_storyboard: Storyboard,
        script: StoryboardScript,
        idempotency: IdempotencyContext,
    ) -> ProductResult<Project> {
        self.run(move |connection| {
            let transaction = immediate(connection)?;
            if let Some(project) = replay::<Project>(&transaction, &idempotency)? {
                transaction.commit()?;
                return Ok(project);
            }
            first_storyboard.position = format_position(POSITION_STEP);
            insert_project(&transaction, &project)?;
            insert_storyboard(&transaction, &first_storyboard)?;
            insert_script(&transaction, &script)?;
            insert_default_workspace_nodes(&transaction, &first_storyboard)?;
            append_event(
                &transaction,
                project.id,
                "project.created",
                json!({ "projectId": project.id, "revision": project.revision }),
            )?;
            append_event(
                &transaction,
                project.id,
                "storyboard.created",
                json!({ "storyboardId": first_storyboard.id, "revision": 1 }),
            )?;
            remember(&transaction, &idempotency, &project)?;
            transaction.commit()?;
            Ok(project)
        })
        .await
    }

    async fn rename_project(
        &self,
        id: ProjectId,
        name: String,
        expected_revision: i64,
    ) -> ProductResult<Project> {
        self.run(move |connection| {
            let transaction = immediate(connection)?;
            let now = Utc::now().to_rfc3339();
            let changed = transaction.execute(
                "UPDATE projects
                 SET name = ?1, revision = revision + 1, updated_at = ?2
                 WHERE id = ?3 AND revision = ?4",
                params![name, now, id.to_string(), expected_revision],
            )?;
            if changed == 0 {
                return Err(project_write_error(&transaction, id, expected_revision)?);
            }
            let project = load_project(&transaction, id)?.ok_or(ProductError::NotFound)?;
            append_event(
                &transaction,
                id,
                "project.updated",
                json!({ "projectId": id, "revision": project.revision }),
            )?;
            transaction.commit()?;
            Ok(project)
        })
        .await
    }

    async fn list_storyboards(
        &self,
        project_id: ProjectId,
    ) -> ProductResult<Vec<StoryboardCatalogEntry>> {
        self.run(move |connection| load_storyboard_entries(connection, project_id))
            .await
    }

    async fn find_storyboard(
        &self,
        project_id: ProjectId,
        storyboard_id: StoryboardId,
        include_deleted: bool,
    ) -> ProductResult<Option<StoryboardSnapshot>> {
        self.run(move |connection| {
            load_storyboard_snapshot(connection, project_id, storyboard_id, include_deleted)
        })
        .await
    }

    async fn create_storyboard(
        &self,
        mut storyboard: Storyboard,
        script: StoryboardScript,
        insert_after_id: Option<StoryboardId>,
        idempotency: IdempotencyContext,
    ) -> ProductResult<Storyboard> {
        self.run(move |connection| {
            let transaction = immediate(connection)?;
            if let Some(storyboard) = replay::<Storyboard>(&transaction, &idempotency)? {
                transaction.commit()?;
                return Ok(storyboard);
            }
            require_project(&transaction, storyboard.project_id)?;
            storyboard.position =
                allocate_after(&transaction, storyboard.project_id, insert_after_id, None)?;
            insert_storyboard(&transaction, &storyboard)?;
            insert_script(&transaction, &script)?;
            insert_default_workspace_nodes(&transaction, &storyboard)?;
            append_event(
                &transaction,
                storyboard.project_id,
                "storyboard.created",
                json!({ "storyboardId": storyboard.id, "revision": storyboard.revision }),
            )?;
            remember(&transaction, &idempotency, &storyboard)?;
            transaction.commit()?;
            Ok(storyboard)
        })
        .await
    }

    async fn create_storyboard_with_assets(
        &self,
        storyboard: Storyboard,
        script: StoryboardScript,
        insert_after_id: Option<StoryboardId>,
        reuse_assets: Option<ReuseStoryboardAssets>,
        idempotency: IdempotencyContext,
    ) -> ProductResult<CreatedStoryboardRecord> {
        self.run(move |connection| {
            super::storyboard_creation::create_storyboard_with_assets(
                connection,
                storyboard,
                script,
                insert_after_id,
                reuse_assets,
                idempotency,
            )
        })
        .await
    }

    async fn rename_storyboard(
        &self,
        project_id: ProjectId,
        storyboard_id: StoryboardId,
        name: String,
        expected_revision: i64,
    ) -> ProductResult<Storyboard> {
        self.run(move |connection| {
            let transaction = immediate(connection)?;
            let now = Utc::now().to_rfc3339();
            let changed = transaction.execute(
                "UPDATE storyboards
                 SET name = ?1, revision = revision + 1, updated_at = ?2
                 WHERE id = ?3 AND project_id = ?4 AND revision = ?5 AND deleted_at IS NULL",
                params![
                    name,
                    now,
                    storyboard_id.to_string(),
                    project_id.to_string(),
                    expected_revision
                ],
            )?;
            if changed == 0 {
                return Err(storyboard_write_error(
                    &transaction,
                    project_id,
                    storyboard_id,
                    expected_revision,
                    false,
                )?);
            }
            let storyboard = load_storyboard(&transaction, project_id, storyboard_id, false)?
                .ok_or(ProductError::NotFound)?;
            append_event(
                &transaction,
                project_id,
                "storyboard.updated",
                json!({ "storyboardId": storyboard_id, "revision": storyboard.revision }),
            )?;
            transaction.commit()?;
            Ok(storyboard)
        })
        .await
    }

    async fn reorder_storyboard(
        &self,
        command: ReorderStoryboard,
        idempotency: IdempotencyContext,
    ) -> ProductResult<Storyboard> {
        self.run(move |connection| {
            let transaction = immediate(connection)?;
            if let Some(storyboard) = replay::<Storyboard>(&transaction, &idempotency)? {
                transaction.commit()?;
                return Ok(storyboard);
            }
            let current = load_storyboard(
                &transaction,
                command.project_id,
                command.storyboard_id,
                false,
            )?
            .ok_or(ProductError::NotFound)?;
            if current.revision != command.expected_revision {
                return Err(ProductError::RevisionConflict {
                    expected: command.expected_revision,
                    actual: current.revision,
                });
            }
            transaction.execute(
                "UPDATE storyboards SET position = ?1 WHERE id = ?2",
                params![
                    format!("tmp-{}", command.storyboard_id),
                    command.storyboard_id.to_string()
                ],
            )?;
            let mut ordered = ordered_positions_excluding(
                &transaction,
                command.project_id,
                Some(command.storyboard_id),
            )?;
            let insertion = insertion_index(&ordered, command.before_id, command.after_id)?;
            let position = allocate_at(
                &transaction,
                command.project_id,
                &mut ordered,
                insertion,
                Some(command.storyboard_id),
            )?;
            let now = Utc::now().to_rfc3339();
            transaction.execute(
                "UPDATE storyboards
                 SET position = ?1, revision = revision + 1, updated_at = ?2
                 WHERE id = ?3 AND project_id = ?4",
                params![
                    position,
                    now,
                    command.storyboard_id.to_string(),
                    command.project_id.to_string()
                ],
            )?;
            let storyboard = load_storyboard(
                &transaction,
                command.project_id,
                command.storyboard_id,
                false,
            )?
            .ok_or(ProductError::NotFound)?;
            append_event(
                &transaction,
                command.project_id,
                "storyboard.reordered",
                json!({ "storyboardId": storyboard.id, "revision": storyboard.revision }),
            )?;
            remember(&transaction, &idempotency, &storyboard)?;
            transaction.commit()?;
            Ok(storyboard)
        })
        .await
    }

    async fn duplicate_storyboard(
        &self,
        source_id: StoryboardId,
        storyboard: Storyboard,
        idempotency: IdempotencyContext,
    ) -> ProductResult<Storyboard> {
        self.run(move |connection| {
            super::storyboard_duplication::duplicate_storyboard(
                connection,
                source_id,
                storyboard,
                idempotency,
            )
        })
        .await
    }

    async fn delete_storyboard(
        &self,
        project_id: ProjectId,
        storyboard_id: StoryboardId,
        expected_revision: i64,
    ) -> ProductResult<()> {
        self.run(move |connection| {
            let transaction = immediate(connection)?;
            let current = load_storyboard(&transaction, project_id, storyboard_id, false)?
                .ok_or(ProductError::NotFound)?;
            if current.revision != expected_revision {
                return Err(ProductError::RevisionConflict {
                    expected: expected_revision,
                    actual: current.revision,
                });
            }
            let active: i64 = transaction.query_row(
                "SELECT COUNT(*) FROM storyboards WHERE project_id = ?1 AND deleted_at IS NULL",
                [project_id.to_string()],
                |row| row.get(0),
            )?;
            if active <= 1 {
                return Err(ProductError::Conflict {
                    code: "LAST_STORYBOARD",
                    message: "a project must keep at least one active storyboard".to_owned(),
                });
            }
            let now = Utc::now().to_rfc3339();
            transaction.execute(
                "UPDATE storyboards
                 SET deleted_at = ?1, revision = revision + 1, updated_at = ?1
                 WHERE id = ?2 AND project_id = ?3",
                params![now, storyboard_id.to_string(), project_id.to_string()],
            )?;
            append_event(
                &transaction,
                project_id,
                "storyboard.deleted",
                json!({ "storyboardId": storyboard_id, "revision": expected_revision + 1 }),
            )?;
            transaction.commit()?;
            Ok(())
        })
        .await
    }

    async fn restore_storyboard(
        &self,
        project_id: ProjectId,
        storyboard_id: StoryboardId,
        idempotency: IdempotencyContext,
    ) -> ProductResult<Storyboard> {
        self.run(move |connection| {
            let transaction = immediate(connection)?;
            if let Some(storyboard) = replay::<Storyboard>(&transaction, &idempotency)? {
                transaction.commit()?;
                return Ok(storyboard);
            }
            let current = load_storyboard(&transaction, project_id, storyboard_id, true)?
                .ok_or(ProductError::NotFound)?;
            if current.deleted_at.is_none() {
                return Err(ProductError::Conflict {
                    code: "STORYBOARD_NOT_DELETED",
                    message: "storyboard is already active".to_owned(),
                });
            }
            let position = allocate_after(
                &transaction,
                project_id,
                None,
                Some(storyboard_id),
            )?;
            let now = Utc::now().to_rfc3339();
            transaction.execute(
                "UPDATE storyboards
                 SET position = ?1, deleted_at = NULL, revision = revision + 1, updated_at = ?2
                 WHERE id = ?3 AND project_id = ?4",
                params![position, now, storyboard_id.to_string(), project_id.to_string()],
            )?;
            let storyboard = load_storyboard(&transaction, project_id, storyboard_id, false)?
                .ok_or(ProductError::NotFound)?;
            append_event(
                &transaction,
                project_id,
                "storyboard.updated",
                json!({ "storyboardId": storyboard_id, "revision": storyboard.revision, "restored": true }),
            )?;
            remember(&transaction, &idempotency, &storyboard)?;
            transaction.commit()?;
            Ok(storyboard)
        })
        .await
    }

    async fn find_script(
        &self,
        project_id: ProjectId,
        storyboard_id: StoryboardId,
    ) -> ProductResult<Option<StoryboardScript>> {
        self.run(move |connection| {
            if load_storyboard(connection, project_id, storyboard_id, false)?.is_none() {
                return Ok(None);
            }
            load_script(connection, storyboard_id)
        })
        .await
    }

    async fn update_script(
        &self,
        project_id: ProjectId,
        storyboard_id: StoryboardId,
        text: String,
        expected_revision: i64,
    ) -> ProductResult<StoryboardScript> {
        self.run(move |connection| {
            let transaction = immediate(connection)?;
            require_active_storyboard(&transaction, project_id, storyboard_id)?;
            let now = Utc::now().to_rfc3339();
            let changed = transaction.execute(
                "UPDATE storyboard_scripts
                 SET text = ?1, revision = revision + 1, updated_at = ?2
                 WHERE storyboard_id = ?3 AND revision = ?4",
                params![text, now, storyboard_id.to_string(), expected_revision],
            )?;
            if changed == 0 {
                let actual = load_script(&transaction, storyboard_id)?
                    .ok_or(ProductError::NotFound)?
                    .revision;
                return Err(ProductError::RevisionConflict {
                    expected: expected_revision,
                    actual,
                });
            }
            let script = load_script(&transaction, storyboard_id)?.ok_or(ProductError::NotFound)?;
            append_event(
                &transaction,
                project_id,
                "script.updated",
                json!({ "storyboardId": storyboard_id, "revision": script.revision }),
            )?;
            transaction.commit()?;
            Ok(script)
        })
        .await
    }
}

#[cfg(test)]
#[path = "storyboard_repository_tests.rs"]
mod tests;
