#[path = "workspace_node_media.rs"]
mod media_objects;
#[path = "workspace_node_order.rs"]
mod order;

use super::support::{
    append_event, immediate, next_position, remember, replay, revision_error, time_from_row,
    uuid_from_row,
};
use super::ProductDatabase;
use crate::product::application::workspace_nodes::{
    CopyWorkspaceNode, CreatePromptedMediaObject, CreateWorkspaceNode, DeleteWorkspaceNode,
    MarkWorkspaceNodeViewed, ReorderWorkspaceNode, SaveWorkspaceObjectPrompt,
    SavedWorkspaceObjectPrompt, UndoWorkspaceObjectPrompt, UpdateWorkspaceNode,
    WorkspaceNodeRepository,
};
use crate::product::domain::{
    ProductError, ProductResult, ProjectId, StoryboardId, WorkspaceNode, WorkspaceNodeKind,
    WorkspaceObjectType, WorkspaceTargetType,
};
use async_trait::async_trait;
use chrono::Utc;
use rusqlite::types::Type;
use rusqlite::{params, Connection, OptionalExtension, Row, Transaction};
use serde_json::json;
use uuid::Uuid;

#[derive(Clone, Debug)]
pub struct SqliteWorkspaceNodeRepository {
    database: ProductDatabase,
}

impl SqliteWorkspaceNodeRepository {
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
impl WorkspaceNodeRepository for SqliteWorkspaceNodeRepository {
    async fn list(
        &self,
        project_id: ProjectId,
        storyboard_id: StoryboardId,
    ) -> ProductResult<Vec<WorkspaceNode>> {
        self.run(move |connection| list(connection, project_id, storyboard_id))
            .await
    }

    async fn create(&self, command: CreateWorkspaceNode) -> ProductResult<WorkspaceNode> {
        self.run(move |connection| create(connection, command))
            .await
    }

    async fn create_prompted_media_object(
        &self,
        command: CreatePromptedMediaObject,
    ) -> ProductResult<WorkspaceNode> {
        self.run(move |connection| media_objects::create_prompted(connection, command))
            .await
    }

    async fn save_object_prompt(
        &self,
        command: SaveWorkspaceObjectPrompt,
    ) -> ProductResult<SavedWorkspaceObjectPrompt> {
        self.run(move |connection| media_objects::save_prompt(connection, command))
            .await
    }

    async fn undo_object_prompt(
        &self,
        command: UndoWorkspaceObjectPrompt,
    ) -> ProductResult<SavedWorkspaceObjectPrompt> {
        self.run(move |connection| media_objects::undo_prompt(connection, command))
            .await
    }

    async fn mark_viewed(&self, command: MarkWorkspaceNodeViewed) -> ProductResult<WorkspaceNode> {
        self.run(move |connection| mark_viewed(connection, command))
            .await
    }

    async fn update(&self, command: UpdateWorkspaceNode) -> ProductResult<WorkspaceNode> {
        self.run(move |connection| update(connection, command))
            .await
    }

    async fn reorder(&self, command: ReorderWorkspaceNode) -> ProductResult<WorkspaceNode> {
        self.run(move |connection| order::reorder(connection, command))
            .await
    }

    async fn delete(&self, command: DeleteWorkspaceNode) -> ProductResult<()> {
        self.run(move |connection| delete(connection, command))
            .await
    }

