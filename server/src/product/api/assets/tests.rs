use crate::product::api;
use crate::product::domain::{ProjectId, StoryboardId};
use crate::product::ProductDatabase;
use axum::body::{to_bytes, Body};
use axum::http::{Method, Request, StatusCode};
use chrono::Utc;
use serde_json::{json, Value};
use std::path::PathBuf;
use tower::ServiceExt;

struct TestDatabase {
    database: ProductDatabase,
    path: PathBuf,
    project_id: ProjectId,
    source_id: StoryboardId,
    target_id: StoryboardId,
}

impl TestDatabase {
    fn new() -> Self {
        let path =
            std::env::temp_dir().join(format!("videoflow-assets-{}.sqlite", uuid::Uuid::new_v4()));
        let database = ProductDatabase::open(&path).unwrap();
        let project_id = ProjectId::new();
        let source_id = StoryboardId::new();
        let target_id = StoryboardId::new();
        let now = Utc::now().to_rfc3339();
        let connection = database.connect().unwrap();
        connection
            .execute(
                "INSERT INTO projects (id, name, revision, created_at, updated_at)
                 VALUES (?1, 'Film', 1, ?2, ?2)",
                rusqlite::params![project_id.to_string(), now],
            )
            .unwrap();
        for (id, name, position) in [
            (source_id, "Source", "00000000001000000000"),
            (target_id, "Target", "00000000002000000000"),
        ] {
            connection
                .execute(
                    "INSERT INTO storyboards
                     (id, project_id, name, position, revision, created_at, updated_at, deleted_at)
                     VALUES (?1, ?2, ?3, ?4, 1, ?5, ?5, NULL)",
                    rusqlite::params![id.to_string(), project_id.to_string(), name, position, now],
                )
                .unwrap();
        }
        drop(connection);
        Self {
            database,
            path,
            project_id,
            source_id,
            target_id,
        }
    }

    fn router(&self) -> axum::Router {
        api::router(self.database.clone())
    }
}

impl Drop for TestDatabase {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.path);
        let mut shm = self.path.as_os_str().to_owned();
        shm.push("-shm");
        let _ = std::fs::remove_file(PathBuf::from(shm));
        let mut wal = self.path.as_os_str().to_owned();
        wal.push("-wal");
        let _ = std::fs::remove_file(PathBuf::from(wal));
    }
}

#[tokio::test]
async fn copies_references_without_duplicating_assets_and_replays_idempotently() {
    let fixture = TestDatabase::new();
    let router = fixture.router();
    let section_uri = format!(
        "/api/v1/projects/{}/storyboards/{}/asset-sections",
        fixture.project_id, fixture.source_id
    );
    let section_body = json!({ "parentId": null, "name": "人物", "kind": "character" });
    let section = send_json(
        &router,
        Method::POST,
        &section_uri,
        Some("section-source"),
        section_body.clone(),
        StatusCode::CREATED,
    )
    .await;
    let section_replay = send_json(
        &router,
        Method::POST,
        &section_uri,
        Some("section-source"),
        section_body,
        StatusCode::CREATED,
    )
    .await;
    assert_eq!(section["id"], section_replay["id"]);

    let asset = send_json(
        &router,
        Method::POST,
        &format!("/api/v1/projects/{}/assets", fixture.project_id),
        Some("asset-hero"),
        json!({
            "type": "character",
            "name": "女主角",
            "description": null,
            "canonicalPrompt": "cinematic character reference"
        }),
        StatusCode::CREATED,
    )
    .await;
    let bindings = send_json(
        &router,
        Method::POST,
        &format!(
            "/api/v1/projects/{}/storyboards/{}/asset-bindings",
            fixture.project_id, fixture.source_id
        ),
        Some("bind-hero"),
        json!({ "sectionId": section["id"], "assetIds": [asset["id"]] }),
        StatusCode::CREATED,
    )
    .await;
    let copy_body = json!({
        "targetStoryboardId": fixture.target_id,
        "bindingIds": [bindings[0]["id"]],
        "includeSectionStructure": true,
        "targetSectionId": null,
        "includePromptOverrides": false,
        "onDuplicate": "skip"
    });
    let copy_uri = format!(
        "/api/v1/projects/{}/storyboards/{}/asset-bindings:copy",
        fixture.project_id, fixture.source_id
    );
    let first_copy = send_json(
        &router,
        Method::POST,
        &copy_uri,
        Some("copy-hero"),
        copy_body.clone(),
        StatusCode::OK,
    )
    .await;
    let replay = send_json(
        &router,
        Method::POST,
        &copy_uri,
        Some("copy-hero"),
        copy_body,
        StatusCode::OK,
    )
    .await;
    assert_eq!(first_copy, replay);
    assert_eq!(first_copy["createdBindingIds"].as_array().unwrap().len(), 1);

    let assets = send_json(
        &router,
        Method::GET,
        &format!("/api/v1/projects/{}/assets", fixture.project_id),
        None,
        Value::Null,
        StatusCode::OK,
    )
    .await;
    assert_eq!(assets["page"]["total"], 1);
    assert_eq!(assets["items"][0]["referenceCount"], 2);

    let response = router
        .clone()
        .oneshot(
            Request::builder()
                .method(Method::DELETE)
                .uri(format!(
                    "/api/v1/projects/{}/assets/{}?expectedRevision=1",
                    fixture.project_id,
                    asset["id"].as_str().unwrap()
                ))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::CONFLICT);
    let error = response_json(response).await;
    assert_eq!(error["error"]["code"], "ASSET_IN_USE");
}

