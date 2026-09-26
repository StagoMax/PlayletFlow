use crate::product::application::generation::GenerationOutput;
use crate::product::domain::{
    GenerationInputRole, GenerationJobId, GenerationOptions, GenerationSpec, GenerationStatus,
    MediaId, MediaKind,
};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CreateGenerationBody {
    pub prompt: String,
    pub expected_revision: i64,
    pub kind: MediaKind,
    pub generation: Option<CloudGenerationOptions>,
    #[serde(default)]
    pub inputs: Vec<CloudGenerationInput>,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CloudGenerationOptions {
    pub model: Option<String>,
    #[serde(default)]
    pub input: CloudGenerationInputSelection,
    pub image_size: Option<String>,
    pub video_resolution: Option<String>,
    pub video_ratio: Option<String>,
    pub duration_seconds: Option<i64>,
    pub generate_audio: Option<bool>,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    tag = "type"
)]
pub enum CloudGenerationInputSelection {
    #[default]
    TextOnly,
    FirstLastFrames {
        first_frame_media_id: String,
        last_frame_media_id: Option<String>,
    },
    ReferenceImages {
        media_ids: Vec<String>,
    },
}

impl CloudGenerationInputSelection {
    pub fn ids_with_roles(&self) -> Vec<(&str, StoredInputRole)> {
        match self {
            Self::TextOnly => Vec::new(),
            Self::FirstLastFrames {
                first_frame_media_id,
                last_frame_media_id,
            } => std::iter::once((first_frame_media_id.as_str(), StoredInputRole::FirstFrame))
                .chain(
                    last_frame_media_id
                        .iter()
                        .map(|value| (value.as_str(), StoredInputRole::LastFrame)),
                )
                .collect(),
            Self::ReferenceImages { media_ids } => media_ids
                .iter()
                .map(|value| (value.as_str(), StoredInputRole::ReferenceImage))
                .collect(),
        }
    }

    pub fn to_domain(&self, mapped_ids: &[MediaId]) -> GenerationOptionsInput {
        match self {
            Self::TextOnly => GenerationOptionsInput::TextOnly,
            Self::FirstLastFrames {
                last_frame_media_id,
                ..
            } => GenerationOptionsInput::FirstLastFrames {
                first_frame_media_id: mapped_ids[0],
                last_frame_media_id: last_frame_media_id.as_ref().map(|_| mapped_ids[1]),
            },
            Self::ReferenceImages { .. } => GenerationOptionsInput::ReferenceImages {
                media_ids: mapped_ids.to_vec(),
            },
        }
    }
}

pub type GenerationOptionsInput = crate::product::domain::GenerationInputSelection;

impl CloudGenerationOptions {
    pub fn to_domain(&self, mapped_ids: &[MediaId]) -> GenerationOptions {
        GenerationOptions {
            model: self.model.clone(),
            input: self.input.to_domain(mapped_ids),
            image_size: self.image_size.clone(),
            video_resolution: self.video_resolution.clone(),
            video_ratio: self.video_ratio.clone(),
            duration_seconds: self.duration_seconds,
            generate_audio: self.generate_audio,
        }
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CloudGenerationInput {
    pub media_id: String,
    pub mime_type: String,
    pub data_base64: String,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum StoredInputRole {
    FirstFrame,
    LastFrame,
    ReferenceImage,
}

impl StoredInputRole {
    pub fn to_domain(self) -> GenerationInputRole {
        match self {
            Self::FirstFrame => GenerationInputRole::FirstFrame,
            Self::LastFrame => GenerationInputRole::LastFrame,
            Self::ReferenceImage => GenerationInputRole::ReferenceImage,
        }
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StoredGenerationInput {
    pub media_id: MediaId,
    pub role: StoredInputRole,
    pub object_key: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StoredGenerationResult {
    pub object_key: String,
    pub kind: MediaKind,
    pub mime_type: String,
    pub width: Option<i64>,
    pub height: Option<i64>,
    pub duration_ms: Option<i64>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PendingProviderOutput {
    pub url: String,
    pub kind: MediaKind,
    pub mime_type: String,
    pub width: Option<i64>,
    pub height: Option<i64>,
    pub duration_ms: Option<i64>,
}

impl From<GenerationOutput> for PendingProviderOutput {
    fn from(value: GenerationOutput) -> Self {
        Self {
            url: value.url,
            kind: value.kind,
            mime_type: value.mime_type,
            width: value.width,
            height: value.height,
            duration_ms: value.duration_ms,
        }
    }
}

impl From<&PendingProviderOutput> for GenerationOutput {
    fn from(value: &PendingProviderOutput) -> Self {
        Self {
            url: value.url.clone(),
            kind: value.kind,
            mime_type: value.mime_type.clone(),
            width: value.width,
            height: value.height,
            duration_ms: value.duration_ms,
        }
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CloudGenerationRecord {
    pub schema_version: u8,
    pub id: GenerationJobId,
    pub project_id: String,
    pub storyboard_id: String,
    pub target_id: String,
    pub target_revision: i64,
    pub request_fingerprint: String,
    pub prompt: String,
    pub kind: MediaKind,
    pub spec: GenerationSpec,
    pub inputs: Vec<StoredGenerationInput>,
    pub status: GenerationStatus,
    pub attempt: i64,
    pub provider: Option<String>,
    pub provider_job_id: Option<String>,
    pub pending_output: Option<PendingProviderOutput>,
    pub result: Option<StoredGenerationResult>,
    pub error: Option<String>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GeneratedAssetResponse {
    pub object_key: String,
    pub url: String,
    pub expires_at: DateTime<Utc>,
    pub kind: MediaKind,
    pub mime_type: String,
    pub width: Option<i64>,
    pub height: Option<i64>,
    pub duration_ms: Option<i64>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CloudGenerationResponse {
    pub id: GenerationJobId,
    pub project_id: String,
    pub storyboard_id: String,
    pub proposal_id: Option<String>,
    pub target_type: &'static str,
    pub target_id: String,
    pub target_revision: i64,
    pub spec: GenerationSpec,
    pub status: GenerationStatus,
    pub attempt: i64,
    pub provider: Option<String>,
    pub result_media_id: Option<MediaId>,
    pub result: Option<GeneratedAssetResponse>,
    pub error: Option<String>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}