    async fn copy(&self, command: CopyWorkspaceNode) -> ProductResult<WorkspaceNode> {
        self.run(move |connection| copy(connection, command)).await
    }
}

fn list(
    connection: &Connection,
    project_id: ProjectId,
    storyboard_id: StoryboardId,
) -> ProductResult<Vec<WorkspaceNode>> {
    ensure_storyboard(connection, project_id, storyboard_id)?;
    let mut statement = connection.prepare(
        "SELECT id, project_id, storyboard_id, parent_id, kind, name, object_type,
                target_type, target_id, position, revision, created_at, updated_at, unseen_update_at
         FROM workspace_nodes
         WHERE project_id = ?1 AND storyboard_id = ?2
         ORDER BY position, id",
    )?;
    let nodes = statement
        .query_map(
            params![project_id.to_string(), storyboard_id.to_string()],
            node_from_row,
        )?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(nodes)
}

fn create(
    connection: &mut Connection,
    mut command: CreateWorkspaceNode,
) -> ProductResult<WorkspaceNode> {
    let transaction = immediate(connection)?;
    if let Some(value) = replay(&transaction, &command.idempotency)? {
        return Ok(value);
    }
    let node = insert_new_node(&transaction, &mut command.node)?;
    append_event(
        &transaction,
        command.node.project_id,
        "workspaceNode.created",
        json!({ "nodeId": node.id, "storyboardId": node.storyboard_id }),
    )?;
    remember(&transaction, &command.idempotency, &node)?;
    transaction.commit()?;
    Ok(node)
}

pub(super) fn insert_new_node(
    transaction: &Transaction<'_>,
    node: &mut WorkspaceNode,
) -> ProductResult<WorkspaceNode> {
    ensure_storyboard(transaction, node.project_id, node.storyboard_id)?;
    validate_parent(
        transaction,
        node.project_id,
        node.storyboard_id,
        node.parent_id.as_deref(),
    )?;
    node.position = next_position(
        transaction,
        "workspace_nodes",
        "storyboard_id",
        &node.storyboard_id.to_string(),
    )?;
    transaction.execute(
        "INSERT INTO workspace_nodes
         (id, project_id, storyboard_id, parent_id, kind, name, object_type, target_type,
          target_id, position, revision, created_at, updated_at, unseen_update_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?12, ?13)",
        params![
            node.id,
            node.project_id.to_string(),
            node.storyboard_id.to_string(),
            node.parent_id,
            node.kind.as_str(),
            node.name,
            node.object_type.map(WorkspaceObjectType::as_str),
            node.target_type.map(WorkspaceTargetType::as_str),
            node.target_id,
            node.position,
            node.revision,
            node.created_at.to_rfc3339(),
            node.unseen_update_at.map(|value| value.to_rfc3339()),
        ],
    )?;
    load(transaction, node.project_id, node.storyboard_id, &node.id)?.ok_or(ProductError::NotFound)
}

fn update(
    connection: &mut Connection,
    command: UpdateWorkspaceNode,
) -> ProductResult<WorkspaceNode> {
    let transaction = immediate(connection)?;
    let current = load(
        &transaction,
        command.project_id,
        command.storyboard_id,
        &command.node_id,
    )?
    .ok_or(ProductError::NotFound)?;
    validate_parent(
        &transaction,
        command.project_id,
        command.storyboard_id,
        command.parent_id.as_deref(),
    )?;
    if let Some(parent_id) = command.parent_id.as_deref() {
        if parent_id == command.node_id || is_descendant(&transaction, &command.node_id, parent_id)?
        {
            return Err(ProductError::Conflict {
                code: "WORKSPACE_NODE_CYCLE",
                message: "a workspace folder cannot be moved into itself or one of its descendants"
                    .to_owned(),
            });
        }
    }
    let position = if current.parent_id == command.parent_id {
        current.position
    } else {
        next_position(
            &transaction,
            "workspace_nodes",
            "storyboard_id",
            &command.storyboard_id.to_string(),
        )?
    };
    let changed = transaction.execute(
        "UPDATE workspace_nodes
         SET parent_id = ?1, name = ?2, position = ?3, revision = revision + 1, updated_at = ?4
         WHERE id = ?5 AND project_id = ?6 AND storyboard_id = ?7 AND revision = ?8",
        params![
            command.parent_id,
            command.name,
            position,
            Utc::now().to_rfc3339(),
            command.node_id,
            command.project_id.to_string(),
            command.storyboard_id.to_string(),
            command.expected_revision,
        ],
    )?;
    if changed == 0 {
        return Err(revision_error(
            actual_revision(&transaction, &command.node_id)?,
            command.expected_revision,
        ));
    }
    let node = load(
        &transaction,
        command.project_id,
        command.storyboard_id,
        &command.node_id,
    )?
    .ok_or(ProductError::NotFound)?;
    append_event(
        &transaction,
        command.project_id,
        "workspaceNode.updated",
        json!({ "nodeId": node.id, "storyboardId": node.storyboard_id }),
    )?;
    transaction.commit()?;
    Ok(node)
}

fn delete(connection: &mut Connection, command: DeleteWorkspaceNode) -> ProductResult<()> {
    let transaction = immediate(connection)?;
    let current = load(
        &transaction,
        command.project_id,
        command.storyboard_id,
        &command.node_id,
    )?
    .ok_or(ProductError::NotFound)?;
    if current.revision != command.expected_revision {
        return Err(revision_error(
            Some(current.revision),
            command.expected_revision,
        ));
    }
    reject_script_subtree(&transaction, &command.node_id)?;
    let now = Utc::now().to_rfc3339();
    // Only workspace-owned media has the same ID as its node. Keep shared
    // storyboard and asset media intact when removing a reference from the tree.
    transaction.execute(
        "WITH RECURSIVE subtree(id) AS (
            SELECT id FROM workspace_nodes WHERE id = ?1
            UNION ALL SELECT child.id FROM workspace_nodes child JOIN subtree parent ON child.parent_id = parent.id
         )
         UPDATE media_items SET deleted_at = ?2, updated_at = ?2, revision = revision + 1
         WHERE id IN (SELECT node.id FROM workspace_nodes node JOIN subtree ON node.id = subtree.id
                      WHERE node.target_type = 'media' AND node.target_id = node.id)
           AND project_id = ?3 AND storyboard_id = ?4 AND deleted_at IS NULL",
        params![command.node_id, now, command.project_id.to_string(), command.storyboard_id.to_string()],
    )?;
    transaction.execute(
        "DELETE FROM workspace_nodes WHERE id = ?1 AND project_id = ?2 AND storyboard_id = ?3",
        params![
            command.node_id,
            command.project_id.to_string(),
            command.storyboard_id.to_string()
        ],
    )?;
    append_event(
        &transaction,
        command.project_id,
        "workspaceNode.deleted",
        json!({ "nodeId": command.node_id, "storyboardId": command.storyboard_id }),
    )?;
    transaction.commit()?;
    Ok(())
}

