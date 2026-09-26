use crate::product::domain::{
    AssetBindingId, ChangeProposal, MediaId, ProductError, ProductResult, ProjectId, ProposalId,
    ProposalSource, ProposalStatus, ProposalTarget, StoryboardId,
};
use crate::product::infrastructure::sqlite::support::{
    optional_time_from_row, revision_error, time_from_row, uuid_from_row,
};
use rusqlite::{params, Connection, OptionalExtension, Row, Transaction};
use uuid::Uuid;

const COLUMNS: &str = "id, project_id, storyboard_id, target_type, target_id, base_revision, \
    before_value, proposed_value, summary, status, source_thread_id, source_turn_id, \
    source_tool_call_id, revision, created_at, resolved_at";

pub(super) fn find_raw(
    connection: &Connection,
    project_id: ProjectId,
    proposal_id: ProposalId,
) -> ProductResult<Option<ChangeProposal>> {
    let sql = format!("SELECT {COLUMNS} FROM change_proposals WHERE id = ?1 AND project_id = ?2");
    connection
        .query_row(
            &sql,
            params![proposal_id.to_string(), project_id.to_string()],
            from_row,
        )
        .optional()
        .map_err(Into::into)
}

pub(super) fn find_by_source(
    connection: &Connection,
    source: &ProposalSource,
) -> ProductResult<Option<ChangeProposal>> {
    let sql = format!(
        "SELECT {COLUMNS} FROM change_proposals \
         WHERE source_thread_id = ?1 AND source_tool_call_id = ?2"
    );
    connection
        .query_row(
            &sql,
            params![source.thread_id.to_string(), source.tool_call_id],
            from_row,
        )
        .optional()
        .map_err(Into::into)
}

pub(super) fn list_raw(
    connection: &Connection,
    project_id: ProjectId,
    storyboard_id: StoryboardId,
) -> ProductResult<Vec<ChangeProposal>> {
    let sql = format!(
        "SELECT {COLUMNS} FROM change_proposals WHERE project_id = ?1 AND storyboard_id = ?2 \
         ORDER BY created_at DESC, id DESC"
    );
    let mut statement = connection.prepare(&sql)?;
    let proposals = statement
        .query_map(
            params![project_id.to_string(), storyboard_id.to_string()],
            from_row,
        )?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(proposals)
}

pub(super) fn insert(tx: &Transaction<'_>, proposal: &ChangeProposal) -> ProductResult<()> {
    tx.execute(
        "INSERT INTO change_proposals \
         (id, project_id, storyboard_id, target_type, target_id, base_revision, before_value, \
          proposed_value, summary, status, source_thread_id, source_turn_id, source_tool_call_id, \
          revision, created_at, resolved_at) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16)",
        params![
            proposal.id.to_string(),
            proposal.project_id.to_string(),
            proposal.storyboard_id.to_string(),
            proposal.target.target_type(),
            proposal.target.target_id(),
            proposal.base_revision,
            proposal.before_value,
            proposal.proposed_value,
            proposal.summary,
            proposal.status.as_storage_str(),
            proposal.source.thread_id.to_string(),
            proposal.source.turn_id.to_string(),
            proposal.source.tool_call_id,
            proposal.revision,
            proposal.created_at.to_rfc3339(),
            proposal.resolved_at.map(|value| value.to_rfc3339()),
        ],
    )?;
    Ok(())
}

pub(super) fn persist(
    tx: &Transaction<'_>,
    proposal: &ChangeProposal,
    expected_revision: i64,
) -> ProductResult<()> {
    let changed = tx.execute(
        "UPDATE change_proposals SET status = ?1, revision = ?2, resolved_at = ?3 \
         WHERE id = ?4 AND project_id = ?5 AND revision = ?6",
        params![
            proposal.status.as_storage_str(),
            proposal.revision,
            proposal.resolved_at.map(|value| value.to_rfc3339()),
            proposal.id.to_string(),
            proposal.project_id.to_string(),
            expected_revision,
        ],
    )?;
    if changed == 0 {
        let actual = tx
            .query_row(
                "SELECT revision FROM change_proposals WHERE id = ?1 AND project_id = ?2",
                params![proposal.id.to_string(), proposal.project_id.to_string()],
                |row| row.get(0),
            )
            .optional()?;
        return Err(revision_error(actual, expected_revision));
    }
    Ok(())
}

fn from_row(row: &Row<'_>) -> rusqlite::Result<ChangeProposal> {
    let target_type: String = row.get(3)?;
    let target_id: String = row.get(4)?;
    let target_uuid = Uuid::parse_str(&target_id).map_err(|error| {
        rusqlite::Error::FromSqlConversionFailure(4, rusqlite::types::Type::Text, Box::new(error))
    })?;
    let target = match target_type.as_str() {
        "script" => ProposalTarget::Script {
            storyboard_id: StoryboardId(target_uuid),
        },
        "mediaPrompt" => ProposalTarget::MediaPrompt {
            media_id: MediaId(target_uuid),
        },
        "assetBindingPrompt" => ProposalTarget::AssetBindingPrompt {
            binding_id: AssetBindingId(target_uuid),
        },
        _ => return Err(conversion_error(3, "unknown proposal target type")),
    };
    let status_text: String = row.get(9)?;
    let status = ProposalStatus::from_api_str(&status_text)
        .ok_or_else(|| conversion_error(9, "unknown proposal status"))?;
    Ok(ChangeProposal {
        id: ProposalId(uuid_from_row(row, 0)?),
        project_id: ProjectId(uuid_from_row(row, 1)?),
        storyboard_id: StoryboardId(uuid_from_row(row, 2)?),
        target,
        base_revision: row.get(5)?,
        before_value: row.get(6)?,
        proposed_value: row.get(7)?,
        summary: row.get(8)?,
        status,
        source: ProposalSource {
            thread_id: uuid_from_row(row, 10)?,
            turn_id: uuid_from_row(row, 11)?,
            tool_call_id: row.get(12)?,
        },
        revision: row.get(13)?,
        created_at: time_from_row(row, 14)?,
        resolved_at: optional_time_from_row(row, 15)?,
    })
}

fn conversion_error(index: usize, message: &'static str) -> rusqlite::Error {
    rusqlite::Error::FromSqlConversionFailure(
        index,
        rusqlite::types::Type::Text,
        Box::new(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            message,
        )),
    )
}

pub(super) fn source_reuse_error() -> ProductError {
    ProductError::Conflict {
        code: "PROPOSAL_SOURCE_REUSED",
        message: "tool call already created a different proposal".into(),
    }
}
