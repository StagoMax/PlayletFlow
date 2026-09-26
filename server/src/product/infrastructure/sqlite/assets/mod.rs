mod bindings;
mod catalog;
mod mapping;
mod sections;

pub(super) use bindings::copy_in_transaction;

use super::ProductDatabase;
use crate::product::application::assets::{AssetBindingView, AssetSectionView, AssetView};
use crate::product::application::assets::{
    AssetPage, AssetQuery, AssetWorkspaceRepository, CopyAssetBindings, CopyAssetBindingsResult,
    CreateAsset, CreateBindings, CreateRepresentation, CreateSection, DeleteBinding, DeleteSection,
    ReorderSection, UpdateAsset, UpdateBinding, UpdateSection,
};
use crate::product::domain::{AssetId, ProductError, ProductResult, ProjectId, StoryboardId};
use async_trait::async_trait;
use rusqlite::Connection;

#[derive(Clone, Debug)]
pub struct SqliteAssetRepository {
    database: ProductDatabase,
}

impl SqliteAssetRepository {
    pub fn new(database: ProductDatabase) -> Self {
        Self { database }
    }

    async fn run<T, F>(&self, operation: F) -> ProductResult<T>
    where
        T: Send + 'static,
        F: FnOnce(&mut Connection) -> ProductResult<T> + Send + 'static,
    {
        let database = self.database.clone();
        tokio::task::spawn_blocking(move || {
            let mut connection = database.connect()?;
            operation(&mut connection)
        })
        .await
        .map_err(|error| ProductError::Storage(error.to_string()))?
    }
}

#[async_trait]
impl AssetWorkspaceRepository for SqliteAssetRepository {
    async fn list_sections(
        &self,
        project_id: ProjectId,
        storyboard_id: StoryboardId,
    ) -> ProductResult<Vec<AssetSectionView>> {
        self.run(move |connection| sections::list(connection, project_id, storyboard_id))
            .await
    }

    async fn create_section(&self, command: CreateSection) -> ProductResult<AssetSectionView> {
        self.run(move |connection| sections::create(connection, command))
            .await
    }

    async fn update_section(&self, command: UpdateSection) -> ProductResult<AssetSectionView> {
        self.run(move |connection| sections::update(connection, command))
            .await
    }

    async fn delete_section(&self, command: DeleteSection) -> ProductResult<()> {
        self.run(move |connection| sections::delete(connection, command))
            .await
    }

    async fn reorder_section(&self, command: ReorderSection) -> ProductResult<AssetSectionView> {
        self.run(move |connection| sections::reorder(connection, command))
            .await
    }

    async fn list_assets(&self, query: AssetQuery) -> ProductResult<AssetPage> {
        self.run(move |connection| catalog::list(connection, query))
            .await
    }

    async fn find_asset(
        &self,
        project_id: ProjectId,
        asset_id: AssetId,
    ) -> ProductResult<Option<AssetView>> {
        self.run(move |connection| mapping::load_asset_view(connection, project_id, asset_id))
            .await
    }

    async fn create_asset(&self, command: CreateAsset) -> ProductResult<AssetView> {
        self.run(move |connection| catalog::create(connection, command))
            .await
    }

    async fn update_asset(&self, command: UpdateAsset) -> ProductResult<AssetView> {
        self.run(move |connection| catalog::update(connection, command))
            .await
    }

    async fn delete_asset(
        &self,
        project_id: ProjectId,
        asset_id: AssetId,
        expected_revision: i64,
    ) -> ProductResult<()> {
        self.run(move |connection| {
            catalog::delete(connection, project_id, asset_id, expected_revision)
        })
        .await
    }

    async fn create_representation(
        &self,
        command: CreateRepresentation,
    ) -> ProductResult<AssetView> {
        self.run(move |connection| catalog::create_representation(connection, command))
            .await
    }

    async fn list_bindings(
        &self,
        project_id: ProjectId,
        storyboard_id: StoryboardId,
    ) -> ProductResult<Vec<AssetBindingView>> {
        self.run(move |connection| bindings::list(connection, project_id, storyboard_id))
            .await
    }

    async fn create_bindings(
        &self,
        command: CreateBindings,
    ) -> ProductResult<Vec<AssetBindingView>> {
        self.run(move |connection| bindings::create(connection, command))
            .await
    }

    async fn update_binding(&self, command: UpdateBinding) -> ProductResult<AssetBindingView> {
        self.run(move |connection| bindings::update(connection, command))
            .await
    }

    async fn delete_binding(&self, command: DeleteBinding) -> ProductResult<()> {
        self.run(move |connection| bindings::delete(connection, command))
            .await
    }

    async fn copy_bindings(
        &self,
        command: CopyAssetBindings,
    ) -> ProductResult<CopyAssetBindingsResult> {
        self.run(move |connection| bindings::copy(connection, command))
            .await
    }
}
