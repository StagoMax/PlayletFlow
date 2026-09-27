use super::record::{
    CloudGenerationInput, CloudGenerationOptions, CloudGenerationRecord, CloudGenerationResponse,
    CreateGenerationBody, GeneratedAssetResponse, StoredGenerationInput, StoredGenerationResult,
};
use crate::product::application::generation::{
    resolve_generation_spec, GeneratedMediaStore, GenerationPoll, GenerationProvider,
    GenerationRequest, GenerationSubmission,
};
use crate::product::application::object_storage::{
    ObjectStorage, ObjectWriteMode, ObjectWriteOutcome,
};
use crate::product::domain::{
    GenerationJob, GenerationJobId, GenerationStatus, MediaId, ProductError, ProductResult,
    ProjectId, ProposalTarget, ResolvedGenerationInput, StoryboardId,
};
use crate::product::infrastructure::{
    TosObjectStorage, TosObjectStorageConfig, VolcengineGenerationConfig,
    VolcengineGenerationProvider,
};
use base64::engine::general_purpose::STANDARD;
use base64::Engine;
use chrono::{Duration as ChronoDuration, Utc};
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};
use std::sync::Arc;
use std::time::Duration;
use uuid::Uuid;

const RECORD_SCHEMA_VERSION: u8 = 1;
const MAX_INPUT_BYTES: usize = 8 * 1024 * 1024;
const MAX_TOTAL_INPUT_BYTES: usize = 20 * 1024 * 1024;
const SIGNED_URL_TTL: Duration = Duration::from_secs(60 * 60);
const IDEMPOTENCY_NAMESPACE: Uuid = Uuid::from_u128(0xb83735ad_415b_4d8b_ae70_90b2a3ed340d);

#[derive(Clone)]
pub struct CloudGenerationService {
    provider: Arc<dyn GenerationProvider>,
    objects: Arc<dyn ObjectStorage>,
    media_store: Arc<dyn GeneratedMediaStore>,
}

#[derive(Clone, Debug)]
pub struct CreateGenerationCommand {
    pub project_id: String,
    pub storyboard_id: String,
    pub target_id: String,
    pub idempotency_key: String,
    pub body: CreateGenerationBody,
}

struct PreparedInput {
    stored: StoredGenerationInput,
    mime_type: String,
    bytes: Vec<u8>,
}

impl CloudGenerationService {
    pub fn from_env() -> ProductResult<Self> {
        let provider_config = VolcengineGenerationConfig::from_env()?.ok_or_else(|| {
            ProductError::DependencyUnavailable("ARK_API_KEY is not configured".into())
        })?;
        let tos_config = TosObjectStorageConfig::from_env()?.ok_or_else(|| {
            ProductError::DependencyUnavailable("TOS storage is not configured".into())
        })?;
        let provider = Arc::new(VolcengineGenerationProvider::new(provider_config)?);
        let tos = Arc::new(TosObjectStorage::new(tos_config)?);
        Ok(Self {
            provider,
            objects: tos.clone(),
            media_store: tos,
        })
    }