fn mark_viewed(
    connection: &mut Connection,
    command: MarkWorkspaceNodeViewed,
) -> ProductResult<WorkspaceNode> {
    let transaction = immediate(connection)?;
    let current = load(
        &transaction,
        command.project_id,
        command.storyboard_id,
        &command.node_id,
    )?
    .ok_or(ProductError::NotFound)?;
    if current
        .unseen_update_at
        .is_some_and(|updated_at| updated_at <= command.seen_through)
    {
        transaction.execute(
            "UPDATE workspace_nodes SET unseen_update_at = NULL
             WHERE id = ?1 AND project_id = ?2 AND storyboard_id = ?3",
            params![
                command.node_id,
                command.project_id.to_string(),
                command.storyboard_id.to_string(),
            ],
        )?;
    }
    let node = load(
        &transaction,
        command.project_id,
        command.storyboard_id,
        &command.node_id,
    )?
    .ok_or(ProductError::NotFound)?;
    transaction.commit()?;
    Ok(node)
}

fn copy(connection: &mut Connection, command: CopyWorkspaceNode) -> ProductResult<WorkspaceNode> {
    let transaction = immediate(connection)?;
    if let Some(saved) = replay::<WorkspaceNode>(&transaction, &command.idempotency)? {
        transaction.commit()?;
        return Ok(saved);
    }
    let source = load(
        &transaction,
        command.project_id,
        command.storyboard_id,
        &command.node_id,
    )?
    .ok_or(ProductError::NotFound)?;
    reject_script_subtree(&transaction, &command.node_id)?;
    let root_id = copy_subtree(&transaction, &source, source.parent_id.as_deref(), true)?;
    let copied = load(
        &transaction,
        command.project_id,
        command.storyboard_id,
        &root_id,
    )?
    .ok_or(ProductError::NotFound)?;
    append_event(
        &transaction,
        command.project_id,
        "workspaceNode.copied",
        json!({ "nodeId": copied.id, "sourceNodeId": source.id, "storyboardId": command.storyboard_id }),
    )?;
    remember(&transaction, &command.idempotency, &copied)?;
    transaction.commit()?;
    Ok(copied)
}

