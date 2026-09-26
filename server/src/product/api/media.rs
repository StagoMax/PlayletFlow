use super::error::ProductApiError;
use crate::product::application::media::{
    MediaAccessGrant, MediaCatalogService, MediaListQuery, MediaPresentation,
    MediaPresentationPage, UpdateMediaMetadata, DEFAULT_MEDIA_PAGE_SIZE,
};
use crate::product::domain::{
    MediaId, MediaKind, MediaOwner, MediaRole, MediaStatus, ProductError, ProjectId, StoryboardId,
};
use axum::extract::rejection::{JsonRejection, QueryRejection};
use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::routing::{get, post};
use axum::{Json, Router};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashSet;
use uuid::Uuid;

#[derive(Clone)]
struct MediaApiState {
    service: MediaCatalogService,
}

/// Media routes under the versioned product API base.
pub fn router(service: MediaCatalogService) -> Router {
    let state = MediaApiState { service };
    Router::new()
        .route(
            "/api/v1/projects/:project_id/storyboards/:storyboard_id/media",
            get(list_storyboard_media),
        )
        .route(
            "/api/v1/projects/:project_id/media/:media_id",
            get(get_media).patch(update_media).delete(delete_media),
        )
        .route(
            "/api/v1/projects/:project_id/media/:media_id/access",
            post(refresh_media_access),
        )
        .with_state(state)
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct MediaListParams {
    role: Option<String>,
    cursor: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct UpdateMediaRequest {
    name: String,
    prompt: Option<String>,
    expected_revision: i64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct DeleteMediaParams {
    expected_revision: i64,
}

async fn list_storyboard_media(
    State(state): State<MediaApiState>,
    Path((project_id, storyboard_id)): Path<(String, String)>,
    params: Result<Query<MediaListParams>, QueryRejection>,
) -> Result<Json<MediaListResponse>, ProductApiError> {
    let project_id = ProjectId(parse_uuid("projectId", &project_id)?);
    let storyboard_id = StoryboardId(parse_uuid("storyboardId", &storyboard_id)?);
    let params = params.map_err(ProductApiError::from_query_rejection)?.0;
    let roles = parse_roles(params.role.as_deref())?;
    let cursor = params
        .cursor
        .as_deref()
        .map(crate::product::application::media::MediaCursor::decode)
        .transpose()?;
    let page = state
        .service
        .list(MediaListQuery {
            project_id,
            storyboard_id,
            roles,
            cursor,
            limit: DEFAULT_MEDIA_PAGE_SIZE,
        })
        .await?;
    Ok(Json(page.into()))
}

async fn get_media(
    State(state): State<MediaApiState>,
    Path((project_id, media_id)): Path<(String, String)>,
) -> Result<Json<MediaResponse>, ProductApiError> {
    let project_id = ProjectId(parse_uuid("projectId", &project_id)?);
    let media_id = MediaId(parse_uuid("mediaId", &media_id)?);
    Ok(Json(state.service.get(project_id, media_id).await?.into()))
}

async fn update_media(
    State(state): State<MediaApiState>,
    Path((project_id, media_id)): Path<(String, String)>,
    body: Result<Json<UpdateMediaRequest>, JsonRejection>,
) -> Result<Json<MediaResponse>, ProductApiError> {
    let project_id = ProjectId(parse_uuid("projectId", &project_id)?);
    let media_id = MediaId(parse_uuid("mediaId", &media_id)?);
    let body = body.map_err(ProductApiError::from_json_rejection)?.0;
    let media = state
        .service
        .update(UpdateMediaMetadata {
            project_id,
            media_id,
            name: body.name,
            prompt: body.prompt,
            expected_revision: body.expected_revision,
        })
        .await?;
    Ok(Json(media.into()))
}

async fn delete_media(
    State(state): State<MediaApiState>,
    Path((project_id, media_id)): Path<(String, String)>,
    params: Result<Query<DeleteMediaParams>, QueryRejection>,
) -> Result<StatusCode, ProductApiError> {
    let project_id = ProjectId(parse_uuid("projectId", &project_id)?);
    let media_id = MediaId(parse_uuid("mediaId", &media_id)?);
    let params = params.map_err(ProductApiError::from_query_rejection)?.0;
    state
        .service
        .delete(project_id, media_id, params.expected_revision)
        .await?;
    Ok(StatusCode::NO_CONTENT)
}

async fn refresh_media_access(
    State(state): State<MediaApiState>,
    Path((project_id, media_id)): Path<(String, String)>,
) -> Result<Json<MediaAccessResponse>, ProductApiError> {
    let project_id = ProjectId(parse_uuid("projectId", &project_id)?);
    let media_id = MediaId(parse_uuid("mediaId", &media_id)?);
    let presentation = state.service.refresh_access(project_id, media_id).await?;
    Ok(Json(MediaAccessResponse::from(presentation)))
}

fn parse_uuid(field: &str, value: &str) -> Result<Uuid, ProductApiError> {
    Uuid::parse_str(value)
        .map_err(|_| ProductApiError::invalid_request(format!("{field} must be a UUID")))
}

fn parse_roles(value: Option<&str>) -> Result<Vec<MediaRole>, ProductApiError> {
    let mut roles = Vec::new();
    let mut seen = HashSet::new();
    for role in value.into_iter().flat_map(|value| value.split(',')) {
        let role = role.trim();
        if role.is_empty() {
            continue;
        }
        let parsed = MediaRole::from_api_str(role).ok_or_else(|| {
            ProductApiError::from(ProductError::Validation(format!(
                "unsupported media role: {role}"
            )))
        })?;
        if seen.insert(parsed) {
            roles.push(parsed);
        }
    }
    Ok(roles)
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct MediaListResponse {
    items: Vec<MediaResponse>,
    page: PageResponse,
}

impl From<MediaPresentationPage> for MediaListResponse {
    fn from(page: MediaPresentationPage) -> Self {
        Self {
            items: page.items.into_iter().map(Into::into).collect(),
            page: PageResponse {
                next_cursor: page.next_cursor,
                total: page.total,
            },
        }
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct PageResponse {
    next_cursor: Option<String>,
    total: usize,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct MediaResponse {
    id: MediaId,
    project_id: ProjectId,
    owner: MediaOwner,
    kind: MediaKind,
    role: MediaRole,
    name: String,
    prompt: Option<String>,
    mime_type: String,
    width: Option<i64>,
    height: Option<i64>,
    duration_ms: Option<i64>,
    status: MediaStatus,
    revision: i64,
    thumbnail: Option<MediaThumbnailResponse>,
    preview: Option<MediaPreviewResponse>,
    generation: Option<Value>,
    created_at: DateTime<Utc>,
    updated_at: DateTime<Utc>,
}

impl From<MediaPresentation> for MediaResponse {
    fn from(presentation: MediaPresentation) -> Self {
        let media = presentation.media;
        Self {
            id: media.id,
            project_id: media.project_id,
            owner: media.owner,
            kind: media.kind,
            role: media.role,
            name: media.name,
            prompt: media.prompt,
            mime_type: media.mime_type,
            width: media.width,
            height: media.height,
            duration_ms: media.duration_ms,
            status: media.status,
            revision: media.revision,
            thumbnail: presentation.thumbnail.map(Into::into),
            preview: presentation.preview.map(Into::into),
            generation: None,
            created_at: media.created_at,
            updated_at: media.updated_at,
        }
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct MediaThumbnailResponse {
    url: String,
    expires_at: Option<DateTime<Utc>>,
    width: i64,
    height: i64,
}

impl From<MediaAccessGrant> for MediaThumbnailResponse {
    fn from(grant: MediaAccessGrant) -> Self {
        Self {
            url: grant.url,
            expires_at: grant.expires_at,
            width: grant.width,
            height: grant.height,
        }
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct MediaPreviewResponse {
    url: String,
    expires_at: Option<DateTime<Utc>>,
    width: i64,
    height: i64,
    mime_type: String,
}

impl From<MediaAccessGrant> for MediaPreviewResponse {
    fn from(grant: MediaAccessGrant) -> Self {
        Self {
            url: grant.url,
            expires_at: grant.expires_at,
            width: grant.width,
            height: grant.height,
            mime_type: grant.mime_type,
        }
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct MediaAccessResponse {
    thumbnail: Option<MediaThumbnailResponse>,
    preview: Option<MediaPreviewResponse>,
}

impl From<MediaPresentation> for MediaAccessResponse {
    fn from(presentation: MediaPresentation) -> Self {
        Self {
            thumbnail: presentation.thumbnail.map(Into::into),
            preview: presentation.preview.map(Into::into),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::product::domain::{MediaItem, StoryboardId};
    use crate::product::ProductDatabase;
    use axum::body::{to_bytes, Body};
    use axum::http::Request;
    use rusqlite::params;
    use std::path::PathBuf;
    use tower::ServiceExt;

    struct EntryFixture {
        database: ProductDatabase,
        path: PathBuf,
        project_id: ProjectId,
        storyboard_id: StoryboardId,
        media_id: MediaId,
    }

    impl EntryFixture {
        fn new() -> Self {
            let path =
                std::env::temp_dir().join(format!("videoflow-media-api-{}.sqlite", Uuid::new_v4()));
            let database = ProductDatabase::open(&path).unwrap();
            let fixture = Self {
                database,
                path,
                project_id: ProjectId::new(),
                storyboard_id: StoryboardId::new(),
                media_id: MediaId::new(),
            };
            fixture.seed();
            fixture
        }

        fn seed(&self) {
            let connection = self.database.connect().unwrap();
            let now = "2026-09-26T00:00:00Z";
            connection
                .execute(
                    "INSERT INTO projects (id, name, revision, created_at, updated_at) \
                     VALUES (?1, 'Media project', 1, ?2, ?2)",
                    params![self.project_id.to_string(), now],
                )
                .unwrap();
            connection
                .execute(
                    "INSERT INTO storyboards \
                     (id, project_id, name, position, revision, created_at, updated_at) \
                     VALUES (?1, ?2, 'Opening', 'a', 1, ?3, ?3)",
                    params![
                        self.storyboard_id.to_string(),
                        self.project_id.to_string(),
                        now
                    ],
                )
                .unwrap();
            connection
                .execute(
                    "INSERT INTO media_items \
                     (id, project_id, storyboard_id, kind, role, name, prompt, mime_type, \
                      source_object_key, thumbnail_object_key, width, height, status, revision, \
                      created_at, updated_at) \
                     VALUES (?1, ?2, ?3, 'image', 'keyframe', 'Opening frame', 'wide shot', \
                             'image/webp', 'private/source', 'private/thumb', 1920, 1080, \
                             'ready', 1, ?4, ?4)",
                    params![
                        self.media_id.to_string(),
                        self.project_id.to_string(),
                        self.storyboard_id.to_string(),
                        now
                    ],
                )
                .unwrap();
        }
    }

    impl Drop for EntryFixture {
        fn drop(&mut self) {
            for path in [
                self.path.clone(),
                PathBuf::from(format!("{}-wal", self.path.display())),
                PathBuf::from(format!("{}-shm", self.path.display())),
            ] {
                let _ = std::fs::remove_file(path);
            }
        }
    }

    #[test]
    fn role_filter_accepts_comma_separated_values_and_deduplicates() {
        assert_eq!(
            parse_roles(Some("keyframe,generatedVideo,keyframe")).unwrap(),
            vec![MediaRole::Keyframe, MediaRole::GeneratedVideo]
        );
        assert!(parse_roles(Some("not-a-role")).is_err());
    }

    #[test]
    fn media_response_never_leaks_internal_object_keys() {
        let now = Utc::now();
        let response = MediaResponse::from(MediaPresentation {
            media: MediaItem {
                id: MediaId::new(),
                project_id: ProjectId::new(),
                owner: MediaOwner::Storyboard {
                    storyboard_id: StoryboardId::new(),
                },
                kind: MediaKind::Image,
                role: MediaRole::Keyframe,
                name: "Keyframe".into(),
                prompt: Some("cinematic".into()),
                mime_type: "image/webp".into(),
                source_object_key: Some("private/source".into()),
                thumbnail_object_key: Some("private/thumb".into()),
                width: Some(1920),
                height: Some(1080),
                duration_ms: None,
                status: MediaStatus::Ready,
                revision: 1,
                created_at: now,
                updated_at: now,
                deleted_at: None,
            },
            thumbnail: None,
            preview: None,
        });
        let value = serde_json::to_value(response).unwrap();
        assert!(value.get("sourceObjectKey").is_none());
        assert!(value.get("thumbnailObjectKey").is_none());
        assert_eq!(value["generation"], Value::Null);
    }

    #[tokio::test]
    async fn product_entry_mounts_media_metadata_and_access_routes() {
        let fixture = EntryFixture::new();
        let router = crate::product::api::router(fixture.database.clone());
        let list_uri = format!(
            "/api/v1/projects/{}/storyboards/{}/media?role=keyframe",
            fixture.project_id, fixture.storyboard_id
        );
        let list = router
            .clone()
            .oneshot(Request::get(list_uri).body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert_eq!(list.status(), StatusCode::OK);
        let list_body: Value =
            serde_json::from_slice(&to_bytes(list.into_body(), 64_000).await.unwrap()).unwrap();
        assert_eq!(list_body["items"][0]["id"], fixture.media_id.to_string());
        assert_eq!(list_body["items"][0]["thumbnail"], Value::Null);
        assert!(list_body["items"][0].get("sourceObjectKey").is_none());

        let access_uri = format!(
            "/api/v1/projects/{}/media/{}/access",
            fixture.project_id, fixture.media_id
        );
        let access = router
            .oneshot(Request::post(access_uri).body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert_eq!(access.status(), StatusCode::OK);
        let access_body: Value =
            serde_json::from_slice(&to_bytes(access.into_body(), 64_000).await.unwrap()).unwrap();
        assert_eq!(access_body["thumbnail"], Value::Null);
        assert_eq!(access_body["preview"], Value::Null);
    }
}
