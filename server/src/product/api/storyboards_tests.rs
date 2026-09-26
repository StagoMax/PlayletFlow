use super::*;
use crate::product::infrastructure::sqlite::{ProductDatabase, SqliteStoryboardRepository};
use axum::body::{to_bytes, Body};
use axum::http::{Request, StatusCode};
use serde_json::{json, Value};
use std::path::PathBuf;
use std::sync::Arc;
use tower::ServiceExt;

struct TestApp {
    path: PathBuf,
    router: Router,
}

impl TestApp {
    fn new() -> Self {
        let path = std::env::temp_dir().join(format!(
            "videoflow-storyboard-api-{}.sqlite",
            Uuid::new_v4()
        ));
        let database = ProductDatabase::open(&path).expect("open product test database");
        let service = StoryboardService::new(Arc::new(SqliteStoryboardRepository::new(database)));
        Self {
            path,
            router: router(service),
        }
    }

    async fn send(
        &self,
        method: &str,
        uri: &str,
        body: Option<Value>,
        idempotency_key: Option<&str>,
    ) -> (StatusCode, Option<Value>) {
        let mut builder = Request::builder().method(method).uri(uri);
        if body.is_some() {
            builder = builder.header("content-type", "application/json");
        }
        if let Some(key) = idempotency_key {
            builder = builder.header("Idempotency-Key", key);
        }
        let request = builder
            .body(body.map_or_else(Body::empty, |body| Body::from(body.to_string())))
            .unwrap();
        let response = self.router.clone().oneshot(request).await.unwrap();
        let status = response.status();
        let bytes = to_bytes(response.into_body(), usize::MAX).await.unwrap();
        let body = (!bytes.is_empty()).then(|| serde_json::from_slice(&bytes).unwrap());
        (status, body)
    }

    async fn create_project(&self, name: &str, key: &str) -> Value {
        let (status, body) = self
            .send(
                "POST",
                "/api/v1/projects",
                Some(json!({ "name": name })),
                Some(key),
            )
            .await;
        assert_eq!(status, StatusCode::CREATED);
        body.unwrap()
    }
}

impl Drop for TestApp {
    fn drop(&mut self) {
        for path in [
            self.path.clone(),
            self.path.with_extension("sqlite-wal"),
            self.path.with_extension("sqlite-shm"),
        ] {
            let _ = std::fs::remove_file(path);
        }
    }
}

