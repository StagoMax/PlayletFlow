use super::idempotency::validate_idempotency_key;
pub use super::idempotency::IdempotencyContext;
use crate::product::domain::{
    validate_name, AssetBindingId, ProductError, ProductResult, Project, ProjectId, Storyboard,
    StoryboardCatalogEntry, StoryboardId, StoryboardScript, StoryboardSnapshot,
    MAX_PROJECT_NAME_CHARS, MAX_STORYBOARD_NAME_CHARS,
};
use async_trait::async_trait;
use chrono::Utc;
use serde::{Deserialize, Serialize};
use std::sync::Arc;

#[derive(Clone, Debug)]
pub struct ReorderStoryboard {
    pub project_id: ProjectId,
    pub storyboard_id: StoryboardId,
    pub before_id: Option<StoryboardId>,
    pub after_id: Option<StoryboardId>,
    pub expected_revision: i64,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct ReuseStoryboardAssets {
    pub source_storyboard_id: StoryboardId,
    pub binding_ids: Vec<AssetBindingId>,
    pub include_prompt_overrides: bool,
}

#[derive(Clone, Debug, Default, Deserialize, PartialEq, Serialize)]
pub struct StoryboardAssetCopySummary {
    pub created: u64,
    pub skipped: u64,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
pub struct CreatedStoryboardRecord {
    pub storyboard: Storyboard,
    pub asset_copy: StoryboardAssetCopySummary,
}

#[derive(Clone, Debug, PartialEq)]
pub struct CreatedStoryboard {
    pub snapshot: StoryboardSnapshot,
    pub asset_copy: StoryboardAssetCopySummary,
}

#[async_trait]
pub trait StoryboardCatalogRepository: Send + Sync {
    async fn list_projects(&self) -> ProductResult<Vec<Project>>;
    async fn find_project(&self, id: ProjectId) -> ProductResult<Option<Project>>;
    async fn create_project(
        &self,
        project: Project,
        first_storyboard: Storyboard,
        script: StoryboardScript,
        idempotency: IdempotencyContext,
    ) -> ProductResult<Project>;
    async fn rename_project(
        &self,
        id: ProjectId,
        name: String,
        expected_revision: i64,
    ) -> ProductResult<Project>;
    async fn list_storyboards(
        &self,
        project_id: ProjectId,
    ) -> ProductResult<Vec<StoryboardCatalogEntry>>;
    async fn find_storyboard(
        &self,
        project_id: ProjectId,
        storyboard_id: StoryboardId,
        include_deleted: bool,
    ) -> ProductResult<Option<StoryboardSnapshot>>;
    async fn create_storyboard(
        &self,
        storyboard: Storyboard,
        script: StoryboardScript,
        insert_after_id: Option<StoryboardId>,
        idempotency: IdempotencyContext,
    ) -> ProductResult<Storyboard>;
    async fn create_storyboard_with_assets(
        &self,
        storyboard: Storyboard,
        script: StoryboardScript,
        insert_after_id: Option<StoryboardId>,
        reuse_assets: Option<ReuseStoryboardAssets>,
        idempotency: IdempotencyContext,
    ) -> ProductResult<CreatedStoryboardRecord> {
        if reuse_assets.is_some() {
            return Err(ProductError::DependencyUnavailable(
                "storyboard asset reuse is not supported by this repository".to_owned(),
            ));
        }
        let storyboard = self
            .create_storyboard(storyboard, script, insert_after_id, idempotency)
            .await?;
        Ok(CreatedStoryboardRecord {
            storyboard,
            asset_copy: StoryboardAssetCopySummary::default(),
        })
    }
    async fn rename_storyboard(
        &self,
        project_id: ProjectId,
        storyboard_id: StoryboardId,
        name: String,
        expected_revision: i64,
    ) -> ProductResult<Storyboard>;
    async fn reorder_storyboard(
        &self,
        command: ReorderStoryboard,
        idempotency: IdempotencyContext,
    ) -> ProductResult<Storyboard>;
    async fn duplicate_storyboard(
        &self,
        source_id: StoryboardId,
        storyboard: Storyboard,
        idempotency: IdempotencyContext,
    ) -> ProductResult<Storyboard>;
    async fn delete_storyboard(
        &self,
        project_id: ProjectId,
        storyboard_id: StoryboardId,
        expected_revision: i64,
    ) -> ProductResult<()>;
    async fn restore_storyboard(
        &self,
        project_id: ProjectId,
        storyboard_id: StoryboardId,
        idempotency: IdempotencyContext,
    ) -> ProductResult<Storyboard>;
    async fn find_script(
        &self,
        project_id: ProjectId,
        storyboard_id: StoryboardId,
    ) -> ProductResult<Option<StoryboardScript>>;
    async fn update_script(
        &self,
        project_id: ProjectId,
        storyboard_id: StoryboardId,
        text: String,
        expected_revision: i64,
    ) -> ProductResult<StoryboardScript>;
}

#[derive(Clone)]
pub struct StoryboardService {
    repository: Arc<dyn StoryboardCatalogRepository>,
}

impl StoryboardService {
    pub fn new(repository: Arc<dyn StoryboardCatalogRepository>) -> Self {
        Self { repository }
    }

