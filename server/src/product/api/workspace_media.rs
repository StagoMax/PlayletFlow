use super::error::ProductApiError;
use super::media::MediaResponse;
use crate::product::application::media::MediaCatalogService;
use crate::product::domain::{MediaId, MediaKind, ProductError, ProjectId, StoryboardId};
use crate::product::infrastructure::{sqlite::SqliteWorkspaceMediaRepository, LocalMediaStore};
use axum::body::Bytes;
use axum::extract::{DefaultBodyLimit, Path, Query, State};
use axum::http::{header::CONTENT_TYPE, HeaderMap};
use axum::routing::post;
use axum::{Json, Router};
use serde::Deserialize;
use std::sync::Arc;
use uuid::Uuid;

const MAX_UPLOAD_BYTES: usize = 100 * 1024 * 1024;
const MAX_GENERATION_INPUT_BYTES: usize = 8 * 1024 * 1024;

#[derive(Clone)]
struct StateData {
    repository: SqliteWorkspaceMediaRepository,
    media: MediaCatalogService,
    store: Option<Arc<LocalMediaStore>>,
}

pub(super) fn router(
    repository: SqliteWorkspaceMediaRepository,
    media: MediaCatalogService,
    store: Option<Arc<LocalMediaStore>>,
) -> Router {
    Router::new()
        .route(
            "/api/v1/projects/:project_id/storyboards/:storyboard_id/workspace-nodes/:node_id/media",
            post(ensure_media).put(upload_media),
        )
        .route(
            "/api/v1/projects/:project_id/storyboards/:storyboard_id/generation-inputs/:input_id",
            axum::routing::put(upload_generation_input),
        )
        .layer(DefaultBodyLimit::max(MAX_UPLOAD_BYTES))
        .with_state(StateData { repository, media, store })
}

