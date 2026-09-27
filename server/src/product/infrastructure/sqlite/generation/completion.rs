use super::mapping;
use crate::product::application::generation::{
    GenerationCompletion, GenerationFailure, RunningGenerationJob,
};
use crate::product::domain::{
    GenerationJob, GenerationStatus, MediaId, MediaKind, MediaRole, ProductError, ProductResult,
    ProposalTarget,
};
use crate::product::infrastructure::sqlite::support::{append_event, immediate};
use chrono::Utc;
use rusqlite::{params, Connection, OptionalExtension, Transaction};
use serde_json::json;

pub(super) fn list_running(
    connection: &mut Connection,
    provider: &str,
    limit: usize,
) -> ProductResult<Vec<RunningGenerationJob>> {
    let mut statement = connection.prepare(
        "SELECT id FROM generation_jobs \
         WHERE status = 'running' AND provider = ?1 \
         ORDER BY updated_at, id LIMIT ?2",
    )?;
    let ids = statement
        .query_map(params![provider, limit.max(1) as i64], |row| {
            row.get::<_, String>(0)
        })?
        .collect::<Result<Vec<_>, _>>()?;
    drop(statement);
    let mut jobs = Vec::with_capacity(ids.len());
    for id in ids {
        let id = uuid::Uuid::parse_str(&id)
            .map(crate::product::domain::GenerationJobId)
            .map_err(|error| ProductError::Storage(error.to_string()))?;
        let job = mapping::find_by_id(connection, id)?.ok_or_else(|| {
            ProductError::Storage(format!("running generation job {id} disappeared"))
        })?;
        let kind = target_kind(connection, &job)?;
        jobs.push(RunningGenerationJob { job, kind });
    }
    Ok(jobs)
}

