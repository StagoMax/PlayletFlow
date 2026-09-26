use super::media::{
    MediaAccessGrant, MediaAccessProvider, MediaCatalogService, MediaListQuery, MediaPage,
    MediaRepository, UpdateMediaMetadata,
};
use crate::product::domain::{
    MediaId, MediaItem, MediaKind, MediaOwner, MediaRole, MediaStatus, ProductError, ProductResult,
    ProjectId, StoryboardId,
};
use async_trait::async_trait;
use chrono::{Duration, Utc};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;

#[derive(Clone)]
struct SingleMediaRepository {
    item: MediaItem,
}

#[async_trait]
impl MediaRepository for SingleMediaRepository {
    async fn find_media(
        &self,
        project_id: ProjectId,
        id: MediaId,
    ) -> ProductResult<Option<MediaItem>> {
        Ok((self.item.project_id == project_id && self.item.id == id).then(|| self.item.clone()))
    }

    async fn list_storyboard_media(&self, _query: &MediaListQuery) -> ProductResult<MediaPage> {
        Err(ProductError::Storage("not used by this fixture".into()))
    }

    async fn insert_media(&self, _media: &MediaItem) -> ProductResult<()> {
        Err(ProductError::Storage("not used by this fixture".into()))
    }

    async fn update_media_metadata(
        &self,
        _update: &UpdateMediaMetadata,
    ) -> ProductResult<MediaItem> {
        Err(ProductError::Storage("not used by this fixture".into()))
    }

    async fn soft_delete_storyboard_media(
        &self,
        _project_id: ProjectId,
        _media_id: MediaId,
        _expected_revision: i64,
    ) -> ProductResult<()> {
        Err(ProductError::Storage("not used by this fixture".into()))
    }
}

#[derive(Default)]
struct RotatingAccessProvider {
    sequence: AtomicUsize,
}

#[async_trait]
impl MediaAccessProvider for RotatingAccessProvider {
    async fn thumbnail(&self, _media: &MediaItem) -> ProductResult<Option<MediaAccessGrant>> {
        Ok(Some(self.grant("thumbnail", 320, 180)))
    }

    async fn preview(&self, media: &MediaItem) -> ProductResult<Option<MediaAccessGrant>> {
        Ok(Some(self.grant(
            "preview",
            media.width.unwrap_or(1),
            media.height.unwrap_or(1),
        )))
    }
}

impl RotatingAccessProvider {
    fn grant(&self, variant: &str, width: i64, height: i64) -> MediaAccessGrant {
        let sequence = self.sequence.fetch_add(1, Ordering::SeqCst);
        MediaAccessGrant {
            url: format!("https://media.invalid/{variant}?token={sequence}"),
            expires_at: Some(Utc::now() + Duration::minutes(5)),
            width,
            height,
            mime_type: "image/webp".into(),
        }
    }
}

fn media_fixture() -> MediaItem {
    let now = Utc::now();
    MediaItem {
        id: MediaId::new(),
        project_id: ProjectId::new(),
        owner: MediaOwner::Storyboard {
            storyboard_id: StoryboardId::new(),
        },
        kind: MediaKind::Image,
        role: MediaRole::Keyframe,
        name: "Opening keyframe".into(),
        prompt: Some("wide cinematic shot".into()),
        mime_type: "image/webp".into(),
        source_object_key: Some("private/source.webp".into()),
        thumbnail_object_key: Some("private/thumbnail.webp".into()),
        width: Some(1920),
        height: Some(1080),
        duration_ms: None,
        status: MediaStatus::Ready,
        revision: 1,
        created_at: now,
        updated_at: now,
        deleted_at: None,
    }
}

#[tokio::test]
async fn refreshing_access_requests_new_expiring_urls() {
    let item = media_fixture();
    let service = MediaCatalogService::new(
        Arc::new(SingleMediaRepository { item: item.clone() }),
        Arc::new(RotatingAccessProvider::default()),
    );

    let first = service
        .refresh_access(item.project_id, item.id)
        .await
        .unwrap();
    let second = service
        .refresh_access(item.project_id, item.id)
        .await
        .unwrap();

    let first_preview = first.preview.unwrap();
    let second_preview = second.preview.unwrap();
    assert_ne!(first_preview.url, second_preview.url);
    assert!(first_preview.expires_at.is_some());
    assert_eq!((first_preview.width, first_preview.height), (1920, 1080));
    assert_eq!(
        (first.thumbnail.unwrap().width, first_preview.mime_type),
        (320, "image/webp".to_owned())
    );
}

#[tokio::test]
async fn media_fixture_is_project_scoped() {
    let item = media_fixture();
    let service = MediaCatalogService::new(
        Arc::new(SingleMediaRepository { item: item.clone() }),
        Arc::new(RotatingAccessProvider::default()),
    );

    let error = service
        .get(ProjectId::new(), item.id)
        .await
        .expect_err("another project must not observe the media");
    assert!(matches!(error, ProductError::NotFound));
}
