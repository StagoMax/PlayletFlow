use crate::product::application::storyboards::StoryboardWindow;
use crate::product::domain::{
    Project, StoryboardCatalogEntry, StoryboardId, StoryboardScript, StoryboardSnapshot,
};
use chrono::{DateTime, Utc};
use serde::Serialize;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectListResponse {
    pub items: Vec<Project>,
    pub page: Page,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Page {
    pub next_cursor: Option<String>,
    pub total: usize,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StoryboardWindowResponse {
    pub items: Vec<StoryboardSummaryResponse>,
    pub page: StoryboardWindowPageResponse,
}

impl From<StoryboardWindow> for StoryboardWindowResponse {
    fn from(window: StoryboardWindow) -> Self {
        let items = window
            .items
            .into_iter()
            .enumerate()
            .map(|(offset, entry)| {
                StoryboardSummaryResponse::from_entry(entry, window.start_index + offset)
            })
            .collect();
        Self {
            items,
            page: StoryboardWindowPageResponse {
                anchor_id: window.anchor_id,
                anchor_index: window.anchor_index,
                total: window.total,
                has_before: window.has_before,
                has_after: window.has_after,
                previous_cursor: window.previous_cursor,
                next_cursor: window.next_cursor,
            },
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StoryboardWindowPageResponse {
    pub anchor_id: Option<StoryboardId>,
    pub anchor_index: Option<usize>,
    pub total: usize,
    pub has_before: bool,
    pub has_after: bool,
    pub previous_cursor: Option<String>,
    pub next_cursor: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StoryboardSummaryResponse {
    pub id: StoryboardId,
    pub project_id: crate::product::domain::ProjectId,
    pub name: String,
    pub position: String,
    pub index: usize,
    pub revision: i64,
    pub pending_proposal_count: u64,
    pub thumbnail: Option<MediaThumbnailResponse>,
    pub updated_at: DateTime<Utc>,
}

impl StoryboardSummaryResponse {
    pub fn from_entry(entry: StoryboardCatalogEntry, index: usize) -> Self {
        let storyboard = entry.storyboard;
        Self {
            id: storyboard.id,
            project_id: storyboard.project_id,
            name: storyboard.name,
            position: storyboard.position,
            index,
            revision: storyboard.revision,
            pending_proposal_count: entry.pending_proposal_count,
            thumbnail: None,
            updated_at: storyboard.updated_at,
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaThumbnailResponse {
    pub url: String,
    pub expires_at: Option<DateTime<Utc>>,
    pub width: u32,
    pub height: u32,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StoryboardDetailResponse {
    #[serde(flatten)]
    pub summary: StoryboardSummaryResponse,
    pub script: StoryboardScriptResponse,
    pub counts: StoryboardCountsResponse,
    pub created_at: DateTime<Utc>,
}

impl StoryboardDetailResponse {
    pub fn from_snapshot(snapshot: StoryboardSnapshot, index: usize) -> Self {
        let created_at = snapshot.entry.storyboard.created_at;
        Self {
            summary: StoryboardSummaryResponse::from_entry(snapshot.entry, index),
            script: snapshot.script.into(),
            counts: StoryboardCountsResponse {
                asset_bindings: snapshot.counts.asset_bindings,
                keyframes: snapshot.counts.keyframes,
                videos: snapshot.counts.videos,
            },
            created_at,
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StoryboardScriptResponse {
    pub text: String,
    pub revision: i64,
    pub updated_at: DateTime<Utc>,
}

impl From<StoryboardScript> for StoryboardScriptResponse {
    fn from(script: StoryboardScript) -> Self {
        Self {
            text: script.text,
            revision: script.revision,
            updated_at: script.updated_at,
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StoryboardCountsResponse {
    pub asset_bindings: u64,
    pub keyframes: u64,
    pub videos: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateStoryboardResponse {
    pub storyboard: StoryboardDetailResponse,
    pub asset_copy: AssetCopySummaryResponse,
}

#[derive(Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AssetCopySummaryResponse {
    pub created: u64,
    pub skipped: u64,
    pub failed: Vec<CopyFailureResponse>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CopyFailureResponse {
    pub binding_id: crate::product::domain::AssetBindingId,
    pub reason: String,
}