pub(super) fn mark_succeeded(
    connection: &mut Connection,
    completion: GenerationCompletion,
) -> ProductResult<GenerationJob> {
    let tx = immediate(connection)?;
    let mut job = mapping::find_by_id(&tx, completion.job.id)?.ok_or(ProductError::NotFound)?;
    if job.project_id != completion.job.project_id {
        return Err(ProductError::NotFound);
    }
    if job.status == GenerationStatus::Succeeded {
        tx.commit()?;
        return Ok(job);
    }
    if job.status != GenerationStatus::Running
        || job.provider_job_id != completion.job.provider_job_id
    {
        return Err(mapping::lost_claim());
    }
    let target = completion_target(&tx, &job)?;
    if target.kind != completion.output.kind {
        return Err(ProductError::Storage(
            "generation provider returned the wrong media kind".into(),
        ));
    }
    let now = Utc::now();
    // A workspace object uses its own id as its media id. Replacing that id
    // breaks selection and refresh, so complete its current media in place.
    let current_object_media = match job.target {
        ProposalTarget::MediaPrompt { media_id } => tx.query_row(
            "SELECT EXISTS(SELECT 1 FROM workspace_nodes node \
             JOIN media_items media ON media.id = node.target_id \
             WHERE node.id = ?1 AND node.project_id = ?2 AND node.storyboard_id = ?3 \
               AND node.kind = 'object' AND node.target_type = 'media' \
               AND node.target_id = ?1 AND media.revision = ?4 \
               AND media.deleted_at IS NULL)",
            params![
                media_id.to_string(),
                job.project_id.to_string(),
                job.storyboard_id.to_string(),
                job.target_revision
            ],
            |row| row.get::<_, bool>(0),
        )?,
        _ => false,
    };
    let media_id = if current_object_media {
        let ProposalTarget::MediaPrompt { media_id } = job.target else {
            unreachable!();
        };
        let changed = tx.execute(
            "UPDATE media_items SET mime_type = ?1, source_object_key = ?2, \
             thumbnail_object_key = NULL, width = ?3, height = ?4, duration_ms = ?5, \
             status = 'ready', revision = revision + 1, updated_at = ?6 \
             WHERE id = ?7 AND project_id = ?8 AND revision = ?9 AND deleted_at IS NULL",
            params![
                completion.output.mime_type,
                completion.output.object_key,
                completion.output.width,
                completion.output.height,
                completion.output.duration_ms,
                now.to_rfc3339(),
                media_id.to_string(),
                job.project_id.to_string(),
                job.target_revision
            ],
        )?;
        if changed != 1 {
            return Err(ProductError::NotFound);
        }
        media_id
    } else {
        let media_id = MediaId::new();
        tx.execute(
            "INSERT INTO media_items \
         (id, project_id, asset_id, storyboard_id, kind, role, name, prompt, mime_type, \
          source_object_key, width, height, duration_ms, status, revision, created_at, updated_at) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, \
                 'ready', 1, ?14, ?14)",
            params![
                media_id.to_string(),
                job.project_id.to_string(),
                target.asset_id,
                target.storyboard_id,
                completion.output.kind.as_storage_str(),
                target.role.as_storage_str(),
                target.name,
                target.prompt,
                completion.output.mime_type,
                completion.output.object_key,
                completion.output.width,
                completion.output.height,
                completion.output.duration_ms,
                now.to_rfc3339(),
            ],
        )?;
        media_id
    };
    if let ProposalTarget::AssetBindingPrompt { binding_id } = job.target {
        let changed = tx.execute(
            "UPDATE asset_bindings SET derived_media_id = ?1, revision = revision + 1, \
             updated_at = ?2 WHERE id = ?3 AND project_id = ?4 AND storyboard_id = ?5",
            params![
                media_id.to_string(),
                now.to_rfc3339(),
                binding_id.to_string(),
                job.project_id.to_string(),
                job.storyboard_id.to_string(),
            ],
        )?;
        if changed != 1 {
            return Err(ProductError::NotFound);
        }
    }
    job.mark_succeeded(media_id, now)?;
    let changed = tx.execute(
        "UPDATE generation_jobs SET status = 'succeeded', result_media_id = ?1, error = NULL, \
         updated_at = ?2 WHERE id = ?3 AND project_id = ?4 AND status = 'running' \
         AND provider_job_id = ?5",
        params![
            media_id.to_string(),
            job.updated_at.to_rfc3339(),
            job.id.to_string(),
            job.project_id.to_string(),
            job.provider_job_id,
        ],
    )?;
    if changed != 1 {
        return Err(mapping::lost_claim());
    }
    append_event(
        &tx,
        job.project_id,
        "generation.succeeded",
        generation_payload(&job),
    )?;
    tx.commit()?;
    Ok(job)
}

pub(super) fn mark_running_failed(
    connection: &mut Connection,
    failure: GenerationFailure,
) -> ProductResult<GenerationJob> {
    let tx = immediate(connection)?;
    let mut job = mapping::find_by_id(&tx, failure.job.id)?.ok_or(ProductError::NotFound)?;
    if job.project_id != failure.job.project_id {
        return Err(ProductError::NotFound);
    }
    if job.status == GenerationStatus::Failed {
        tx.commit()?;
        return Ok(job);
    }
    if job.status != GenerationStatus::Running || job.provider_job_id != failure.job.provider_job_id
    {
        return Err(mapping::lost_claim());
    }
    job.mark_processing_failed(failure.public_error, Utc::now())?;
    let changed = tx.execute(
        "UPDATE generation_jobs SET status = 'failed', result_media_id = NULL, error = ?1, \
         updated_at = ?2 WHERE id = ?3 AND project_id = ?4 AND status = 'running' \
         AND provider_job_id = ?5",
        params![
            job.error,
            job.updated_at.to_rfc3339(),
            job.id.to_string(),
            job.project_id.to_string(),
            job.provider_job_id,
        ],
    )?;
    if changed != 1 {
        return Err(mapping::lost_claim());
    }
    append_event(
        &tx,
        job.project_id,
        "generation.failed",
        generation_payload(&job),
    )?;
    tx.commit()?;
    Ok(job)
}

pub(super) fn mark_polled(connection: &mut Connection, job: &GenerationJob) -> ProductResult<()> {
    connection.execute(
        "UPDATE generation_jobs SET updated_at = ?1 WHERE id = ?2 AND project_id = ?3 \
         AND status = 'running' AND provider_job_id = ?4",
        params![
            Utc::now().to_rfc3339(),
            job.id.to_string(),
            job.project_id.to_string(),
            job.provider_job_id,
        ],
    )?;
    Ok(())
}