    pub async fn list_projects(&self) -> ProductResult<Vec<Project>> {
        self.repository.list_projects().await
    }

    pub async fn get_project(&self, id: ProjectId) -> ProductResult<Project> {
        self.repository
            .find_project(id)
            .await?
            .ok_or(ProductError::NotFound)
    }

    pub async fn create_project(
        &self,
        name: String,
        idempotency_key: String,
    ) -> ProductResult<Project> {
        let idempotency_key = validate_idempotency_key(idempotency_key)?;
        let now = Utc::now();
        let project = Project::new(name.clone(), now)?;
        let storyboard = Storyboard::new(project.id, "片段 1", now)?;
        let script = StoryboardScript::empty(storyboard.id, now);
        let idempotency = IdempotencyContext::new("createProject", idempotency_key, &name, 201)?;
        self.repository
            .create_project(project, storyboard, script, idempotency)
            .await
    }

    pub async fn rename_project(
        &self,
        id: ProjectId,
        name: String,
        expected_revision: i64,
    ) -> ProductResult<Project> {
        validate_expected_revision(expected_revision)?;
        let name = validate_name(name, MAX_PROJECT_NAME_CHARS, "project")?;
        self.repository
            .rename_project(id, name, expected_revision)
            .await
    }

    pub async fn list_storyboard_window(
        &self,
        project_id: ProjectId,
        anchor_id: Option<StoryboardId>,
        cursor: Option<usize>,
        before: usize,
        after: usize,
    ) -> ProductResult<StoryboardWindow> {
        if before > 100 || after > 100 {
            return Err(ProductError::Validation(
                "before and after must be between 0 and 100".to_owned(),
            ));
        }
        if anchor_id.is_some() && cursor.is_some() {
            return Err(ProductError::Validation(
                "anchorId and cursor cannot be combined".to_owned(),
            ));
        }
        self.get_project(project_id).await?;
        let entries = self.repository.list_storyboards(project_id).await?;
        let total = entries.len();
        let page_size = before.saturating_add(after).saturating_add(1).max(1);
        let (start, end, anchor_index) = if let Some(anchor_id) = anchor_id {
            let index = entries
                .iter()
                .position(|entry| entry.storyboard.id == anchor_id)
                .ok_or(ProductError::NotFound)?;
            (
                index.saturating_sub(before),
                total.min(index.saturating_add(after).saturating_add(1)),
                Some(index),
            )
        } else {
            let start = cursor.unwrap_or_default();
            if start > total {
                return Err(ProductError::Validation(
                    "cursor is out of range".to_owned(),
                ));
            }
            (start, total.min(start.saturating_add(page_size)), None)
        };
        Ok(StoryboardWindow {
            items: entries[start..end].to_vec(),
            start_index: start,
            anchor_id,
            anchor_index,
            total,
            has_before: start > 0,
            has_after: end < total,
            previous_cursor: (start > 0).then(|| start.saturating_sub(page_size).to_string()),
            next_cursor: (end < total).then(|| end.to_string()),
        })
    }

