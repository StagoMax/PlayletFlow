use crate::product::domain::{
    GenerationJob, GenerationSpec, ProductError, ProductResult, ProjectId,
};
use crate::product::infrastructure::sqlite::support::append_event;
use rusqlite::{params, Transaction};
use serde_json::json;

pub(crate) fn insert(tx: &Transaction<'_>, job: &GenerationJob) -> ProductResult<()> {
    tx.execute(
        "INSERT INTO generation_jobs \
         (id, project_id, storyboard_id, proposal_id, target_type, target_id, target_revision, \
          generation_spec_json, status, attempt, provider, provider_job_id, result_media_id, error, \
          created_at, updated_at) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16)",
        params![
            job.id.to_string(),
            job.project_id.to_string(),
            job.storyboard_id.to_string(),
            job.proposal_id.map(|id| id.to_string()),
            job.target.target_type(),
            job.target.target_id(),
            job.target_revision,
            serde_json::to_string(&job.spec)
                .map_err(|error| ProductError::Storage(error.to_string()))?,
            job.status.as_storage_str(),
            job.attempt,
            job.provider,
            job.provider_job_id,
            job.result_media_id.map(|id| id.to_string()),
            job.error,
            job.created_at.to_rfc3339(),
            job.updated_at.to_rfc3339(),
        ],
    )?;
    Ok(())
}

pub(crate) fn validate_inputs(
    tx: &Transaction<'_>,
    project_id: ProjectId,
    spec: &GenerationSpec,
) -> ProductResult<()> {
    for media_id in spec.input.media_ids() {
        let valid: bool = tx.query_row(
            "SELECT EXISTS(SELECT 1 FROM media_items \
             WHERE id = ?1 AND project_id = ?2 AND kind = 'image' AND status = 'ready' \
               AND source_object_key IS NOT NULL AND deleted_at IS NULL)",
            params![media_id.to_string(), project_id.to_string()],
            |row| row.get(0),
        )?;
        if !valid {
            return Err(ProductError::Validation(
                "generation inputs must reference ready images in the same project".into(),
            ));
        }
    }
    Ok(())
}

pub(crate) fn append_requested(tx: &Transaction<'_>, job: &GenerationJob) -> ProductResult<()> {
    append_event(
        tx,
        job.project_id,
        "generation.requested",
        json!({
            "generationJobId": job.id,
            "proposalId": job.proposal_id,
            "storyboardId": job.storyboard_id,
        }),
    )
}