#[tokio::test]
async fn creates_storyboard_and_reuses_assets_atomically() {
    let fixture = TestDatabase::new();
    let router = fixture.router();
    let section = send_json(
        &router,
        Method::POST,
        &format!(
            "/api/v1/projects/{}/storyboards/{}/asset-sections",
            fixture.project_id, fixture.source_id
        ),
        Some("create-reuse-section"),
        json!({ "parentId": null, "name": "人物", "kind": "character" }),
        StatusCode::CREATED,
    )
    .await;
    let asset = send_json(
        &router,
        Method::POST,
        &format!("/api/v1/projects/{}/assets", fixture.project_id),
        Some("create-reuse-asset"),
        json!({
            "type": "character",
            "name": "女主角",
            "description": null,
            "canonicalPrompt": "cinematic character reference"
        }),
        StatusCode::CREATED,
    )
    .await;
    let bindings = send_json(
        &router,
        Method::POST,
        &format!(
            "/api/v1/projects/{}/storyboards/{}/asset-bindings",
            fixture.project_id, fixture.source_id
        ),
        Some("create-reuse-binding"),
        json!({ "sectionId": section["id"], "assetIds": [asset["id"]] }),
        StatusCode::CREATED,
    )
    .await;
    let body = json!({
        "name": "Created with assets",
        "insertAfterId": fixture.source_id,
        "reuseAssetsFrom": {
            "storyboardId": fixture.source_id,
            "bindingIds": [bindings[0]["id"]],
            "includePromptOverrides": false
        }
    });
    let uri = format!("/api/v1/projects/{}/storyboards", fixture.project_id);
    let created = send_json(
        &router,
        Method::POST,
        &uri,
        Some("create-with-reuse"),
        body.clone(),
        StatusCode::CREATED,
    )
    .await;
    let replay = send_json(
        &router,
        Method::POST,
        &uri,
        Some("create-with-reuse"),
        body,
        StatusCode::CREATED,
    )
    .await;
    assert_eq!(created, replay);
    assert_eq!(created["assetCopy"]["created"], 1);
    assert_eq!(created["storyboard"]["counts"]["assetBindings"], 1);

    let target_id = created["storyboard"]["id"].as_str().unwrap();
    let copied = send_json(
        &router,
        Method::GET,
        &format!(
            "/api/v1/projects/{}/storyboards/{target_id}/asset-bindings",
            fixture.project_id
        ),
        None,
        Value::Null,
        StatusCode::OK,
    )
    .await;
    assert_eq!(copied.as_array().unwrap().len(), 1);
    assert_eq!(copied[0]["assetId"], asset["id"]);
}

async fn send_json(
    router: &axum::Router,
    method: Method,
    uri: &str,
    idempotency_key: Option<&str>,
    body: Value,
    expected_status: StatusCode,
) -> Value {
    let mut builder = Request::builder().method(method).uri(uri);
    if body != Value::Null {
        builder = builder.header("content-type", "application/json");
    }
    if let Some(key) = idempotency_key {
        builder = builder.header("Idempotency-Key", key);
    }
    let response = router
        .clone()
        .oneshot(
            builder
                .body(if body == Value::Null {
                    Body::empty()
                } else {
                    Body::from(body.to_string())
                })
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), expected_status);
    response_json(response).await
}

async fn response_json(response: axum::response::Response) -> Value {
    let bytes = to_bytes(response.into_body(), usize::MAX).await.unwrap();
    serde_json::from_slice(&bytes).unwrap()
}