    pub async fn get_storyboard(
        &self,
        project_id: ProjectId,
        storyboard_id: StoryboardId,
    ) -> ProductResult<StoryboardSnapshot> {
        self.repository
            .find_storyboard(project_id, storyboard_id, false)
            .await?
            .ok_or(ProductError::NotFound)
    }

    pub async fn create_storyboard(
        &self,
        project_id: ProjectId,
        name: String,
        insert_after_id: Option<StoryboardId>,
        idempotency_key: String,
    ) -> ProductResult<StoryboardSnapshot> {
        let idempotency_key = validate_idempotency_key(idempotency_key)?;
        self.get_project(project_id).await?;
        let now = Utc::now();
        let storyboard = Storyboard::new(project_id, name.clone(), now)?;
        let script = StoryboardScript::empty(storyboard.id, now);
        let fingerprint = (project_id, &name, insert_after_id);
        let idempotency =
            IdempotencyContext::new("createStoryboard", idempotency_key, &fingerprint, 201)?;
        let storyboard = self
            .repository
            .create_storyboard(storyboard, script, insert_after_id, idempotency)
            .await?;
        self.get_storyboard(project_id, storyboard.id).await
    }

    pub async fn create_storyboard_with_assets(
        &self,
        project_id: ProjectId,
        name: String,
        insert_after_id: Option<StoryboardId>,
        reuse_assets: Option<ReuseStoryboardAssets>,
        idempotency_key: String,
    ) -> ProductResult<CreatedStoryboard> {
        let idempotency_key = validate_idempotency_key(idempotency_key)?;
        self.get_project(project_id).await?;
        if let Some(reuse) = &reuse_assets {
            if reuse.binding_ids.is_empty() {
                return Err(ProductError::Validation(
                    "bindingIds must contain at least one binding".to_owned(),
                ));
            }
            let mut unique = reuse.binding_ids.clone();
            unique.sort_by_key(|id| id.0);
            unique.dedup();
            if unique.len() != reuse.binding_ids.len() {
                return Err(ProductError::Validation(
                    "bindingIds must not contain duplicates".to_owned(),
                ));
            }
        }
        let now = Utc::now();
        let storyboard = Storyboard::new(project_id, name.clone(), now)?;
        let script = StoryboardScript::empty(storyboard.id, now);
        let fingerprint = (project_id, &name, insert_after_id, &reuse_assets);
        let idempotency =
            IdempotencyContext::new("createStoryboard", idempotency_key, &fingerprint, 201)?;
        let created = self
            .repository
            .create_storyboard_with_assets(
                storyboard,
                script,
                insert_after_id,
                reuse_assets,
                idempotency,
            )
            .await?;
        Ok(CreatedStoryboard {
            snapshot: self
                .get_storyboard(project_id, created.storyboard.id)
                .await?,
            asset_copy: created.asset_copy,
        })
    }

    pub async fn rename_storyboard(
        &self,
        project_id: ProjectId,
        storyboard_id: StoryboardId,
        name: String,
        expected_revision: i64,
    ) -> ProductResult<StoryboardSnapshot> {
        validate_expected_revision(expected_revision)?;
        let name = validate_name(name, MAX_STORYBOARD_NAME_CHARS, "storyboard")?;
        self.repository
            .rename_storyboard(project_id, storyboard_id, name, expected_revision)
            .await?;
        self.get_storyboard(project_id, storyboard_id).await
    }

