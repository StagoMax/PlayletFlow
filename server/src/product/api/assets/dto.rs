use crate::product::application::assets::{
    AssetBindingView, AssetPage, AssetSectionView, AssetView, CopyAssetBindingsResult,
};
use crate::product::domain::{
    AssetBindingId, AssetId, AssetKind, AssetRepresentation, AssetSectionId, AssetViewKind,
    MediaId, StoryboardId,
};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CreateSectionRequest {
    pub parent_id: Option<AssetSectionId>,
    pub name: String,
    pub kind: AssetKind,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct UpdateSectionRequest {
    pub parent_id: Option<AssetSectionId>,
    pub name: String,
    pub kind: AssetKind,
    pub expected_revision: i64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReorderRequest<T> {
    pub before_id: Option<T>,
    pub after_id: Option<T>,
    pub expected_revision: i64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DeleteSectionQuery {
    pub binding_action: BindingAction,
    pub target_section_id: Option<AssetSectionId>,
    pub expected_revision: i64,
}

#[derive(Clone, Copy, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum BindingAction {
    Move,
    Detach,
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AssetListQuery {
    #[serde(rename = "type")]
    pub kind: Option<AssetKind>,
    pub query: Option<String>,
    pub cursor: Option<AssetId>,
    pub limit: Option<usize>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CreateAssetRequest {
    #[serde(rename = "type")]
    pub kind: AssetKind,
    pub name: String,
    pub description: Option<String>,
    pub canonical_prompt: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct UpdateAssetRequest {
    #[serde(rename = "type")]
    pub kind: AssetKind,
    pub name: String,
    pub description: Option<String>,
    pub canonical_prompt: Option<String>,
    pub expected_revision: i64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CreateRepresentationRequest {
    pub label: String,
    pub view_kind: AssetViewKind,
    pub media_id: Option<MediaId>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CreateBindingsRequest {
    pub section_id: AssetSectionId,
    pub asset_ids: Vec<AssetId>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct UpdateBindingRequest {
    pub section_id: AssetSectionId,
    pub prompt_override: Option<String>,
    pub before_id: Option<AssetBindingId>,
    pub after_id: Option<AssetBindingId>,
    pub expected_revision: i64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CopyBindingsRequest {
    pub target_storyboard_id: StoryboardId,
    pub binding_ids: Vec<AssetBindingId>,
    pub include_section_structure: bool,
    pub target_section_id: Option<AssetSectionId>,
    pub include_prompt_overrides: bool,
    pub on_duplicate: DuplicateBindingStrategy,
}

#[derive(Clone, Copy, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum DuplicateBindingStrategy {
    Skip,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ExpectedRevisionQuery {
    pub expected_revision: i64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AssetSectionResponse {
    id: AssetSectionId,
    storyboard_id: StoryboardId,
    parent_id: Option<AssetSectionId>,
    name: String,
    kind: AssetKind,
    position: String,
    revision: i64,
    binding_count: u64,
}

impl From<AssetSectionView> for AssetSectionResponse {
    fn from(view: AssetSectionView) -> Self {
        Self {
            id: view.section.id,
            storyboard_id: view.section.storyboard_id,
            parent_id: view.section.parent_id,
            name: view.section.name,
            kind: view.section.kind,
            position: view.section.position,
            revision: view.section.revision,
            binding_count: view.binding_count,
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AssetResponse {
    id: AssetId,
    project_id: crate::product::domain::ProjectId,
    #[serde(rename = "type")]
    kind: AssetKind,
    name: String,
    description: Option<String>,
    canonical_prompt: Option<String>,
    revision: i64,
    reference_count: u64,
    representations: Vec<AssetRepresentation>,
    created_at: DateTime<Utc>,
    updated_at: DateTime<Utc>,
}

impl From<AssetView> for AssetResponse {
    fn from(view: AssetView) -> Self {
        Self {
            id: view.asset.id,
            project_id: view.asset.project_id,
            kind: view.asset.kind,
            name: view.asset.name,
            description: view.asset.description,
            canonical_prompt: view.asset.canonical_prompt,
            revision: view.asset.revision,
            reference_count: view.reference_count,
            representations: view.asset.representations,
            created_at: view.asset.created_at,
            updated_at: view.asset.updated_at,
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AssetListResponse {
    items: Vec<AssetResponse>,
    page: Page,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Page {
    next_cursor: Option<String>,
    total: u64,
}

impl From<AssetPage> for AssetListResponse {
    fn from(page: AssetPage) -> Self {
        Self {
            items: page.items.into_iter().map(Into::into).collect(),
            page: Page {
                next_cursor: page.next_cursor,
                total: page.total,
            },
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AssetBindingResponse {
    id: AssetBindingId,
    storyboard_id: StoryboardId,
    section_id: AssetSectionId,
    asset_id: AssetId,
    position: String,
    prompt_override: Option<String>,
    derived_media_id: Option<MediaId>,
    revision: i64,
    asset: AssetResponse,
}

impl From<AssetBindingView> for AssetBindingResponse {
    fn from(view: AssetBindingView) -> Self {
        Self {
            id: view.binding.id,
            storyboard_id: view.binding.storyboard_id,
            section_id: view.binding.section_id,
            asset_id: view.binding.asset_id,
            position: view.binding.position,
            prompt_override: view.binding.prompt_override,
            derived_media_id: view.binding.derived_media_id,
            revision: view.binding.revision,
            asset: view.asset.into(),
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CopyBindingsResponse {
    created_binding_ids: Vec<AssetBindingId>,
    skipped: Vec<crate::product::application::assets::CopySkipped>,
    section_map: BTreeMap<String, AssetSectionId>,
}

impl From<CopyAssetBindingsResult> for CopyBindingsResponse {
    fn from(result: CopyAssetBindingsResult) -> Self {
        Self {
            created_binding_ids: result.created_binding_ids,
            skipped: result.skipped,
            section_map: result
                .section_map
                .into_iter()
                .map(|(source, target)| (source.to_string(), target))
                .collect(),
        }
    }
}