#[tokio::test]
async fn duplicate_preserves_storyboard_content_and_reorder_persists() {
    let app = TestApp::new();
    let project = app.create_project("Film", "duplicate-project-key").await;
    let project_id = project["id"].as_str().unwrap();
    let (_, list) = app
        .send(
            "GET",
            &format!("/api/v1/projects/{project_id}/storyboards"),
            None,
            None,
        )
        .await;
    let source_id = list.unwrap()["items"][0]["id"].as_str().unwrap().to_owned();
    let script_path = format!("/api/v1/projects/{project_id}/storyboards/{source_id}/script");
    let (status, _) = app
        .send(
            "PATCH",
            &script_path,
            Some(json!({ "text": "Copy this scene", "expectedRevision": 1 })),
            None,
        )
        .await;
    assert_eq!(status, StatusCode::OK);

    let media_id = Uuid::new_v4().to_string();
    let asset_id = Uuid::new_v4().to_string();
    let section_id = Uuid::new_v4().to_string();
    let folder_id = Uuid::new_v4().to_string();
    let node_id = Uuid::new_v4().to_string();
    let db = rusqlite::Connection::open(&app.path).unwrap();
    db.execute(
        "INSERT INTO media_items
         (id, project_id, storyboard_id, kind, role, name, mime_type, source_object_key,
          status, created_at, updated_at)
         VALUES (?1, ?2, ?3, 'image', 'keyframe', 'Frame', 'image/png', 'object/frame.png',
                 'ready', '2026-01-01', '2026-01-01')",
        rusqlite::params![media_id, project_id, source_id],
    )
    .unwrap();
    db.execute(
        "INSERT INTO assets (id, project_id, kind, name, created_at, updated_at)
         VALUES (?1, ?2, 'character', 'Actor', '2026-01-01', '2026-01-01')",
        rusqlite::params![asset_id, project_id],
    )
    .unwrap();
    db.execute(
        "INSERT INTO asset_sections
         (id, project_id, storyboard_id, name, kind, position, created_at, updated_at)
         VALUES (?1, ?2, ?3, 'People', 'character', '1024', '2026-01-01', '2026-01-01')",
        rusqlite::params![section_id, project_id, source_id],
    )
    .unwrap();
    db.execute(
        "INSERT INTO asset_bindings
         (id, project_id, storyboard_id, section_id, asset_id, position, derived_media_id,
          created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, '1024', ?6, '2026-01-01', '2026-01-01')",
        rusqlite::params![
            Uuid::new_v4().to_string(),
            project_id,
            source_id,
            section_id,
            asset_id,
            media_id
        ],
    )
    .unwrap();
    db.execute(
        "INSERT INTO workspace_nodes
         (id, project_id, storyboard_id, kind, name, position, created_at, updated_at)
         VALUES (?1, ?2, ?3, 'folder', 'Shots', '1024', '2026-01-01', '2026-01-01')",
        rusqlite::params![folder_id, project_id, source_id],
    )
    .unwrap();
    db.execute(
        "INSERT INTO workspace_nodes
         (id, project_id, storyboard_id, parent_id, kind, name, object_type,
          target_type, target_id, position, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, 'object', 'Frame', 'image', 'media', ?5,
                 '1024', '2026-01-01', '2026-01-01')",
        rusqlite::params![node_id, project_id, source_id, folder_id, media_id],
    )
    .unwrap();
    drop(db);

    let duplicate_path = format!("/api/v1/projects/{project_id}/storyboards/{source_id}/duplicate");
    let (status, copied) = app
        .send("POST", &duplicate_path, None, Some("duplicate-once-key"))
        .await;
    assert_eq!(status, StatusCode::CREATED);
    let copied = copied.unwrap();
    let copied_id = copied["id"].as_str().unwrap();
    assert_ne!(copied_id, source_id);
    assert_eq!(copied["script"]["text"], "Copy this scene");
    assert_eq!(copied["counts"]["assetBindings"], 1);
    assert_eq!(copied["counts"]["keyframes"], 1);
    let (status, replay) = app
        .send("POST", &duplicate_path, None, Some("duplicate-once-key"))
        .await;
    assert_eq!(status, StatusCode::CREATED);
    assert_eq!(replay.unwrap()["id"], copied_id);

    let db = rusqlite::Connection::open(&app.path).unwrap();
    let cloned_media: String = db
        .query_row(
            "SELECT id FROM media_items WHERE storyboard_id = ?1",
            [copied_id],
            |row| row.get(0),
        )
        .unwrap();
    assert_ne!(cloned_media, media_id);
    let binding_media: String = db
        .query_row(
            "SELECT derived_media_id FROM asset_bindings WHERE storyboard_id = ?1",
            [copied_id],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(binding_media, cloned_media);
    let node_media: String = db
        .query_row(
            "SELECT target_id FROM workspace_nodes
             WHERE storyboard_id = ?1 AND kind = 'object' AND target_type = 'media'",
            [copied_id],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(node_media, cloned_media);
    drop(db);

    let reorder_path = format!("/api/v1/projects/{project_id}/storyboards/{copied_id}/reorder");
    let (status, reordered) = app
        .send(
            "POST",
            &reorder_path,
            Some(json!({ "beforeId": source_id, "afterId": null, "expectedRevision": 1 })),
            Some("reorder-copied-key"),
        )
        .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(reordered.unwrap()["index"], 0);
}

#[tokio::test]
async fn project_storyboard_and_script_routes_follow_the_contract() {
    let app = TestApp::new();
    let project = app.create_project("Film", "project-contract-key").await;
    let project_id = project["id"].as_str().unwrap();

    let (status, window) = app
        .send(
            "GET",
            &format!("/api/v1/projects/{project_id}/storyboards?before=2&after=2"),
            None,
            None,
        )
        .await;
    assert_eq!(status, StatusCode::OK);
    let window = window.unwrap();
    let storyboard_id = window["items"][0]["id"].as_str().unwrap();
    assert_eq!(window["items"][0]["index"], 0);
    assert_eq!(window["page"]["total"], 1);

    let (status, renamed) = app
        .send(
            "PATCH",
            &format!("/api/v1/projects/{project_id}/storyboards/{storyboard_id}"),
            Some(json!({ "name": "Opening", "expectedRevision": 1 })),
            None,
        )
        .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(renamed.unwrap()["revision"], 2);

    let (status, conflict) = app
        .send(
            "PATCH",
            &format!("/api/v1/projects/{project_id}/storyboards/{storyboard_id}"),
            Some(json!({ "name": "Stale", "expectedRevision": 1 })),
            None,
        )
        .await;
    assert_eq!(status, StatusCode::CONFLICT);
    let error = &conflict.unwrap()["error"];
    assert_eq!(error["code"], "REVISION_CONFLICT");
    assert_eq!(error["details"]["expectedRevision"], 1);
    assert_eq!(error["details"]["actualRevision"], 2);

    let (status, script) = app
        .send(
            "PATCH",
            &format!("/api/v1/projects/{project_id}/storyboards/{storyboard_id}/script"),
            Some(json!({ "text": "Scene one", "expectedRevision": 1 })),
            None,
        )
        .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(script.unwrap()["revision"], 2);
}

#[tokio::test]
async fn idempotency_and_project_scope_are_enforced_at_http_boundary() {
    let app = TestApp::new();
    let first = app.create_project("Film", "same-project-key").await;
    let replay = app.create_project("Film", "same-project-key").await;
    assert_eq!(first["id"], replay["id"]);

    let other = app.create_project("Other", "other-project-key").await;
    let first_project_id = first["id"].as_str().unwrap();
    let other_project_id = other["id"].as_str().unwrap();
    let (_, window) = app
        .send(
            "GET",
            &format!("/api/v1/projects/{first_project_id}/storyboards"),
            None,
            None,
        )
        .await;
    let storyboard_id = window.unwrap()["items"][0]["id"]
        .as_str()
        .unwrap()
        .to_owned();

    let (status, body) = app
        .send(
            "GET",
            &format!("/api/v1/projects/{other_project_id}/storyboards/{storyboard_id}"),
            None,
            None,
        )
        .await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    assert_eq!(body.unwrap()["error"]["code"], "RESOURCE_NOT_FOUND");
}

#[tokio::test]
async fn malformed_requests_use_the_error_envelope() {
    let app = TestApp::new();
    let (status, body) = app
        .send(
            "POST",
            "/api/v1/projects",
            Some(json!({ "name": "Film" })),
            None,
        )
        .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    let error = &body.unwrap()["error"];
    assert_eq!(error["code"], "INVALID_REQUEST");
    assert!(error["requestId"].as_str().unwrap().starts_with("req_"));
}