    pub async fn create(
        &self,
        command: CreateGenerationCommand,
    ) -> ProductResult<CloudGenerationResponse> {
        validate_path_segment("projectId", &command.project_id)?;
        validate_path_segment("storyboardId", &command.storyboard_id)?;
        validate_path_segment("mediaId", &command.target_id)?;
        let idempotency_key = command.idempotency_key.trim();
        if idempotency_key.is_empty() || idempotency_key.chars().count() > 200 {
            return Err(ProductError::Validation(
                "Idempotency-Key must contain between 1 and 200 characters".into(),
            ));
        }
        let prompt = command.body.prompt.trim().to_owned();
        if prompt.is_empty() || prompt.chars().count() > 10_000 {
            return Err(ProductError::Validation(
                "generation prompt must contain between 1 and 10,000 characters".into(),
            ));
        }
        if command.body.expected_revision < 1 {
            return Err(ProductError::Validation(
                "expectedRevision must be at least 1".into(),
            ));
        }

        let job_id = GenerationJobId(Uuid::new_v5(
            &IDEMPOTENCY_NAMESPACE,
            format!(
                "{}\n{}\n{}\n{}",
                command.project_id, command.storyboard_id, command.target_id, idempotency_key
            )
            .as_bytes(),
        ));
        let fingerprint = fingerprint(&command.body)?;
        if let Some(existing) = self.load(job_id).await? {
            if existing.request_fingerprint != fingerprint {
                return Err(ProductError::Conflict {
                    code: "IDEMPOTENCY_KEY_REUSED",
                    message: "Idempotency-Key was already used for another generation request"
                        .into(),
                });
            }
            let record = self.advance(existing).await?;
            return self.response(record).await;
        }

        let generation = command.body.generation.clone().unwrap_or_default();
        let (spec, prepared_inputs) =
            prepare_inputs(job_id, command.body.kind, &generation, &command.body.inputs)?;
        for input in &prepared_inputs {
            self.objects
                .put(
                    &input.stored.object_key,
                    &input.mime_type,
                    input.bytes.clone(),
                    ObjectWriteMode::Upsert,
                )
                .await?;
        }

        let now = Utc::now();
        let record = CloudGenerationRecord {
            schema_version: RECORD_SCHEMA_VERSION,
            id: job_id,
            project_id: command.project_id,
            storyboard_id: command.storyboard_id,
            target_id: command.target_id,
            target_revision: command.body.expected_revision + 1,
            request_fingerprint: fingerprint,
            prompt,
            kind: command.body.kind,
            spec,
            inputs: prepared_inputs
                .into_iter()
                .map(|input| input.stored)
                .collect(),
            status: GenerationStatus::Queued,
            attempt: 0,
            provider: None,
            provider_job_id: None,
            pending_output: None,
            result: None,
            error: None,
            created_at: now,
            updated_at: now,
        };
        match self.save(&record, ObjectWriteMode::Create).await? {
            ObjectWriteOutcome::Stored => {}
            ObjectWriteOutcome::AlreadyExists => {
                let existing = self.load(job_id).await?.ok_or_else(|| {
                    ProductError::Storage(
                        "generation record disappeared after create conflict".into(),
                    )
                })?;
                if existing.request_fingerprint != record.request_fingerprint {
                    return Err(ProductError::Conflict {
                        code: "IDEMPOTENCY_KEY_REUSED",
                        message: "Idempotency-Key was already used for another generation request"
                            .into(),
                    });
                }
                return self.response(self.advance(existing).await?).await;
            }
        }
        self.response(self.advance(record).await?).await
    }

    pub async fn get(
        &self,
        project_id: &str,
        job_id: GenerationJobId,
    ) -> ProductResult<CloudGenerationResponse> {
        let record = self.load(job_id).await?.ok_or(ProductError::NotFound)?;
        if record.project_id != project_id {
            return Err(ProductError::NotFound);
        }
        self.response(self.advance(record).await?).await
    }

