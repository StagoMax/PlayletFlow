use super::{mapping, storage};
use crate::product::application::generation::{
    resolve_generation_spec, ClaimedGenerationJob, GenerationRequest, RequestMediaGeneration,
    RetryGenerationJob,
};
use crate::product::domain::{
    GenerationJob, GenerationJobId, GenerationStatus, MediaKind, OutboxEventId, ProductError,
    ProductResult, ProjectId, ProposalTarget,
};
use crate::product::infrastructure::sqlite::proposals::target;
use crate::product::infrastructure::sqlite::support::{append_event, immediate, remember, replay};
use chrono::{DateTime, Utc};
use rusqlite::{params, Connection, OptionalExtension, Transaction};
use serde_json::{json, Value};
use uuid::Uuid;

pub(super) fn request_media(
    connection: &mut Connection,
    command: RequestMediaGeneration,
) -> ProductResult<GenerationJob> {
    let tx = immediate(connection)?;
    if let Some(job) = replay(&tx, &command.idempotency)? {
        tx.commit()?;
        return Ok(job);
    }
    target::ensure_storyboard(&tx, command.project_id, command.storyboard_id)?;
    let target = ProposalTarget::MediaPrompt {
        media_id: command.media_id,
    };
    let snapshot = target::snapshot(&tx, command.project_id, command.storyboard_id, &target)?
        .ok_or(ProductError::NotFound)?;
    if snapshot.revision != command.expected_revision {
        return Err(ProductError::RevisionConflict {
            expected: command.expected_revision,
            actual: snapshot.revision,
        });
    }
    let kind = target::media_kind(
        &tx,
        command.project_id,
        command.storyboard_id,
        command.media_id,
    )?;
    let spec = resolve_generation_spec(kind, command.generation_options)?;
    storage::validate_inputs(&tx, command.project_id, command.storyboard_id, &spec)?;
    let target_revision = target::apply(
        &tx,
        command.project_id,
        command.storyboard_id,
        &target,
        &command.prompt,
        command.expected_revision,
    )?;
    let now = Utc::now();
    let job = GenerationJob {
        id: GenerationJobId::new(),
        project_id: command.project_id,
        storyboard_id: command.storyboard_id,
        proposal_id: None,
        target,
        target_revision,
        spec,
        status: GenerationStatus::WaitingForProvider,
        attempt: 0,
        provider: None,
        provider_job_id: None,
        result_media_id: None,
        error: None,
        created_at: now,
        updated_at: now,
    };
    storage::insert(&tx, &job)?;
    storage::append_requested(&tx, &job)?;
    remember(&tx, &command.idempotency, &job)?;
    tx.commit()?;
    Ok(job)
}

pub(super) fn retry(
    connection: &mut Connection,
    command: RetryGenerationJob,
) -> ProductResult<GenerationJob> {
    let tx = immediate(connection)?;
    if let Some(job) = replay(&tx, &command.idempotency)? {
        tx.commit()?;
        return Ok(job);
    }
    let mut job =
        mapping::find(&tx, command.project_id, command.job_id)?.ok_or(ProductError::NotFound)?;
    let expected_attempt = job.attempt;
    job.retry(Utc::now()).map_err(|error| match error {
        ProductError::Conflict { .. } => ProductError::Conflict {
            code: "GENERATION_NOT_RETRYABLE",
            message: "only failed generation jobs can be retried".into(),
        },
        other => other,
    })?;
    ensure_target_revision(&tx, &job)?;
    let changed = tx.execute(
        "UPDATE generation_jobs SET status = ?1, provider = NULL, provider_job_id = NULL, \
         result_media_id = NULL, error = NULL, updated_at = ?2 \
         WHERE id = ?3 AND project_id = ?4 AND status = 'failed' AND attempt = ?5",
        params![
            job.status.as_storage_str(),
            job.updated_at.to_rfc3339(),
            job.id.to_string(),
            job.project_id.to_string(),
            expected_attempt,
        ],
    )?;
    if changed == 0 {
        return Err(mapping::lost_claim());
    }
    storage::append_requested(&tx, &job)?;
    append_event(
        &tx,
        job.project_id,
        "generation.retried",
        generation_payload(&job),
    )?;
    remember(&tx, &command.idempotency, &job)?;
    tx.commit()?;
    Ok(job)
}

