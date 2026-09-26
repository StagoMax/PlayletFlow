mod assets;
mod error;
mod generation;
mod proposals;
mod storyboard_views;
mod storyboards;
mod workspace_nodes;
mod workspace_threads;

#[cfg(test)]
mod workspace_nodes_tests;

use crate::product::application::assets::AssetService;
use crate::product::application::generation::GenerationService;
use crate::product::application::media::{MediaAccessProvider, MediaCatalogService};
use crate::product::application::proposals::ProposalService;
use crate::product::application::storyboards::StoryboardService;
use crate::product::application::workspace_nodes::WorkspaceNodeService;
use crate::product::application::workspace_threads::WorkspaceThreadService;
use crate::product::infrastructure::sqlite::{
    ProductDatabase, SqliteAssetRepository, SqliteGenerationRepository, SqliteMediaRepository,
    SqliteProposalRepository, SqliteStoryboardRepository, SqliteWorkspaceNodeRepository,
};
use crate::product::infrastructure::MetadataOnlyMediaAccessProvider;
use axum::Router;
use std::sync::Arc;

pub mod media;

/// Composes the product routes that are backed by the local persistent store.
pub fn router(database: ProductDatabase) -> Router {
    router_with_media_access(database, Arc::new(MetadataOnlyMediaAccessProvider))
}

/// Composition seam for deployments that can issue real object-store access.
pub fn router_with_media_access(
    database: ProductDatabase,
    media_access: Arc<dyn MediaAccessProvider>,
) -> Router {
    compose_router(database, media_access, None)
}

/// Composition seam used by the local Runtime, where product workspaces and
/// persisted conversations share the same process.
pub fn router_with_workspace(
    database: ProductDatabase,
    workspace_threads: WorkspaceThreadService,
) -> Router {
    router_with_workspace_and_media_access(
        database,
        workspace_threads,
        Arc::new(MetadataOnlyMediaAccessProvider),
    )
}

pub fn router_with_workspace_and_media_access(
    database: ProductDatabase,
    workspace_threads: WorkspaceThreadService,
    media_access: Arc<dyn MediaAccessProvider>,
) -> Router {
    compose_router(database, media_access, Some(workspace_threads))
}

fn compose_router(
    database: ProductDatabase,
    media_access: Arc<dyn MediaAccessProvider>,
    workspace_threads: Option<WorkspaceThreadService>,
) -> Router {
    let repository = Arc::new(SqliteStoryboardRepository::new(database.clone()));
    let service = StoryboardService::new(repository);
    let asset_repository = Arc::new(SqliteAssetRepository::new(database.clone()));
    let asset_service = AssetService::new(asset_repository);
    let media_repository = Arc::new(SqliteMediaRepository::new(database.clone()));
    let media_service = MediaCatalogService::new(media_repository, media_access);
    let proposal_repository = Arc::new(SqliteProposalRepository::new(database.clone()));
    let proposal_service = ProposalService::new(proposal_repository);
    let workspace_node_repository = Arc::new(SqliteWorkspaceNodeRepository::new(database.clone()));
    let workspace_node_service = WorkspaceNodeService::new(workspace_node_repository);
    let generation_repository = Arc::new(SqliteGenerationRepository::new(database));
    let generation_service = GenerationService::new(generation_repository);
    let router = storyboards::router(service)
        .merge(assets::router(asset_service))
        .merge(media::router(media_service))
        .merge(proposals::router(proposal_service))
        .merge(workspace_nodes::router(workspace_node_service))
        .merge(generation::router(generation_service));
    match workspace_threads {
        Some(service) => router.merge(workspace_threads::router(service)),
        None => router,
    }
}
