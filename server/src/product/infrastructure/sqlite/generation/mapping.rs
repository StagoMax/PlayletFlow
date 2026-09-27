use crate::product::domain::{
    AssetBindingId, GenerationJob, GenerationJobId, GenerationSpec, GenerationStatus, MediaId,
    ProductError, ProductResult, ProjectId, ProposalId, ProposalTarget, StoryboardId,
};
use crate::product::infrastructure::sqlite::support::{time_from_row, uuid_from_row};
use rusqlite::{params, Connection, OptionalExtension, Row};
use uuid::Uuid;

pub(super) const COLUMNS: &str = "id, project_id, storyboard_id, proposal_id, target_type, \
    target_id, target_revision, generation_spec_json, status, attempt, provider, provider_job_id, \
    result_media_id, error, created_at, updated_at";

pub(super) fn find(
    connection: &Connection,
    project_id: ProjectId,
    job_id: GenerationJobId,
) -> ProductResult<Option<GenerationJob>> {
    let sql = format!("SELECT {COLUMNS} FROM generation_jobs WHERE id = ?1 AND project_id = ?2");
    connection
        .query_row(
            &sql,
            params![job_id.to_string(), project_id.to_string()],
            from_row,
        )
        .optional()
        .map_err(Into::into)
}

pub(super) fn latest_for_media(
    connection: &Connection,
    project_id: ProjectId,
    media_id: MediaId,
) -> ProductResult<Option<GenerationJob>> {
    let sql = format!(
        "SELECT {COLUMNS} FROM generation_jobs \
         WHERE project_id = ?1 AND target_type = 'mediaPrompt' AND target_id = ?2 \
         ORDER BY created_at DESC, id DESC LIMIT 1"
    );
    connection
        .query_row(
            &sql,
            params![project_id.to_string(), media_id.to_string()],
            from_row,
        )
        .optional()
        .map_err(Into::into)
}

pub(super) fn find_by_id(
    connection: &Connection,
    job_id: GenerationJobId,
) -> ProductResult<Option<GenerationJob>> {
    let sql = format!("SELECT {COLUMNS} FROM generation_jobs WHERE id = ?1");
    connection
        .query_row(&sql, [job_id.to_string()], from_row)
        .optional()
        .map_err(Into::into)
}

pub(super) fn from_row(row: &Row<'_>) -> rusqlite::Result<GenerationJob> {
    let target_type: String = row.get(4)?;
    let target_id: String = row.get(5)?;
    let target_uuid =
        Uuid::parse_str(&target_id).map_err(|error| conversion_error(5, error.to_string()))?;
    let target = match target_type.as_str() {
        "mediaPrompt" => ProposalTarget::MediaPrompt {
            media_id: MediaId(target_uuid),
        },
        "assetBindingPrompt" => ProposalTarget::AssetBindingPrompt {
            binding_id: AssetBindingId(target_uuid),
        },
        _ => return Err(conversion_error(4, "unknown generation target type")),
    };
    let spec_json: String = row.get(7)?;
    let spec: GenerationSpec =
        serde_json::from_str(&spec_json).map_err(|error| conversion_error(7, error.to_string()))?;
    let status_text: String = row.get(8)?;
    let status = GenerationStatus::from_storage_str(&status_text)
        .ok_or_else(|| conversion_error(8, "unknown generation status"))?;
    let result_media_id = row
        .get::<_, Option<String>>(12)?
        .map(|value| {
            Uuid::parse_str(&value)
                .map(MediaId)
                .map_err(|error| conversion_error(12, error.to_string()))
        })
        .transpose()?;
    Ok(GenerationJob {
        id: GenerationJobId(uuid_from_row(row, 0)?),
        project_id: ProjectId(uuid_from_row(row, 1)?),
        storyboard_id: StoryboardId(uuid_from_row(row, 2)?),
        proposal_id: row
            .get::<_, Option<String>>(3)?
            .map(|value| {
                Uuid::parse_str(&value)
                    .map(ProposalId)
                    .map_err(|error| conversion_error(3, error.to_string()))
            })
            .transpose()?,
        target,
        target_revision: row.get(6)?,
        spec,
        status,
        attempt: row.get(9)?,
        provider: row.get(10)?,
        provider_job_id: row.get(11)?,
        result_media_id,
        error: row.get(13)?,
        created_at: time_from_row(row, 14)?,
        updated_at: time_from_row(row, 15)?,
    })
}

fn conversion_error(index: usize, message: impl Into<String>) -> rusqlite::Error {
    rusqlite::Error::FromSqlConversionFailure(
        index,
        rusqlite::types::Type::Text,
        Box::new(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            message.into(),
        )),
    )
}

pub(super) fn lost_claim() -> ProductError {
    ProductError::Conflict {
        code: "GENERATION_CLAIM_LOST",
        message: "generation job was claimed by another worker".into(),
    }
}