pub(super) fn claim_next(
    connection: &mut Connection,
    claimed_at: DateTime<Utc>,
    stale_before: DateTime<Utc>,
) -> ProductResult<Option<ClaimedGenerationJob>> {
    let tx = immediate(connection)?;
    tx.execute(
        "UPDATE generation_jobs SET status = 'waitingForProvider', updated_at = ?1 \
         WHERE status = 'queued' AND updated_at <= ?2",
        params![claimed_at.to_rfc3339(), stale_before.to_rfc3339()],
    )?;

    let candidates = unpublished_requests(&tx)?;
    for candidate in candidates {
        let job_id = generation_job_id(&candidate.payload)?;
        let Some(mut job) = mapping::find_by_id(&tx, job_id)? else {
            return Err(ProductError::Storage(format!(
                "generation outbox event {} references a missing job",
                candidate.event_id
            )));
        };
        if job.project_id != candidate.project_id {
            return Err(ProductError::Storage(format!(
                "generation outbox event {} has a mismatched project",
                candidate.event_id
            )));
        }
        if job.status != GenerationStatus::WaitingForProvider {
            if job.status != GenerationStatus::Queued {
                mark_published(&tx, candidate.event_id, claimed_at)?;
            }
            continue;
        }
        let Some(snapshot) = target_snapshot(&tx, &job)? else {
            cancel_stale_job(&tx, &mut job, candidate.event_id, claimed_at)?;
            continue;
        };
        if snapshot.revision != job.target_revision || snapshot.prompt.trim().is_empty() {
            cancel_stale_job(&tx, &mut job, candidate.event_id, claimed_at)?;
            continue;
        }
        let expected_attempt = job.attempt;
        job.claim(claimed_at)?;
        let changed = tx.execute(
            "UPDATE generation_jobs SET status = 'queued', updated_at = ?1 \
             WHERE id = ?2 AND project_id = ?3 AND status = 'waitingForProvider' AND attempt = ?4",
            params![
                job.updated_at.to_rfc3339(),
                job.id.to_string(),
                job.project_id.to_string(),
                expected_attempt,
            ],
        )?;
        if changed == 0 {
            continue;
        }
        tx.commit()?;
        return Ok(Some(ClaimedGenerationJob {
            event_id: candidate.event_id,
            request: GenerationRequest {
                job,
                prompt: snapshot.prompt,
                kind: snapshot.kind,
                inputs: Vec::new(),
            },
        }));
    }
    tx.commit()?;
    Ok(None)
}

pub(super) fn defer_claim(
    connection: &mut Connection,
    mut claim: ClaimedGenerationJob,
) -> ProductResult<GenerationJob> {
    let tx = immediate(connection)?;
    let expected_attempt = claim.request.job.attempt;
    claim.request.job.defer_for_provider(Utc::now())?;
    let changed = tx.execute(
        "UPDATE generation_jobs SET status = 'waitingForProvider', updated_at = ?1 \
         WHERE id = ?2 AND project_id = ?3 AND status = 'queued' AND attempt = ?4",
        params![
            claim.request.job.updated_at.to_rfc3339(),
            claim.request.job.id.to_string(),
            claim.request.job.project_id.to_string(),
            expected_attempt,
        ],
    )?;
    if changed == 0 {
        return Err(mapping::lost_claim());
    }
    tx.commit()?;
    Ok(claim.request.job)
}

pub(super) fn mark_submitted(
    connection: &mut Connection,
    mut claim: ClaimedGenerationJob,
    provider: String,
    provider_job_id: String,
) -> ProductResult<GenerationJob> {
    let tx = immediate(connection)?;
    let expected_attempt = claim.request.job.attempt;
    claim
        .request
        .job
        .mark_submitted(provider, provider_job_id, Utc::now())?;
    let changed = tx.execute(
        "UPDATE generation_jobs SET status = 'running', attempt = ?1, provider = ?2, \
         provider_job_id = ?3, error = NULL, updated_at = ?4 \
         WHERE id = ?5 AND project_id = ?6 AND status = 'queued' AND attempt = ?7",
        params![
            claim.request.job.attempt,
            claim.request.job.provider,
            claim.request.job.provider_job_id,
            claim.request.job.updated_at.to_rfc3339(),
            claim.request.job.id.to_string(),
            claim.request.job.project_id.to_string(),
            expected_attempt,
        ],
    )?;
    if changed == 0 {
        return Err(mapping::lost_claim());
    }
    mark_published(&tx, claim.event_id, claim.request.job.updated_at)?;
    append_event(
        &tx,
        claim.request.job.project_id,
        "generation.running",
        generation_payload(&claim.request.job),
    )?;
    tx.commit()?;
    Ok(claim.request.job)
}

