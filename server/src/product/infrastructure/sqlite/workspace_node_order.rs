use super::super::support::{
    append_event, format_position, immediate, revision_error, POSITION_STEP,
};
use super::{is_descendant, load};
use crate::product::application::workspace_nodes::ReorderWorkspaceNode;
use crate::product::domain::{ProductError, ProductResult, WorkspaceNode};
use chrono::Utc;
use rusqlite::{params, Connection};
use serde_json::json;

pub(super) fn reorder(
    connection: &mut Connection,
    command: ReorderWorkspaceNode,
) -> ProductResult<WorkspaceNode> {
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
    let anchor_id = command
        .before_id
        .as_ref()
        .or(command.after_id.as_ref())
        .expect("reorder anchor validated by service");
    let anchor = load(
        &transaction,
        command.project_id,
        command.storyboard_id,
        anchor_id,
    )?
    .ok_or(ProductError::NotFound)?;
    if current.id == anchor.id {
        return Err(ProductError::Validation(
            "a workspace node cannot be placed relative to itself".to_owned(),
        ));
    }
    if let Some(parent_id) = anchor.parent_id.as_deref() {
        if parent_id == current.id || is_descendant(&transaction, &current.id, parent_id)? {
            return Err(ProductError::Conflict {
                code: "WORKSPACE_NODE_CYCLE",
                message: "a workspace folder cannot be moved into itself or one of its descendants"
                    .to_owned(),
            });
        }
    }
    let same_parent = current.parent_id == anchor.parent_id;
    let mut siblings = {
        let mut statement = transaction.prepare(
            "SELECT id FROM workspace_nodes
             WHERE project_id = ?1 AND storyboard_id = ?2
               AND ifnull(parent_id, '') = ifnull(?3, '')
             ORDER BY position, id",
        )?;
        let rows = statement
            .query_map(
                params![
                    command.project_id.to_string(),
                    command.storyboard_id.to_string(),
                    anchor.parent_id
                ],
                |row| row.get::<_, String>(0),
            )?
            .collect::<Result<Vec<_>, _>>()?;
        rows
    };
    let original_order = siblings.clone();
    if same_parent {
        let old_index = siblings
            .iter()
            .position(|id| id == &current.id)
            .ok_or(ProductError::NotFound)?;
        siblings.remove(old_index);
    }
    let anchor_index = siblings
        .iter()
        .position(|id| id == anchor_id)
        .ok_or(ProductError::NotFound)?;
    siblings.insert(
        anchor_index + usize::from(command.after_id.is_some()),
        current.id.clone(),
    );
    if same_parent && siblings == original_order {
        return Ok(current);
    }

    if !same_parent {
        transaction.execute(
            "UPDATE workspace_nodes SET parent_id = ?1, position = ?2 WHERE id = ?3",
            params![
                anchor.parent_id,
                format!("~moving-{}", current.id),
                current.id
            ],
        )?;
    }

    // The sibling order has a unique index. Move all positions to a temporary
    // namespace first, then assign spaced positions in the requested order.
    for (index, id) in siblings.iter().enumerate() {
        transaction.execute(
            "UPDATE workspace_nodes SET position = ?1 WHERE id = ?2",
            params![format!("~{index:020}"), id],
        )?;
    }
    for (index, id) in siblings.iter().enumerate() {
        let position = (index as u64 + 1)
            .checked_mul(POSITION_STEP)
            .ok_or_else(|| ProductError::Storage("workspace node position overflow".to_owned()))?;
        transaction.execute(
            "UPDATE workspace_nodes SET position = ?1 WHERE id = ?2",
            params![format_position(position), id],
        )?;
    }
    transaction.execute(
        "UPDATE workspace_nodes SET revision = revision + 1, updated_at = ?1 WHERE id = ?2",
        params![Utc::now().to_rfc3339(), current.id],
    )?;
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
        "workspaceNode.reordered",
        json!({ "nodeId": node.id, "storyboardId": node.storyboard_id }),
    )?;
    transaction.commit()?;
    Ok(node)
}