fn reject_script_subtree(transaction: &Transaction<'_>, node_id: &str) -> ProductResult<()> {
    let contains_script: bool = transaction.query_row(
        "WITH RECURSIVE subtree(id) AS (
            SELECT id FROM workspace_nodes WHERE id = ?1
            UNION ALL SELECT child.id FROM workspace_nodes child JOIN subtree parent ON child.parent_id = parent.id
         )
         SELECT EXISTS(SELECT 1 FROM workspace_nodes node JOIN subtree ON node.id = subtree.id
                       WHERE node.target_type = 'script')",
        [node_id],
        |row| row.get(0),
    )?;
    if contains_script {
        return Err(ProductError::Conflict {
            code: "SCRIPT_NODE_REQUIRED",
            message: "the storyboard script cannot be deleted or copied as a workspace node"
                .to_owned(),
        });
    }
    Ok(())
}

fn copy_subtree(
    transaction: &Transaction<'_>,
    source: &WorkspaceNode,
    parent_id: Option<&str>,
    is_root: bool,
) -> ProductResult<String> {
    let id = Uuid::new_v4().to_string();
    let name = if is_root {
        let prefix: String = source.name.chars().take(117).collect();
        format!("{prefix} 副本")
    } else {
        source.name.clone()
    };
    let now = Utc::now().to_rfc3339();
    let mut target_type = source.target_type;
    let mut target_id = source.target_id.clone();
    if source.target_type == Some(WorkspaceTargetType::Media) {
        if let Some(media_id) = source.target_id.as_deref() {
            let copied = transaction.execute(
                "INSERT INTO media_items
                 (id, project_id, storyboard_id, kind, role, name, prompt, mime_type,
                  source_object_key, thumbnail_object_key, width, height, duration_ms, status,
                  revision, created_at, updated_at)
                 SELECT ?1, project_id, storyboard_id, kind, 'custom', ?2, prompt, mime_type,
                        CASE WHEN status = 'processing' THEN NULL ELSE source_object_key END,
                        CASE WHEN status = 'processing' THEN NULL ELSE thumbnail_object_key END,
                        width, height, duration_ms,
                        CASE WHEN status = 'processing' THEN 'placeholder' ELSE status END,
                        1, ?3, ?3
                 FROM media_items WHERE id = ?4 AND project_id = ?5 AND deleted_at IS NULL",
                params![id, name, now, media_id, source.project_id.to_string()],
            )?;
            if copied > 0 {
                target_id = Some(id.clone());
            }
        }
    } else if source.target_type == Some(WorkspaceTargetType::Empty) {
        target_id = None;
    } else if source.target_type.is_none() {
        target_type = None;
        target_id = None;
    }
    let position = next_position(
        transaction,
        "workspace_nodes",
        "storyboard_id",
        &source.storyboard_id.to_string(),
    )?;
    transaction.execute(
        "INSERT INTO workspace_nodes
         (id, project_id, storyboard_id, parent_id, kind, name, object_type, target_type,
          target_id, position, revision, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, 1, ?11, ?11)",
        params![
            id,
            source.project_id.to_string(),
            source.storyboard_id.to_string(),
            parent_id,
            source.kind.as_str(),
            name,
            source.object_type.map(WorkspaceObjectType::as_str),
            target_type.map(WorkspaceTargetType::as_str),
            target_id,
            position,
            now
        ],
    )?;
    if source.kind == WorkspaceNodeKind::Folder {
        let mut statement = transaction.prepare(
            "SELECT id, project_id, storyboard_id, parent_id, kind, name, object_type,
                    target_type, target_id, position, revision, created_at, updated_at, unseen_update_at
             FROM workspace_nodes WHERE parent_id = ?1 ORDER BY position, id",
        )?;
        let children = statement
            .query_map([&source.id], node_from_row)?
            .collect::<Result<Vec<_>, _>>()?;
        drop(statement);
        for child in children {
            copy_subtree(transaction, &child, Some(&id), false)?;
        }
    }
    Ok(id)
}