pub(super) fn mark_submission_failed(
    connection: &mut Connection,
    mut claim: ClaimedGenerationJob,
    provider: String,
    public_error: String,
) -> ProductResult<GenerationJob> {
    let tx = immediate(connection)?;
    let expected_attempt = claim.request.job.attempt;
    claim.request.job.provider = Some(provider);
    claim
        .request
        .job
        .mark_submission_failed(public_error, Utc::now())?;
    let changed = tx.execute(
        "UPDATE generation_jobs SET status = 'failed', attempt = ?1, provider = ?2, \
         provider_job_id = NULL, result_media_id = NULL, error = ?3, updated_at = ?4 \
         WHERE id = ?5 AND project_id = ?6 AND status = 'queued' AND attempt = ?7",
        params![
            claim.request.job.attempt,
            claim.request.job.provider,
            claim.request.job.error,
            claim.request.job.updated_at.to_rfc3339(),
            claim.request.job.id.to_string(),
            claim.request.job.project_id.to_string(),
            expected_attempt,
        ],
    )?;
    if changed == 0 {
        return Err(mapping::lost_claim());
    }
    mark_published(&tx, claim.event_id, claim.request.job.updated_at)?;
    append_event(
        &tx,
        claim.request.job.project_id,
        "generation.failed",
        generation_payload(&claim.request.job),
    )?;
    tx.commit()?;
    Ok(claim.request.job)
}

struct OutboxCandidate {
    event_id: OutboxEventId,
    project_id: ProjectId,
    payload: Value,
}

fn unpublished_requests(tx: &Transaction<'_>) -> ProductResult<Vec<OutboxCandidate>> {
    let mut statement = tx.prepare(
        "SELECT id, project_id, payload_json FROM product_outbox_events \
         WHERE published_at IS NULL AND event_type = 'generation.requested' \
         ORDER BY seq LIMIT 100",
    )?;
    let rows = statement.query_map([], |row| {
        let event_id: String = row.get(0)?;
        let project_id: String = row.get(1)?;
        let payload: String = row.get(2)?;
        Ok((event_id, project_id, payload))
    })?;
    let mut candidates = Vec::new();
    for row in rows {
        let (event_id, project_id, payload) = row?;
        candidates.push(OutboxCandidate {
            event_id: OutboxEventId(parse_uuid("outbox event id", &event_id)?),
            project_id: ProjectId(parse_uuid("outbox project id", &project_id)?),
            payload: serde_json::from_str(&payload)
                .map_err(|error| ProductError::Storage(error.to_string()))?,
        });
    }
    Ok(candidates)
}

fn generation_job_id(payload: &Value) -> ProductResult<GenerationJobId> {
    let value = payload
        .get("generationJobId")
        .and_then(Value::as_str)
        .ok_or_else(|| {
            ProductError::Storage("generation outbox payload has no generationJobId".into())
        })?;
    Ok(GenerationJobId(parse_uuid("generation job id", value)?))
}

fn parse_uuid(name: &str, value: &str) -> ProductResult<Uuid> {
    Uuid::parse_str(value)
        .map_err(|error| ProductError::Storage(format!("invalid {name}: {error}")))
}

fn mark_published(
    tx: &Transaction<'_>,
    event_id: OutboxEventId,
    occurred_at: DateTime<Utc>,
) -> ProductResult<()> {
    tx.execute(
        "UPDATE product_outbox_events SET published_at = ?1 \
         WHERE id = ?2 AND published_at IS NULL",
        params![occurred_at.to_rfc3339(), event_id.to_string()],
    )?;
    Ok(())
}

fn generation_payload(job: &GenerationJob) -> Value {
    json!({
        "generationJobId": job.id,
        "proposalId": job.proposal_id,
        "storyboardId": job.storyboard_id,
        "status": job.status,
        "attempt": job.attempt,
    })
}

