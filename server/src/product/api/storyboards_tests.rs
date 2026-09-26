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
