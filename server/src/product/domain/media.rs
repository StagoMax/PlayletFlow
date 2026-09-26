use super::{AssetId, MediaId, ProjectId, StoryboardId};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum MediaKind {
    Image,
    Video,
}

impl MediaKind {
    pub const fn as_storage_str(self) -> &'static str {
        match self {
            Self::Image => "image",
            Self::Video => "video",
        }
    }

    pub fn from_storage_str(value: &str) -> Option<Self> {
        match value {
            "image" => Some(Self::Image),
            "video" => Some(Self::Video),
            _ => None,
        }
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, Hash, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum MediaRole {
    AssetView,
    FirstFrame,
    LastFrame,
    Keyframe,
    GeneratedVideo,
    Custom,
}

impl MediaRole {
    pub const fn as_storage_str(self) -> &'static str {
        match self {
            Self::AssetView => "assetView",
            Self::FirstFrame => "firstFrame",
            Self::LastFrame => "lastFrame",
            Self::Keyframe => "keyframe",
            Self::GeneratedVideo => "generatedVideo",
            Self::Custom => "custom",
        }
    }

    pub fn from_api_str(value: &str) -> Option<Self> {
        match value {
            "assetView" => Some(Self::AssetView),
            "firstFrame" => Some(Self::FirstFrame),
            "lastFrame" => Some(Self::LastFrame),
            "keyframe" => Some(Self::Keyframe),
            "generatedVideo" => Some(Self::GeneratedVideo),
            "custom" => Some(Self::Custom),
            _ => None,
        }
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum MediaStatus {
    Placeholder,
    Ready,
    Processing,
    Failed,
}

impl MediaStatus {
    pub const fn as_storage_str(self) -> &'static str {
        match self {
            Self::Placeholder => "placeholder",
            Self::Ready => "ready",
            Self::Processing => "processing",
            Self::Failed => "failed",
        }
    }

    pub fn from_storage_str(value: &str) -> Option<Self> {
        match value {
            "placeholder" => Some(Self::Placeholder),
            "ready" => Some(Self::Ready),
            "processing" => Some(Self::Processing),
            "failed" => Some(Self::Failed),
            _ => None,
        }
    }
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    tag = "type"
)]
pub enum MediaOwner {
    Asset { asset_id: AssetId },
    Storyboard { storyboard_id: StoryboardId },
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaItem {
    pub id: MediaId,
    pub project_id: ProjectId,
    pub owner: MediaOwner,
    pub kind: MediaKind,
    pub role: MediaRole,
    pub name: String,
    pub prompt: Option<String>,
    pub mime_type: String,
    /// Internal object-store locator. API DTOs must never serialize this field.
    pub source_object_key: Option<String>,
    /// Internal object-store locator. API DTOs must never serialize this field.
    pub thumbnail_object_key: Option<String>,
    pub width: Option<i64>,
    pub height: Option<i64>,
    pub duration_ms: Option<i64>,
    pub status: MediaStatus,
    pub revision: i64,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
    pub deleted_at: Option<DateTime<Utc>>,
}

impl MediaItem {
    pub fn storyboard_id(&self) -> Option<StoryboardId> {
        match self.owner {
            MediaOwner::Storyboard { storyboard_id } => Some(storyboard_id),
            MediaOwner::Asset { .. } => None,
        }
    }
}