    async fn advance(
        &self,
        mut record: CloudGenerationRecord,
    ) -> ProductResult<CloudGenerationRecord> {
        if record.status == GenerationStatus::Running && record.pending_output.is_some() {
            return self.persist_pending_output(record).await;
        }
        match record.status {
            GenerationStatus::Queued | GenerationStatus::WaitingForProvider => {
                let request = self.provider_request(&record).await?;
                match self.provider.submit(&request).await {
                    Ok(GenerationSubmission::Pending { provider_job_id }) => {
                        record.status = GenerationStatus::Running;
                        record.attempt += 1;
                        record.provider = Some(self.provider.name().to_owned());
                        record.provider_job_id = Some(provider_job_id);
                        record.error = None;
                        record.updated_at = Utc::now();
                        self.save(&record, ObjectWriteMode::Upsert).await?;
                    }
                    Ok(GenerationSubmission::Succeeded {
                        provider_job_id,
                        output,
                    }) => {
                        record.status = GenerationStatus::Running;
                        record.attempt += 1;
                        record.provider = Some(self.provider.name().to_owned());
                        record.provider_job_id = Some(provider_job_id);
                        record.pending_output = Some(output.into());
                        record.error = None;
                        record.updated_at = Utc::now();
                        self.save(&record, ObjectWriteMode::Upsert).await?;
                        return self.persist_pending_output(record).await;
                    }
                    Err(ProductError::DependencyUnavailable(cause)) => {
                        eprintln!("generation submission deferred for {}: {cause}", record.id);
                        record.status = GenerationStatus::WaitingForProvider;
                        record.updated_at = Utc::now();
                        self.save(&record, ObjectWriteMode::Upsert).await?;
                    }
                    Err(cause @ ProductError::ProviderRejected { .. }) => {
                        let public_error = cause.to_string();
                        eprintln!(
                            "generation submission failed for {}: {public_error}",
                            record.id
                        );
                        fail(&mut record, &public_error);
                        self.save(&record, ObjectWriteMode::Upsert).await?;
                    }
                    Err(cause) => {
                        eprintln!("generation submission failed for {}: {cause}", record.id);
                        fail(&mut record, "generation provider submission failed");
                        self.save(&record, ObjectWriteMode::Upsert).await?;
                    }
                }
            }
            GenerationStatus::Running => {
                let job = provider_job(&record);
                match self.provider.poll(&job, record.kind).await {
                    Ok(GenerationPoll::Pending) => {
                        record.updated_at = Utc::now();
                        self.save(&record, ObjectWriteMode::Upsert).await?;
                    }
                    Ok(GenerationPoll::Succeeded(output)) => {
                        record.pending_output = Some(output.into());
                        record.updated_at = Utc::now();
                        self.save(&record, ObjectWriteMode::Upsert).await?;
                        return self.persist_pending_output(record).await;
                    }
                    Ok(GenerationPoll::Failed) => {
                        fail(&mut record, "generation provider processing failed");
                        self.save(&record, ObjectWriteMode::Upsert).await?;
                    }
                    Err(ProductError::DependencyUnavailable(cause)) => {
                        eprintln!("generation poll deferred for {}: {cause}", record.id);
                    }
                    Err(cause) => {
                        eprintln!("generation poll failed for {}: {cause}", record.id);
                        fail(&mut record, "generation provider processing failed");
                        self.save(&record, ObjectWriteMode::Upsert).await?;
                    }
                }
            }
            GenerationStatus::Succeeded
            | GenerationStatus::Failed
            | GenerationStatus::Cancelled => {}
        }
        Ok(record)
    }

    async fn persist_pending_output(
        &self,
        mut record: CloudGenerationRecord,
    ) -> ProductResult<CloudGenerationRecord> {
        let output = record.pending_output.as_ref().ok_or_else(|| {
            ProductError::Storage("running generation has no pending output".into())
        })?;
        match self.media_store.store(record.id, &output.into()).await {
            Ok(stored) => {
                record.result = Some(StoredGenerationResult {
                    object_key: stored.object_key,
                    kind: stored.kind,
                    mime_type: stored.mime_type,
                    width: stored.width,
                    height: stored.height,
                    duration_ms: stored.duration_ms,
                });
                record.pending_output = None;
                record.status = GenerationStatus::Succeeded;
                record.error = None;
                record.updated_at = Utc::now();
                self.save(&record, ObjectWriteMode::Upsert).await?;
            }
            Err(ProductError::DependencyUnavailable(cause)) => {
                eprintln!(
                    "generated media persistence deferred for {}: {cause}",
                    record.id
                );
            }
            Err(cause) => {
                eprintln!(
                    "generated media persistence failed for {}: {cause}",
                    record.id
                );
                fail(&mut record, "generated media could not be persisted");
                self.save(&record, ObjectWriteMode::Upsert).await?;
            }
        }
        Ok(record)
    }