    pub async fn reorder_storyboard(
        &self,
        command: ReorderStoryboard,
        idempotency_key: String,
    ) -> ProductResult<StoryboardSnapshot> {
        let idempotency_key = validate_idempotency_key(idempotency_key)?;
        validate_expected_revision(command.expected_revision)?;
        if command.before_id.is_none() && command.after_id.is_none() {
            return Err(ProductError::Validation(
                "beforeId or afterId is required".to_owned(),
            ));
        }
        let fingerprint = (
            command.project_id,
            command.storyboard_id,
            command.before_id,
            command.after_id,
            command.expected_revision,
        );
        let idempotency =
            IdempotencyContext::new("reorderStoryboard", idempotency_key, &fingerprint, 200)?;
        let project_id = command.project_id;
        let storyboard_id = command.storyboard_id;
        self.repository
            .reorder_storyboard(command, idempotency)
            .await?;
        self.get_storyboard(project_id, storyboard_id).await
    }

    pub async fn duplicate_storyboard(
        &self,
        project_id: ProjectId,
        source_id: StoryboardId,
        idempotency_key: String,
    ) -> ProductResult<StoryboardSnapshot> {
        let key = validate_idempotency_key(idempotency_key)?;
        let source = self.get_storyboard(project_id, source_id).await?;
        let suffix = "（副本）";
        let available = MAX_STORYBOARD_NAME_CHARS - suffix.chars().count();
        let name = format!(
            "{}{}",
            source
                .entry
                .storyboard
                .name
                .chars()
                .take(available)
                .collect::<String>(),
            suffix
        );
        let storyboard = Storyboard::new(project_id, name, Utc::now())?;
        let idempotency =
            IdempotencyContext::new("duplicateStoryboard", key, &(project_id, source_id), 201)?;
        let created = self
            .repository
            .duplicate_storyboard(source_id, storyboard, idempotency)
            .await?;
        self.get_storyboard(project_id, created.id).await
    }

    pub async fn delete_storyboard(
        &self,
        project_id: ProjectId,
        storyboard_id: StoryboardId,
        expected_revision: i64,
    ) -> ProductResult<()> {
        validate_expected_revision(expected_revision)?;
        self.repository
            .delete_storyboard(project_id, storyboard_id, expected_revision)
            .await
    }

    pub async fn restore_storyboard(
        &self,
        project_id: ProjectId,
        storyboard_id: StoryboardId,
        idempotency_key: String,
    ) -> ProductResult<StoryboardSnapshot> {
        let idempotency_key = validate_idempotency_key(idempotency_key)?;
        let idempotency = IdempotencyContext::new(
            "restoreStoryboard",
            idempotency_key,
            &(project_id, storyboard_id),
            200,
        )?;
        self.repository
            .restore_storyboard(project_id, storyboard_id, idempotency)
            .await?;
        self.get_storyboard(project_id, storyboard_id).await
    }

    pub async fn get_script(
        &self,
        project_id: ProjectId,
        storyboard_id: StoryboardId,
    ) -> ProductResult<StoryboardScript> {
        self.repository
            .find_script(project_id, storyboard_id)
            .await?
            .ok_or(ProductError::NotFound)
    }

    pub async fn update_script(
        &self,
        project_id: ProjectId,
        storyboard_id: StoryboardId,
        text: String,
        expected_revision: i64,
    ) -> ProductResult<StoryboardScript> {
        validate_expected_revision(expected_revision)?;
        let text = StoryboardScript::validate_text(text)?;
        self.repository
            .update_script(project_id, storyboard_id, text, expected_revision)
            .await
    }
}

fn validate_expected_revision(revision: i64) -> ProductResult<()> {
    if revision < 1 {
        return Err(ProductError::Validation(
            "expectedRevision must be at least 1".to_owned(),
        ));
    }
    Ok(())
}

#[derive(Clone, Debug, PartialEq)]
pub struct StoryboardWindow {
    pub items: Vec<StoryboardCatalogEntry>,
    pub start_index: usize,
    pub anchor_id: Option<StoryboardId>,
    pub anchor_index: Option<usize>,
    pub total: usize,
    pub has_before: bool,
    pub has_after: bool,
    pub previous_cursor: Option<String>,
    pub next_cursor: Option<String>,
}