fn ensure_storyboard(
    connection: &Connection,
    project_id: ProjectId,
    storyboard_id: StoryboardId,
) -> ProductResult<()> {
    let exists: bool = connection.query_row(
        "SELECT EXISTS(SELECT 1 FROM storyboards
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

fn validate_parent(
    transaction: &Transaction<'_>,
    project_id: ProjectId,
    storyboard_id: StoryboardId,
    parent_id: Option<&str>,
) -> ProductResult<()> {
    let Some(parent_id) = parent_id else {
        return Ok(());
    };
    let kind = transaction
        .query_row(
            "SELECT kind FROM workspace_nodes
             WHERE id = ?1 AND project_id = ?2 AND storyboard_id = ?3",
            params![parent_id, project_id.to_string(), storyboard_id.to_string()],
            |row| row.get::<_, String>(0),
        )
        .optional()?;
    match kind.as_deref() {
        Some("folder") => Ok(()),
        Some(_) => Err(ProductError::Validation(
            "workspace node parent must be a folder".to_owned(),
        )),
        None => Err(ProductError::Validation(
            "workspace node parent was not found in this storyboard".to_owned(),
        )),
    }
}

fn is_descendant(
    transaction: &Transaction<'_>,
    node_id: &str,
    candidate_parent_id: &str,
) -> ProductResult<bool> {
    transaction
        .query_row(
            "WITH RECURSIVE descendants(id) AS (
                SELECT id FROM workspace_nodes WHERE parent_id = ?1
                UNION ALL
                SELECT child.id FROM workspace_nodes child
                JOIN descendants parent ON child.parent_id = parent.id
             )
             SELECT EXISTS(SELECT 1 FROM descendants WHERE id = ?2)",
            params![node_id, candidate_parent_id],
            |row| row.get(0),
        )
        .map_err(Into::into)
}

fn actual_revision(transaction: &Transaction<'_>, node_id: &str) -> ProductResult<Option<i64>> {
    transaction
        .query_row(
            "SELECT revision FROM workspace_nodes WHERE id = ?1",
            [node_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(Into::into)
}

fn load(
    connection: &Connection,
    project_id: ProjectId,
    storyboard_id: StoryboardId,
    node_id: &str,
) -> ProductResult<Option<WorkspaceNode>> {
    connection
        .query_row(
            "SELECT id, project_id, storyboard_id, parent_id, kind, name, object_type,
                    target_type, target_id, position, revision, created_at, updated_at, unseen_update_at
             FROM workspace_nodes
             WHERE id = ?1 AND project_id = ?2 AND storyboard_id = ?3",
            params![node_id, project_id.to_string(), storyboard_id.to_string()],
            node_from_row,
        )
        .optional()
        .map_err(Into::into)
}

fn node_from_row(row: &Row<'_>) -> rusqlite::Result<WorkspaceNode> {
    let kind = enum_from_row(row, 4, WorkspaceNodeKind::parse)?;
    let object_type = optional_enum_from_row(row, 6, WorkspaceObjectType::parse)?;
    let target_type = optional_enum_from_row(row, 7, WorkspaceTargetType::parse)?;
    Ok(WorkspaceNode {
        id: row.get(0)?,
        project_id: ProjectId::from(uuid_from_row(row, 1)?),
        storyboard_id: StoryboardId::from(uuid_from_row(row, 2)?),
        parent_id: row.get(3)?,
        kind,
        name: row.get(5)?,
        object_type,
        target_type,
        target_id: row.get(8)?,
        position: row.get(9)?,
        revision: row.get(10)?,
        created_at: time_from_row(row, 11)?,
        updated_at: time_from_row(row, 12)?,
        unseen_update_at: row
            .get::<_, Option<String>>(13)?
            .map(|value| {
                chrono::DateTime::parse_from_rfc3339(&value)
                    .map(|parsed| parsed.with_timezone(&Utc))
                    .map_err(|error| {
                        rusqlite::Error::FromSqlConversionFailure(13, Type::Text, Box::new(error))
                    })
            })
            .transpose()?,
    })
}

fn enum_from_row<T>(
    row: &Row<'_>,
    index: usize,
    parse: impl FnOnce(&str) -> ProductResult<T>,
) -> rusqlite::Result<T> {
    let value: String = row.get(index)?;
    parse(&value).map_err(|error| {
        rusqlite::Error::FromSqlConversionFailure(index, Type::Text, Box::new(error))
    })
}

fn optional_enum_from_row<T>(
    row: &Row<'_>,
    index: usize,
    parse: impl FnOnce(&str) -> ProductResult<T>,
) -> rusqlite::Result<Option<T>> {
    row.get::<_, Option<String>>(index)?
        .map(|value| {
            parse(&value).map_err(|error| {
                rusqlite::Error::FromSqlConversionFailure(index, Type::Text, Box::new(error))
            })
        })
        .transpose()
}
