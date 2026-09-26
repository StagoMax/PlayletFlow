use super::storyboards::IdempotencyContext;
use crate::product::domain::{
    validate_name, validate_optional_text, validate_revision, Asset, AssetBinding, AssetBindingId,
    AssetId, AssetKind, AssetRepresentation, AssetSection, AssetSectionId, AssetViewKind, MediaId,
    ProductError, ProductResult, ProjectId, StoryboardId, MAX_ASSET_DESCRIPTION_CHARS,
    MAX_ASSET_NAME_CHARS, MAX_PROMPT_CHARS, MAX_SECTION_NAME_CHARS,
};
use async_trait::async_trait;
use chrono::Utc;
use serde::{Deserialize, Serialize};
use std::sync::Arc;

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AssetSectionView {
    pub section: AssetSection,
    pub binding_count: u64,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AssetView {
    pub asset: Asset,
    pub reference_count: u64,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AssetBindingView {
    pub binding: AssetBinding,
    pub asset: AssetView,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AssetPage {
    pub items: Vec<AssetView>,
    pub next_cursor: Option<String>,
    pub total: u64,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CopySkipped {
    pub binding_id: AssetBindingId,
    pub reason: String,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CopyAssetBindingsResult {
    pub created_binding_ids: Vec<AssetBindingId>,
    pub skipped: Vec<CopySkipped>,
    pub section_map: Vec<(AssetSectionId, AssetSectionId)>,
}

#[derive(Clone, Debug)]
pub struct CreateSection {
    pub section: AssetSection,
    pub idempotency: IdempotencyContext,
}

#[derive(Clone, Debug)]
pub struct UpdateSection {
    pub project_id: ProjectId,
    pub storyboard_id: StoryboardId,
    pub section_id: AssetSectionId,
    pub parent_id: Option<AssetSectionId>,
    pub name: String,
    pub kind: AssetKind,
    pub expected_revision: i64,
}

#[derive(Clone, Debug)]
pub enum DeleteSectionBindings {
    Move { target_section_id: AssetSectionId },
    Detach,
}

#[derive(Clone, Debug)]
pub struct DeleteSection {
    pub project_id: ProjectId,
    pub storyboard_id: StoryboardId,
    pub section_id: AssetSectionId,
    pub bindings: DeleteSectionBindings,
    pub expected_revision: i64,
}

#[derive(Clone, Debug)]
pub struct ReorderSection {
    pub project_id: ProjectId,
    pub storyboard_id: StoryboardId,
    pub section_id: AssetSectionId,
    pub before_id: Option<AssetSectionId>,
    pub after_id: Option<AssetSectionId>,
    pub expected_revision: i64,
    pub idempotency: IdempotencyContext,
}

#[derive(Clone, Debug)]
pub struct ReorderSectionInput {
    pub project_id: ProjectId,
    pub storyboard_id: StoryboardId,
    pub section_id: AssetSectionId,
    pub before_id: Option<AssetSectionId>,
    pub after_id: Option<AssetSectionId>,
    pub expected_revision: i64,
}

#[derive(Clone, Debug)]
pub struct AssetQuery {
    pub project_id: ProjectId,
    pub kind: Option<AssetKind>,
    pub query: Option<String>,
    pub cursor: Option<AssetId>,
    pub limit: usize,
}

#[derive(Clone, Debug)]
pub struct CreateAsset {
    pub asset: Asset,
    pub idempotency: IdempotencyContext,
}

#[derive(Clone, Debug)]
pub struct UpdateAsset {
    pub project_id: ProjectId,
    pub asset_id: AssetId,
    pub kind: AssetKind,
    pub name: String,
    pub description: Option<String>,
    pub canonical_prompt: Option<String>,
    pub expected_revision: i64,
}

#[derive(Clone, Debug)]
pub struct CreateRepresentation {
    pub project_id: ProjectId,
    pub representation: AssetRepresentation,
    pub idempotency: IdempotencyContext,
}

#[derive(Clone, Debug)]
pub struct CreateBindings {
    pub project_id: ProjectId,
    pub storyboard_id: StoryboardId,
    pub section_id: AssetSectionId,
    pub bindings: Vec<AssetBinding>,
    pub idempotency: IdempotencyContext,
}

#[derive(Clone, Debug)]
pub struct UpdateBinding {
    pub project_id: ProjectId,
    pub storyboard_id: StoryboardId,
    pub binding_id: AssetBindingId,
    pub section_id: AssetSectionId,
    pub prompt_override: Option<String>,
    pub before_id: Option<AssetBindingId>,
    pub after_id: Option<AssetBindingId>,
    pub expected_revision: i64,
}

#[derive(Clone, Debug)]
pub struct DeleteBinding {
    pub project_id: ProjectId,
    pub storyboard_id: StoryboardId,
    pub binding_id: AssetBindingId,
    pub expected_revision: i64,
}

#[derive(Clone, Debug)]
pub struct CopyAssetBindings {
    pub project_id: ProjectId,
    pub source_storyboard_id: StoryboardId,
    pub target_storyboard_id: StoryboardId,
    pub binding_ids: Vec<AssetBindingId>,
    pub include_section_structure: bool,
    pub target_section_id: Option<AssetSectionId>,
    pub include_prompt_overrides: bool,
    pub idempotency: IdempotencyContext,
}

#[derive(Clone, Debug)]
pub struct CopyAssetBindingsInput {
    pub project_id: ProjectId,
    pub source_storyboard_id: StoryboardId,
    pub target_storyboard_id: StoryboardId,
    pub binding_ids: Vec<AssetBindingId>,
    pub include_section_structure: bool,
    pub target_section_id: Option<AssetSectionId>,
    pub include_prompt_overrides: bool,
}

#[async_trait]
pub trait AssetWorkspaceRepository: Send + Sync {
    async fn list_sections(
        &self,
        project_id: ProjectId,
        storyboard_id: StoryboardId,
    ) -> ProductResult<Vec<AssetSectionView>>;
    async fn create_section(&self, command: CreateSection) -> ProductResult<AssetSectionView>;
    async fn update_section(&self, command: UpdateSection) -> ProductResult<AssetSectionView>;
    async fn delete_section(&self, command: DeleteSection) -> ProductResult<()>;
    async fn reorder_section(&self, command: ReorderSection) -> ProductResult<AssetSectionView>;

    async fn list_assets(&self, query: AssetQuery) -> ProductResult<AssetPage>;
    async fn find_asset(
        &self,
        project_id: ProjectId,
        asset_id: AssetId,
    ) -> ProductResult<Option<AssetView>>;
    async fn create_asset(&self, command: CreateAsset) -> ProductResult<AssetView>;
    async fn update_asset(&self, command: UpdateAsset) -> ProductResult<AssetView>;
    async fn delete_asset(
        &self,
        project_id: ProjectId,
        asset_id: AssetId,
        expected_revision: i64,
    ) -> ProductResult<()>;
    async fn create_representation(
        &self,
        command: CreateRepresentation,
    ) -> ProductResult<AssetView>;

    async fn list_bindings(
        &self,
        project_id: ProjectId,
        storyboard_id: StoryboardId,
    ) -> ProductResult<Vec<AssetBindingView>>;
    async fn create_bindings(
        &self,
        command: CreateBindings,
    ) -> ProductResult<Vec<AssetBindingView>>;
    async fn update_binding(&self, command: UpdateBinding) -> ProductResult<AssetBindingView>;
    async fn delete_binding(&self, command: DeleteBinding) -> ProductResult<()>;
    async fn copy_bindings(
        &self,
        command: CopyAssetBindings,
    ) -> ProductResult<CopyAssetBindingsResult>;
}

#[derive(Clone)]
pub struct AssetService {
    repository: Arc<dyn AssetWorkspaceRepository>,
}

impl AssetService {
    pub fn new(repository: Arc<dyn AssetWorkspaceRepository>) -> Self {
        Self { repository }
    }

    pub async fn list_sections(
        &self,
        project_id: ProjectId,
        storyboard_id: StoryboardId,
    ) -> ProductResult<Vec<AssetSectionView>> {
        self.repository
            .list_sections(project_id, storyboard_id)
            .await
    }

    pub async fn create_section(
        &self,
        project_id: ProjectId,
        storyboard_id: StoryboardId,
        parent_id: Option<AssetSectionId>,
        name: String,
        kind: AssetKind,
        idempotency_key: String,
    ) -> ProductResult<AssetSectionView> {
        let fingerprint = (project_id, storyboard_id, parent_id, &name, kind);
        let idempotency =
            IdempotencyContext::new("createAssetSection", idempotency_key, &fingerprint, 201)?;
        let section = AssetSection::new(project_id, storyboard_id, parent_id, name, kind)?;
        self.repository
            .create_section(CreateSection {
                section,
                idempotency,
            })
            .await
    }

    pub async fn update_section(&self, command: UpdateSection) -> ProductResult<AssetSectionView> {
        let mut command = command;
        command.name = validate_name(command.name, MAX_SECTION_NAME_CHARS, "asset section")?;
        validate_revision(command.expected_revision)?;
        self.repository.update_section(command).await
    }

    pub async fn delete_section(&self, command: DeleteSection) -> ProductResult<()> {
        validate_revision(command.expected_revision)?;
        self.repository.delete_section(command).await
    }

    pub async fn reorder_section(
        &self,
        input: ReorderSectionInput,
        idempotency_key: String,
    ) -> ProductResult<AssetSectionView> {
        validate_revision(input.expected_revision)?;
        validate_neighbors(input.before_id, input.after_id)?;
        let idempotency = IdempotencyContext::new(
            "reorderAssetSection",
            idempotency_key,
            &(
                input.project_id,
                input.storyboard_id,
                input.section_id,
                input.before_id,
                input.after_id,
                input.expected_revision,
            ),
            200,
        )?;
        self.repository
            .reorder_section(ReorderSection {
                project_id: input.project_id,
                storyboard_id: input.storyboard_id,
                section_id: input.section_id,
                before_id: input.before_id,
                after_id: input.after_id,
                expected_revision: input.expected_revision,
                idempotency,
            })
            .await
    }

    pub async fn list_assets(&self, mut query: AssetQuery) -> ProductResult<AssetPage> {
        if query.limit == 0 || query.limit > 100 {
            return Err(ProductError::Validation(
                "limit must be between 1 and 100".to_owned(),
            ));
        }
        query.query = query
            .query
            .map(|value| value.trim().to_owned())
            .filter(|value| !value.is_empty());
        self.repository.list_assets(query).await
    }

    pub async fn get_asset(
        &self,
        project_id: ProjectId,
        asset_id: AssetId,
    ) -> ProductResult<AssetView> {
        self.repository
            .find_asset(project_id, asset_id)
            .await?
            .ok_or(ProductError::NotFound)
    }

    pub async fn create_asset(
        &self,
        project_id: ProjectId,
        kind: AssetKind,
        name: String,
        description: Option<String>,
        canonical_prompt: Option<String>,
        idempotency_key: String,
    ) -> ProductResult<AssetView> {
        let fingerprint = (project_id, kind, &name, &description, &canonical_prompt);
        let idempotency =
            IdempotencyContext::new("createAsset", idempotency_key, &fingerprint, 201)?;
        let asset = Asset::new(
            project_id,
            kind,
            name,
            description,
            canonical_prompt,
            Utc::now(),
        )?;
        self.repository
            .create_asset(CreateAsset { asset, idempotency })
            .await
    }

    pub async fn update_asset(&self, mut command: UpdateAsset) -> ProductResult<AssetView> {
        command.name = validate_name(command.name, MAX_ASSET_NAME_CHARS, "asset")?;
        command.description = validate_optional_text(
            command.description,
            MAX_ASSET_DESCRIPTION_CHARS,
            "asset description",
        )?;
        command.canonical_prompt =
            validate_optional_text(command.canonical_prompt, MAX_PROMPT_CHARS, "asset prompt")?;
        validate_revision(command.expected_revision)?;
        self.repository.update_asset(command).await
    }

    pub async fn delete_asset(
        &self,
        project_id: ProjectId,
        asset_id: AssetId,
        expected_revision: i64,
    ) -> ProductResult<()> {
        validate_revision(expected_revision)?;
        self.repository
            .delete_asset(project_id, asset_id, expected_revision)
            .await
    }

    pub async fn create_representation(
        &self,
        project_id: ProjectId,
        asset_id: AssetId,
        label: String,
        view_kind: AssetViewKind,
        media_id: Option<MediaId>,
        idempotency_key: String,
    ) -> ProductResult<AssetView> {
        let fingerprint = (project_id, asset_id, &label, view_kind, media_id);
        let idempotency = IdempotencyContext::new(
            "createAssetRepresentation",
            idempotency_key,
            &fingerprint,
            201,
        )?;
        let representation = AssetRepresentation::new(asset_id, label, view_kind, media_id)?;
        self.repository
            .create_representation(CreateRepresentation {
                project_id,
                representation,
                idempotency,
            })
            .await
    }

    pub async fn list_bindings(
        &self,
        project_id: ProjectId,
        storyboard_id: StoryboardId,
    ) -> ProductResult<Vec<AssetBindingView>> {
        self.repository
            .list_bindings(project_id, storyboard_id)
            .await
    }

    pub async fn create_bindings(
        &self,
        project_id: ProjectId,
        storyboard_id: StoryboardId,
        section_id: AssetSectionId,
        asset_ids: Vec<AssetId>,
        idempotency_key: String,
    ) -> ProductResult<Vec<AssetBindingView>> {
        if asset_ids.is_empty() {
            return Err(ProductError::Validation(
                "assetIds must contain at least one asset".to_owned(),
            ));
        }
        let mut unique = asset_ids.clone();
        unique.sort_by_key(|id| id.0);
        unique.dedup();
        if unique.len() != asset_ids.len() {
            return Err(ProductError::Validation(
                "assetIds must not contain duplicates".to_owned(),
            ));
        }
        let fingerprint = (project_id, storyboard_id, section_id, &asset_ids);
        let idempotency =
            IdempotencyContext::new("createAssetBindings", idempotency_key, &fingerprint, 201)?;
        let now = Utc::now();
        let bindings = asset_ids
            .into_iter()
            .map(|asset_id| AssetBinding::new(project_id, storyboard_id, section_id, asset_id, now))
            .collect::<Vec<_>>();
        self.repository
            .create_bindings(CreateBindings {
                project_id,
                storyboard_id,
                section_id,
                bindings,
                idempotency,
            })
            .await
    }

    pub async fn update_binding(
        &self,
        mut command: UpdateBinding,
    ) -> ProductResult<AssetBindingView> {
        command.prompt_override =
            validate_optional_text(command.prompt_override, MAX_PROMPT_CHARS, "prompt override")?;
        validate_revision(command.expected_revision)?;
        if command.before_id.is_some() || command.after_id.is_some() {
            validate_neighbors(command.before_id, command.after_id)?;
        }
        self.repository.update_binding(command).await
    }

    pub async fn delete_binding(&self, command: DeleteBinding) -> ProductResult<()> {
        validate_revision(command.expected_revision)?;
        self.repository.delete_binding(command).await
    }

    pub async fn copy_bindings(
        &self,
        input: CopyAssetBindingsInput,
        idempotency_key: String,
    ) -> ProductResult<CopyAssetBindingsResult> {
        if input.binding_ids.is_empty() {
            return Err(ProductError::Validation(
                "bindingIds must contain at least one binding".to_owned(),
            ));
        }
        if input.include_section_structure == input.target_section_id.is_some() {
            return Err(ProductError::Validation(
                "targetSectionId is required exactly when includeSectionStructure is false"
                    .to_owned(),
            ));
        }
        let fingerprint = (
            input.project_id,
            input.source_storyboard_id,
            input.target_storyboard_id,
            &input.binding_ids,
            input.include_section_structure,
            input.target_section_id,
            input.include_prompt_overrides,
        );
        let idempotency =
            IdempotencyContext::new("copyAssetBindings", idempotency_key, &fingerprint, 200)?;
        self.repository
            .copy_bindings(CopyAssetBindings {
                project_id: input.project_id,
                source_storyboard_id: input.source_storyboard_id,
                target_storyboard_id: input.target_storyboard_id,
                binding_ids: input.binding_ids,
                include_section_structure: input.include_section_structure,
                target_section_id: input.target_section_id,
                include_prompt_overrides: input.include_prompt_overrides,
                idempotency,
            })
            .await
    }
}

fn validate_neighbors<T>(before_id: Option<T>, after_id: Option<T>) -> ProductResult<()> {
    if before_id.is_none() && after_id.is_none() {
        return Err(ProductError::Validation(
            "beforeId or afterId is required".to_owned(),
        ));
    }
    Ok(())
}