fn ensure_target_revision(tx: &Transaction<'_>, job: &GenerationJob) -> ProductResult<()> {
    match target_snapshot(tx, job)? {
        Some(snapshot)
            if snapshot.revision == job.target_revision && !snapshot.prompt.trim().is_empty() =>
        {
            Ok(())
        }
        _ => Err(ProductError::Conflict {
            code: "GENERATION_TARGET_CHANGED",
            message: "generation target changed after this job was created".into(),
        }),
    }
}

fn target_snapshot(
    tx: &Transaction<'_>,
    job: &GenerationJob,
) -> ProductResult<Option<TargetSnapshot>> {
    let snapshot = match &job.target {
        ProposalTarget::MediaPrompt { media_id } => tx
            .query_row(
                "SELECT revision, COALESCE(prompt, ''), kind FROM media_items \
                 WHERE id = ?1 AND project_id = ?2 AND deleted_at IS NULL \
                   AND (storyboard_id = ?3 OR EXISTS( \
                       SELECT 1 FROM asset_bindings binding \
                       JOIN assets asset ON asset.id = binding.asset_id \
                          AND asset.project_id = binding.project_id \
                       WHERE binding.asset_id = media_items.asset_id \
                         AND binding.project_id = media_items.project_id \
                         AND binding.storyboard_id = ?3 AND asset.deleted_at IS NULL \
                   ))",
                params![
                    media_id.to_string(),
                    job.project_id.to_string(),
                    job.storyboard_id.to_string()
                ],
                |row| {
                    let kind: String = row.get(2)?;
                    let kind = MediaKind::from_storage_str(&kind).ok_or_else(|| {
                        rusqlite::Error::InvalidColumnType(
                            2,
                            "kind".into(),
                            rusqlite::types::Type::Text,
                        )
                    })?;
                    Ok(TargetSnapshot {
                        revision: row.get(0)?,
                        prompt: row.get(1)?,
                        kind,
                    })
                },
            )
            .optional()?,
        ProposalTarget::AssetBindingPrompt { binding_id } => tx
            .query_row(
                "SELECT binding.revision, \
                        COALESCE(binding.prompt_override, asset.canonical_prompt, '') \
                 FROM asset_bindings binding \
                 JOIN assets asset ON asset.id = binding.asset_id \
                    AND asset.project_id = binding.project_id \
                 JOIN storyboards board ON board.id = binding.storyboard_id \
                    AND board.project_id = binding.project_id \
                 WHERE binding.id = ?1 AND binding.project_id = ?2 \
                   AND binding.storyboard_id = ?3 AND asset.deleted_at IS NULL \
                   AND board.deleted_at IS NULL",
                params![
                    binding_id.to_string(),
                    job.project_id.to_string(),
                    job.storyboard_id.to_string()
                ],
                |row| {
                    Ok(TargetSnapshot {
                        revision: row.get(0)?,
                        prompt: row.get(1)?,
                        kind: MediaKind::Image,
                    })
                },
            )
            .optional()?,
        ProposalTarget::Script { .. } => None,
    };
    Ok(snapshot)
}

struct TargetSnapshot {
    revision: i64,
    prompt: String,
    kind: MediaKind,
}

fn cancel_stale_job(
    tx: &Transaction<'_>,
    job: &mut GenerationJob,
    event_id: OutboxEventId,
    occurred_at: DateTime<Utc>,
) -> ProductResult<()> {
    let expected_attempt = job.attempt;
    job.cancel(
        "generation target changed before submission".into(),
        occurred_at,
    )?;
    let changed = tx.execute(
        "UPDATE generation_jobs SET status = 'cancelled', provider_job_id = NULL, \
         result_media_id = NULL, error = ?1, updated_at = ?2 \
         WHERE id = ?3 AND project_id = ?4 AND status = 'waitingForProvider' AND attempt = ?5",
        params![
            job.error,
            job.updated_at.to_rfc3339(),
            job.id.to_string(),
            job.project_id.to_string(),
            expected_attempt,
        ],
    )?;
    if changed == 0 {
        return Err(mapping::lost_claim());
    }
    mark_published(tx, event_id, occurred_at)?;
    append_event(
        tx,
        job.project_id,
        "generation.cancelled",
        generation_payload(job),
    )
}