struct CompletionTarget {
    asset_id: Option<String>,
    storyboard_id: Option<String>,
    kind: MediaKind,
    role: MediaRole,
    name: String,
    prompt: String,
}

fn completion_target(tx: &Transaction<'_>, job: &GenerationJob) -> ProductResult<CompletionTarget> {
    match job.target {
        ProposalTarget::MediaPrompt { media_id } => tx
            .query_row(
                "SELECT asset_id, storyboard_id, kind, role, name, COALESCE(prompt, '') \
                 FROM media_items WHERE id = ?1 AND project_id = ?2",
                params![media_id.to_string(), job.project_id.to_string()],
                |row| {
                    let kind: String = row.get(2)?;
                    let role: String = row.get(3)?;
                    Ok(CompletionTarget {
                        asset_id: row.get(0)?,
                        storyboard_id: row.get(1)?,
                        kind: MediaKind::from_storage_str(&kind).ok_or_else(|| {
                            rusqlite::Error::InvalidColumnType(
                                2,
                                "kind".into(),
                                rusqlite::types::Type::Text,
                            )
                        })?,
                        role: MediaRole::from_api_str(&role).ok_or_else(|| {
                            rusqlite::Error::InvalidColumnType(
                                3,
                                "role".into(),
                                rusqlite::types::Type::Text,
                            )
                        })?,
                        name: format!("{} · 生成结果", row.get::<_, String>(4)?),
                        prompt: row.get(5)?,
                    })
                },
            )
            .optional()?
            .ok_or(ProductError::NotFound),
        ProposalTarget::AssetBindingPrompt { binding_id } => tx
            .query_row(
                "SELECT asset.name, COALESCE(binding.prompt_override, asset.canonical_prompt, '') \
                 FROM asset_bindings binding JOIN assets asset ON asset.id = binding.asset_id \
                 AND asset.project_id = binding.project_id \
                 WHERE binding.id = ?1 AND binding.project_id = ?2 AND binding.storyboard_id = ?3",
                params![
                    binding_id.to_string(),
                    job.project_id.to_string(),
                    job.storyboard_id.to_string(),
                ],
                |row| {
                    Ok(CompletionTarget {
                        asset_id: None,
                        storyboard_id: Some(job.storyboard_id.to_string()),
                        kind: MediaKind::Image,
                        role: MediaRole::AssetView,
                        name: format!("{} · 片段派生图", row.get::<_, String>(0)?),
                        prompt: row.get(1)?,
                    })
                },
            )
            .optional()?
            .ok_or(ProductError::NotFound),
        ProposalTarget::Script { .. } => Err(ProductError::Storage(
            "script proposal unexpectedly created a generation job".into(),
        )),
    }
}

fn target_kind(connection: &Connection, job: &GenerationJob) -> ProductResult<MediaKind> {
    match job.target {
        ProposalTarget::MediaPrompt { media_id } => {
            let value = connection
                .query_row(
                    "SELECT kind FROM media_items WHERE id = ?1 AND project_id = ?2",
                    params![media_id.to_string(), job.project_id.to_string()],
                    |row| row.get::<_, String>(0),
                )
                .optional()?
                .ok_or(ProductError::NotFound)?;
            MediaKind::from_storage_str(&value)
                .ok_or_else(|| ProductError::Storage("unknown generation media kind".into()))
        }
        ProposalTarget::AssetBindingPrompt { .. } => Ok(MediaKind::Image),
        ProposalTarget::Script { .. } => Err(ProductError::Storage(
            "script proposal unexpectedly created a generation job".into(),
        )),
    }
}

fn generation_payload(job: &GenerationJob) -> serde_json::Value {
    json!({
        "generationJobId": job.id,
        "proposalId": job.proposal_id,
        "storyboardId": job.storyboard_id,
        "status": job.status,
        "attempt": job.attempt,
        "resultMediaId": job.result_media_id,
    })
}
