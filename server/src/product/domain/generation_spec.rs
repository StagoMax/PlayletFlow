use super::{MediaId, MediaKind, ProductError, ProductResult};
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[serde(
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    tag = "type",
    deny_unknown_fields
)]
pub enum GenerationInputSelection {
    #[default]
    TextOnly,
    FirstLastFrames {
        first_frame_media_id: MediaId,
        last_frame_media_id: Option<MediaId>,
    },
    ReferenceImages {
        media_ids: Vec<MediaId>,
    },
}

impl GenerationInputSelection {
    pub fn media_ids(&self) -> Vec<MediaId> {
        match self {
            Self::TextOnly => Vec::new(),
            Self::FirstLastFrames {
                first_frame_media_id,
                last_frame_media_id,
            } => std::iter::once(*first_frame_media_id)
                .chain(last_frame_media_id.iter().copied())
                .collect(),
            Self::ReferenceImages { media_ids } => media_ids.clone(),
        }
    }
}

#[derive(Clone, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GenerationOptions {
    pub model: Option<String>,
    #[serde(default)]
    pub input: GenerationInputSelection,
    pub image_size: Option<String>,
    pub video_resolution: Option<String>,
    pub video_ratio: Option<String>,
    pub duration_seconds: Option<i64>,
    pub generate_audio: Option<bool>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GenerationSpec {
    pub model: String,
    pub input: GenerationInputSelection,
    pub image_size: Option<String>,
    pub video_resolution: Option<String>,
    pub video_ratio: Option<String>,
    pub duration_seconds: Option<i64>,
    pub generate_audio: Option<bool>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum GenerationInputRole {
    FirstFrame,
    LastFrame,
    ReferenceImage,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ResolvedGenerationInput {
    pub media_id: MediaId,
    pub role: GenerationInputRole,
    pub url: String,
}

impl GenerationSpec {
    pub fn validate_for_kind(&self, kind: MediaKind) -> ProductResult<()> {
        match (kind, &self.input) {
            (MediaKind::Image, GenerationInputSelection::FirstLastFrames { .. }) => {
                return Err(ProductError::Validation(
                    "first/last frames are only valid for video generation".into(),
                ));
            }
            (_, GenerationInputSelection::ReferenceImages { media_ids })
                if media_ids.is_empty() =>
            {
                return Err(ProductError::Validation(
                    "referenceImages requires at least one media item".into(),
                ));
            }
            _ => {}
        }
        Ok(())
    }
}