    async fn provider_request(
        &self,
        record: &CloudGenerationRecord,
    ) -> ProductResult<GenerationRequest> {
        let mut inputs = Vec::with_capacity(record.inputs.len());
        for input in &record.inputs {
            inputs.push(ResolvedGenerationInput {
                media_id: input.media_id,
                role: input.role.to_domain(),
                url: self
                    .objects
                    .signed_get_url(&input.object_key, SIGNED_URL_TTL)
                    .await?,
            });
        }
        Ok(GenerationRequest {
            job: provider_job(record),
            prompt: record.prompt.clone(),
            kind: record.kind,
            inputs,
        })
    }

    async fn load(&self, id: GenerationJobId) -> ProductResult<Option<CloudGenerationRecord>> {
        let Some(object) = self.objects.get(&record_key(id)).await? else {
            return Ok(None);
        };
        let record =
            serde_json::from_slice::<CloudGenerationRecord>(&object.bytes).map_err(|error| {
                ProductError::Storage(format!("invalid generation record: {error}"))
            })?;
        if record.schema_version != RECORD_SCHEMA_VERSION || record.id != id {
            return Err(ProductError::Storage(
                "generation record identity or schema does not match".into(),
            ));
        }
        Ok(Some(record))
    }

    async fn save(
        &self,
        record: &CloudGenerationRecord,
        mode: ObjectWriteMode,
    ) -> ProductResult<ObjectWriteOutcome> {
        let bytes = serde_json::to_vec(record).map_err(|error| {
            ProductError::Storage(format!("serialize generation record: {error}"))
        })?;
        self.objects
            .put(&record_key(record.id), "application/json", bytes, mode)
            .await
    }

    async fn response(
        &self,
        record: CloudGenerationRecord,
    ) -> ProductResult<CloudGenerationResponse> {
        let result = if let Some(result) = &record.result {
            let expires_at = Utc::now()
                + ChronoDuration::from_std(SIGNED_URL_TTL)
                    .expect("signed URL duration fits chrono");
            Some(GeneratedAssetResponse {
                object_key: result.object_key.clone(),
                url: self
                    .objects
                    .signed_get_url(&result.object_key, SIGNED_URL_TTL)
                    .await?,
                expires_at,
                kind: result.kind,
                mime_type: result.mime_type.clone(),
                width: result.width,
                height: result.height,
                duration_ms: result.duration_ms,
            })
        } else {
            None
        };
        Ok(CloudGenerationResponse {
            id: record.id,
            project_id: record.project_id,
            storyboard_id: record.storyboard_id,
            proposal_id: None,
            target_type: "mediaPrompt",
            target_id: record.target_id,
            target_revision: record.target_revision,
            spec: record.spec,
            status: record.status,
            attempt: record.attempt,
            provider: record.provider,
            result_media_id: record.result.as_ref().map(|_| MediaId(record.id.0)),
            result,
            error: record.error,
            created_at: record.created_at,
            updated_at: record.updated_at,
        })
    }
}

fn prepare_inputs(
    job_id: GenerationJobId,
    kind: crate::product::domain::MediaKind,
    generation: &CloudGenerationOptions,
    payloads: &[CloudGenerationInput],
) -> ProductResult<(crate::product::domain::GenerationSpec, Vec<PreparedInput>)> {
    let expected = generation.input.ids_with_roles();
    let expected_ids = expected.iter().map(|(id, _)| *id).collect::<HashSet<_>>();
    if expected_ids.len() != expected.len() {
        return Err(ProductError::Validation(
            "generation input media IDs must be unique".into(),
        ));
    }
    let payload_map = payloads
        .iter()
        .map(|payload| (payload.media_id.as_str(), payload))
        .collect::<HashMap<_, _>>();
    if payload_map.len() != payloads.len()
        || payload_map.len() != expected.len()
        || payload_map.keys().any(|id| !expected_ids.contains(id))
    {
        return Err(ProductError::Validation(
            "generation input payloads must exactly match the selected media IDs".into(),
        ));
    }

    let mapped_ids = expected.iter().map(|_| MediaId::new()).collect::<Vec<_>>();
    let spec = resolve_generation_spec(kind, Some(generation.to_domain(&mapped_ids)))?;
    let mut total = 0usize;
    let mut prepared = Vec::with_capacity(expected.len());
    for ((source_id, role), media_id) in expected.into_iter().zip(mapped_ids) {
        let payload = payload_map[source_id];
        let extension = input_extension(&payload.mime_type)?;
        let bytes = STANDARD
            .decode(payload.data_base64.as_bytes())
            .map_err(|_| {
                ProductError::Validation("generation input contains invalid base64 data".into())
            })?;
        if bytes.is_empty() || bytes.len() > MAX_INPUT_BYTES {
            return Err(ProductError::Validation(format!(
                "each generation input must contain between 1 byte and {MAX_INPUT_BYTES} bytes"
            )));
        }
        total = total.saturating_add(bytes.len());
        if total > MAX_TOTAL_INPUT_BYTES {
            return Err(ProductError::Validation(format!(
                "generation inputs exceed the {MAX_TOTAL_INPUT_BYTES} byte total limit"
            )));
        }
        prepared.push(PreparedInput {
            stored: StoredGenerationInput {
                media_id,
                role,
                object_key: format!("inputs/{job_id}/{media_id}.{extension}"),
            },
            mime_type: payload.mime_type.clone(),
            bytes,
        });
    }
    Ok((spec, prepared))
}

