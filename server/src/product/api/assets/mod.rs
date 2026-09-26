mod dto;
mod handlers;

#[cfg(test)]
mod tests;

use crate::product::application::assets::AssetService;
use axum::routing::{get, patch, post};
use axum::Router;

#[derive(Clone)]
pub(super) struct AssetApiState {
    pub service: AssetService,
}

pub(super) fn router(service: AssetService) -> Router {
    Router::new()
        .route(
            "/api/v1/projects/:project_id/storyboards/:storyboard_id/asset-sections",
            get(handlers::list_sections).post(handlers::create_section),
        )
        .route(
            "/api/v1/projects/:project_id/storyboards/:storyboard_id/asset-sections/:section_id",
            patch(handlers::update_section)
                .delete(handlers::delete_section),
        )
        .route(
            "/api/v1/projects/:project_id/storyboards/:storyboard_id/asset-sections/:section_id/reorder",
            post(handlers::reorder_section),
        )
        .route(
            "/api/v1/projects/:project_id/assets",
            get(handlers::list_assets).post(handlers::create_asset),
        )
        .route(
            "/api/v1/projects/:project_id/assets/:asset_id",
            get(handlers::get_asset)
                .patch(handlers::update_asset)
                .delete(handlers::delete_asset),
        )
        .route(
            "/api/v1/projects/:project_id/assets/:asset_id/representations",
            post(handlers::create_representation),
        )
        .route(
            "/api/v1/projects/:project_id/storyboards/:storyboard_id/asset-bindings",
            get(handlers::list_bindings).post(handlers::create_bindings),
        )
        .route(
            "/api/v1/projects/:project_id/storyboards/:storyboard_id/asset-bindings/:binding_id",
            patch(handlers::update_binding)
                .delete(handlers::delete_binding),
        )
        .route(
            "/api/v1/projects/:project_id/storyboards/:source_storyboard_id/asset-bindings:copy",
            post(handlers::copy_bindings),
        )
        .with_state(AssetApiState { service })
}