async fn ensure_media(
    State(state): State<StateData>,
    Path((project, storyboard, node_id)): Path<(String, String, String)>,
) -> Result<Json<MediaResponse>, ProductApiError> {
    let project_id = ProjectId(parse_uuid("projectId", &project)?);
    let storyboard_id = StoryboardId(parse_uuid("storyboardId", &storyboard)?);
    let media_id = state
        .repository
        .ensure(project_id, storyboard_id, node_id)
        .await?;
    Ok(Json(state.media.get(project_id, media_id).await?.into()))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct UploadParams {
    width: i64,
    height: i64,
    duration_ms: Option<i64>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct GenerationInputParams {
    name: String,
    width: i64,
    height: i64,
}

async fn upload_generation_input(
    State(state): State<StateData>,
    Path((project, storyboard, input_id)): Path<(String, String, String)>,
    Query(params): Query<GenerationInputParams>,
    headers: HeaderMap,
    bytes: Bytes,
) -> Result<Json<MediaResponse>, ProductApiError> {
    let project_id = ProjectId(parse_uuid("projectId", &project)?);
    let storyboard_id = StoryboardId(parse_uuid("storyboardId", &storyboard)?);
    let media_id = MediaId(parse_uuid("inputId", &input_id)?);
    let store = state.store.ok_or_else(|| {
        ProductError::DependencyUnavailable("local media storage is unavailable".into())
    })?;
    let mime_type = headers
        .get(CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .unwrap_or("")
        .split(';')
        .next()
        .unwrap_or("")
        .trim();
    if bytes.is_empty() || bytes.len() > MAX_GENERATION_INPUT_BYTES {
        return Err(ProductError::Validation(
            "generation input must be between 1 byte and 8 MB".into(),
        )
        .into());
    }
    if params.name.trim().is_empty() || params.name.chars().count() > 255 {
        return Err(ProductError::Validation("generation input name is invalid".into()).into());
    }
    let kind = validate_upload(
        mime_type,
        &bytes,
        &UploadParams {
            width: params.width,
            height: params.height,
            duration_ms: None,
        },
    )?;
    if kind != MediaKind::Image {
        return Err(ProductError::Validation("generation input must be an image".into()).into());
    }
    let object_key = store
        .store_generation_input(media_id, &bytes, mime_type)
        .await?;
    state
        .repository
        .insert_generation_input(
            project_id,
            storyboard_id,
            media_id,
            params.name.trim().to_owned(),
            object_key,
            mime_type.to_owned(),
            params.width,
            params.height,
        )
        .await?;
    Ok(Json(state.media.get(project_id, media_id).await?.into()))
}

async fn upload_media(
    State(state): State<StateData>,
    Path((project, storyboard, node_id)): Path<(String, String, String)>,
    Query(params): Query<UploadParams>,
    headers: HeaderMap,
    bytes: Bytes,
) -> Result<Json<MediaResponse>, ProductApiError> {
    let project_id = ProjectId(parse_uuid("projectId", &project)?);
    let storyboard_id = StoryboardId(parse_uuid("storyboardId", &storyboard)?);
    let store = state.store.ok_or_else(|| {
        ProductError::DependencyUnavailable("local media storage is unavailable".into())
    })?;
    let mime_type = headers
        .get(CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .unwrap_or("")
        .split(';')
        .next()
        .unwrap_or("")
        .trim();
    let kind = validate_upload(mime_type, &bytes, &params)?;
    let media_id = state
        .repository
        .ensure(project_id, storyboard_id, node_id.clone())
        .await?;
    let current = state.media.get(project_id, media_id).await?;
    if current.media.kind != kind {
        return Err(ProductError::Validation(
            "uploaded file type does not match the object".into(),
        )
        .into());
    }
    let key = store.store_upload(&bytes, mime_type).await?;
    state
        .repository
        .attach_upload(
            project_id,
            storyboard_id,
            node_id,
            media_id,
            key,
            mime_type.to_owned(),
            params.width,
            params.height,
            params.duration_ms,
        )
        .await?;
    Ok(Json(state.media.get(project_id, media_id).await?.into()))
}

fn validate_upload(
    mime: &str,
    bytes: &[u8],
    params: &UploadParams,
) -> Result<MediaKind, ProductApiError> {
    if bytes.is_empty() || bytes.len() > MAX_UPLOAD_BYTES {
        return Err(
            ProductError::Validation("file must be between 1 byte and 100 MB".into()).into(),
        );
    }
    if params.width < 1
        || params.height < 1
        || params.width > 32768
        || params.height > 32768
        || params.duration_ms.is_some_and(|duration| duration < 0)
    {
        return Err(ProductError::Validation("invalid media dimensions or duration".into()).into());
    }
    let kind = match mime {
        "image/jpeg" if bytes.starts_with(&[0xff, 0xd8, 0xff]) => MediaKind::Image,
        "image/png" if bytes.starts_with(b"\x89PNG\r\n\x1a\n") => MediaKind::Image,
        "image/webp" if bytes.starts_with(b"RIFF") && bytes.get(8..12) == Some(b"WEBP") => {
            MediaKind::Image
        }
        "video/mp4" | "video/quicktime" if bytes.get(4..8) == Some(b"ftyp") => MediaKind::Video,
        _ => {
            return Err(ProductError::Validation("unsupported or invalid media file".into()).into())
        }
    };
    Ok(kind)
}

fn parse_uuid(field: &str, value: &str) -> Result<Uuid, ProductApiError> {
    Uuid::parse_str(value)
        .map_err(|_| ProductApiError::invalid_request(format!("{field} must be a UUID")))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::product::application::media::{
        MediaAccessProvider, MediaCatalogService, MediaRepository,
    };
    use crate::product::infrastructure::sqlite::{ProductDatabase, SqliteMediaRepository};
    use axum::body::{to_bytes, Body};
    use axum::http::{Method, Request, StatusCode};
    use base64::Engine;
    use rusqlite::params;
    use tower::ServiceExt;

    #[tokio::test]
    async fn empty_image_can_be_uploaded_and_reopened() {
        let root = std::env::temp_dir().join(format!("videoflow-media-upload-{}", Uuid::new_v4()));
        let database = ProductDatabase::open(root.join("product.sqlite")).unwrap();
        let store = Arc::new(LocalMediaStore::new(root.join("media")).unwrap());
        let project = ProjectId(Uuid::new_v4());
        let storyboard = StoryboardId(Uuid::new_v4());
        let node_id = Uuid::new_v4().to_string();
        let now = chrono::Utc::now().to_rfc3339();
        let connection = database.connect().unwrap();
        connection
            .execute(
                "INSERT INTO projects (id, name, revision, created_at, updated_at) \
            VALUES (?1, 'Film', 1, ?2, ?2)",
                params![project.to_string(), now],
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO storyboards (id, project_id, name, position, revision, \
            created_at, updated_at) VALUES (?1, ?2, 'Scene', '1024', 1, ?3, ?3)",
                params![storyboard.to_string(), project.to_string(), now],
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO workspace_nodes (id, project_id, storyboard_id, kind, name, \
            object_type, target_type, position, revision, created_at, updated_at) \
            VALUES (?1, ?2, ?3, 'object', 'Frame', 'image', 'empty', '1024', 1, ?4, ?4)",
                params![node_id, project.to_string(), storyboard.to_string(), now],
            )
            .unwrap();
        drop(connection);

        let media_service = MediaCatalogService::new(
            Arc::new(SqliteMediaRepository::new(database.clone())),
            store.clone(),
        );
        let app = router(
            SqliteWorkspaceMediaRepository::new(database.clone()),
            media_service,
            Some(store.clone()),
        );
        let uri = format!(
            "/api/v1/projects/{project}/storyboards/{storyboard}/workspace-nodes/{node_id}/media"
        );
        let request = Request::builder()
            .method(Method::POST)
            .uri(&uri)
            .body(Body::empty())
            .unwrap();
        let response = app.clone().oneshot(request).await.unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let body: serde_json::Value =
            serde_json::from_slice(&to_bytes(response.into_body(), usize::MAX).await.unwrap())
                .unwrap();
        assert_eq!(body["id"], node_id);
        assert_eq!(body["status"], "placeholder");

        let png = base64::engine::general_purpose::STANDARD.decode(
            "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScL/nwAAAABJRU5ErkJggg=="
        ).unwrap();
        let request = Request::builder()
            .method(Method::PUT)
            .uri(format!("{uri}?width=1&height=1"))
            .header(CONTENT_TYPE, "image/png")
            .body(Body::from(png.clone()))
            .unwrap();
        let response = app.clone().oneshot(request).await.unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let body: serde_json::Value =
            serde_json::from_slice(&to_bytes(response.into_body(), usize::MAX).await.unwrap())
                .unwrap();
        assert_eq!(body["status"], "ready");
        assert!(body["preview"]["url"]
            .as_str()
            .unwrap()
            .starts_with("/api/v1/media-files/uploaded/"));

        let response = app
            .clone()
            .oneshot(
                Request::builder()
                    .method(Method::POST)
                    .uri(&uri)
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        let body: serde_json::Value =
            serde_json::from_slice(&to_bytes(response.into_body(), usize::MAX).await.unwrap())
                .unwrap();
        assert_eq!(body["status"], "ready");
        let saved: (String, String) = database
            .connect()
            .unwrap()
            .query_row(
                "SELECT target_type, target_id FROM workspace_nodes WHERE id = ?1",
                [&node_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!(saved, ("media".into(), node_id));

        let input_id = Uuid::new_v4();
        let input_uri = format!(
            "/api/v1/projects/{project}/storyboards/{storyboard}/generation-inputs/{input_id}?name=Reference&width=1&height=1"
        );
        for _ in 0..2 {
            let response = app
                .clone()
                .oneshot(
                    Request::builder()
                        .method(Method::PUT)
                        .uri(&input_uri)
                        .header(CONTENT_TYPE, "image/png")
                        .body(Body::from(png.clone()))
                        .unwrap(),
                )
                .await
                .unwrap();
            assert_eq!(response.status(), StatusCode::OK);
            let body: serde_json::Value =
                serde_json::from_slice(&to_bytes(response.into_body(), usize::MAX).await.unwrap())
                    .unwrap();
            assert_eq!(body["id"], input_id.to_string());
            assert_eq!(body["status"], "ready");
        }
        let input = SqliteMediaRepository::new(database.clone())
            .find_media(project, MediaId(input_id))
            .await
            .unwrap()
            .unwrap();
        assert!(store
            .generation_input(&input)
            .await
            .unwrap()
            .unwrap()
            .starts_with("data:image/png;base64,"));
        let mut different_png = png.clone();
        different_png.push(0);
        let response = app
            .clone()
            .oneshot(
                Request::builder()
                    .method(Method::PUT)
                    .uri(&input_uri)
                    .header(CONTENT_TYPE, "image/png")
                    .body(Body::from(different_png))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::UNPROCESSABLE_ENTITY);

        let video_id = Uuid::new_v4().to_string();
        database
            .connect()
            .unwrap()
            .execute(
                "INSERT INTO workspace_nodes (id, project_id, storyboard_id, \
            kind, name, object_type, target_type, position, revision, created_at, updated_at) \
            VALUES (?1, ?2, ?3, 'object', 'Clip', 'video', 'empty', '2048', 1, ?4, ?4)",
                params![video_id, project.to_string(), storyboard.to_string(), now],
            )
            .unwrap();
        let video_uri = format!(
            "/api/v1/projects/{project}/storyboards/{storyboard}/workspace-nodes/{video_id}/media"
        );
        let app = router(
            SqliteWorkspaceMediaRepository::new(database.clone()),
            MediaCatalogService::new(
                Arc::new(SqliteMediaRepository::new(database.clone())),
                Arc::new(LocalMediaStore::new(root.join("media")).unwrap()),
            ),
            Some(Arc::new(LocalMediaStore::new(root.join("media")).unwrap())),
        );
        let request = Request::builder()
            .method(Method::PUT)
            .uri(format!(
                "{video_uri}?width=1920&height=1080&durationMs=4000"
            ))
            .header(CONTENT_TYPE, "video/mp4")
            .body(Body::from(b"\0\0\0\x18ftypisom0000".to_vec()))
            .unwrap();
        let response = app.oneshot(request).await.unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let body: serde_json::Value =
            serde_json::from_slice(&to_bytes(response.into_body(), usize::MAX).await.unwrap())
                .unwrap();
        assert_eq!(body["kind"], "video");
        assert_eq!(body["status"], "ready");
        assert_eq!(body["durationMs"], 4000);
        assert_eq!(body["preview"]["mimeType"], "video/mp4");
        drop(database);
        let _ = std::fs::remove_dir_all(root);
    }
}