fn input_extension(mime_type: &str) -> ProductResult<&'static str> {
    match mime_type {
        "image/jpeg" => Ok("jpg"),
        "image/png" => Ok("png"),
        "image/webp" => Ok("webp"),
        _ => Err(ProductError::Validation(
            "generation inputs must be JPEG, PNG, or WebP images".into(),
        )),
    }
}

fn fingerprint(body: &CreateGenerationBody) -> ProductResult<String> {
    let bytes = serde_json::to_vec(body).map_err(|error| {
        ProductError::Validation(format!("invalid generation request: {error}"))
    })?;
    Ok(Sha256::digest(bytes)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect())
}

fn record_key(id: GenerationJobId) -> String {
    format!("jobs/{id}.json")
}

fn provider_job(record: &CloudGenerationRecord) -> GenerationJob {
    GenerationJob {
        id: record.id,
        project_id: ProjectId(record.id.0),
        storyboard_id: StoryboardId(record.id.0),
        proposal_id: None,
        target: ProposalTarget::MediaPrompt {
            media_id: MediaId(record.id.0),
        },
        target_revision: record.target_revision,
        spec: record.spec.clone(),
        status: record.status,
        attempt: record.attempt,
        provider: record.provider.clone(),
        provider_job_id: record.provider_job_id.clone(),
        result_media_id: record.result.as_ref().map(|_| MediaId(record.id.0)),
        error: record.error.clone(),
        created_at: record.created_at,
        updated_at: record.updated_at,
    }
}

fn fail(record: &mut CloudGenerationRecord, public_error: &str) {
    record.status = GenerationStatus::Failed;
    record.pending_output = None;
    record.result = None;
    record.error = Some(public_error.into());
    record.updated_at = Utc::now();
}

fn validate_path_segment(name: &str, value: &str) -> ProductResult<()> {
    let length = value.chars().count();
    if value.trim().is_empty() || length > 200 {
        return Err(ProductError::Validation(format!(
            "{name} must contain between 1 and 200 characters"
        )));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::super::record::CloudGenerationInputSelection;
    use super::*;
    use crate::product::domain::MediaKind;

    #[test]
    fn selected_inputs_must_have_exact_payloads() {
        let options = CloudGenerationOptions {
            input: CloudGenerationInputSelection::ReferenceImages {
                media_ids: vec!["frame-a".into()],
            },
            ..CloudGenerationOptions::default()
        };
        let missing = prepare_inputs(GenerationJobId::new(), MediaKind::Image, &options, &[]);
        assert!(missing.is_err());

        let valid = prepare_inputs(
            GenerationJobId::new(),
            MediaKind::Image,
            &options,
            &[CloudGenerationInput {
                media_id: "frame-a".into(),
                mime_type: "image/png".into(),
                data_base64: STANDARD.encode([1, 2, 3]),
            }],
        )
        .unwrap();
        assert_eq!(valid.1.len(), 1);
    }
}
