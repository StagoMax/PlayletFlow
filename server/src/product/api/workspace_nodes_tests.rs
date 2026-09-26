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
    storyboard_id: StoryboardId,
}

impl TestDatabase {
    fn new() -> Self {
        let path = std::env::temp_dir().join(format!(
            "videoflow-workspace-nodes-{}.sqlite",
            uuid::Uuid::new_v4()
        ));
        let database = ProductDatabase::open(&path).expect("open product database");
        let project_id = ProjectId::new();
        let storyboard_id = StoryboardId::new();
        let now = Utc::now().to_rfc3339();
        let connection = database.connect().unwrap();
        connection
            .execute(
                "INSERT INTO projects (id, name, revision, created_at, updated_at)
                 VALUES (?1, 'Film', 1, ?2, ?2)",
                rusqlite::params![project_id.to_string(), now],
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO storyboards
                 (id, project_id, name, position, revision, created_at, updated_at, deleted_at)
                 VALUES (?1, ?2, 'Scene', '00000000001000000000', 1, ?3, ?3, NULL)",
                rusqlite::params![storyboard_id.to_string(), project_id.to_string(), now],
            )
            .unwrap();
        drop(connection);
        Self {
            database,
            path,
            project_id,
            storyboard_id,
        }
    }

    fn router(&self) -> axum::Router {
        api::router(self.database.clone())
    }

    fn collection_uri(&self) -> String {
        format!(
            "/api/v1/projects/{}/storyboards/{}/workspace-nodes",
            self.project_id, self.storyboard_id
        )
    }
}

impl Drop for TestDatabase {
    fn drop(&mut self) {
        for suffix in ["", "-shm", "-wal"] {
            let _ = std::fs::remove_file(format!("{}{}", self.path.display(), suffix));
        }
    }
}

#[tokio::test]
async fn persists_arbitrarily_deep_folders_and_rejects_cycles() {
    let fixture = TestDatabase::new();
    let router = fixture.router();
    let uri = fixture.collection_uri();
    let mut parent_id: Option<String> = None;
    let mut root: Option<Value> = None;

    for depth in 1..=4 {
        let node = send_json(
            &router,
            Method::POST,
            &uri,
            Some(&format!("folder-depth-{depth}")),
            json!({
                "parentId": parent_id.clone(),
                "kind": "folder",
                "name": format!("第 {depth} 层")
            }),
            StatusCode::CREATED,
        )
        .await;
        if depth == 1 {
            root = Some(node.clone());
        }
        parent_id = Some(node["id"].as_str().unwrap().to_owned());
    }

    let object = send_json(
        &router,
        Method::POST,
        &uri,
        Some("nested-text-object"),
        json!({
            "parentId": parent_id.clone(),
            "kind": "object",
            "name": "拍摄说明",
            "objectType": "text"
        }),
        StatusCode::CREATED,
    )
    .await;
    assert_eq!(object["targetType"], "empty");
    assert_eq!(object["objectType"], "text");

    let listed = send_json(
        &router,
        Method::GET,
        &uri,
        None,
        Value::Null,
        StatusCode::OK,
    )
    .await;
    assert_eq!(listed.as_array().unwrap().len(), 5);

    let root = root.unwrap();
    let cycle = send_json(
        &router,
        Method::PATCH,
        &format!("{uri}/{}", root["id"].as_str().unwrap()),
        None,
        json!({
            "parentId": parent_id,
            "name": root["name"],
            "expectedRevision": root["revision"]
        }),
        StatusCode::CONFLICT,
    )
    .await;
    assert_eq!(cycle["error"]["code"], "WORKSPACE_NODE_CYCLE");
}

async fn send_json(
    router: &axum::Router,
    method: Method,
    uri: &str,
    idempotency_key: Option<&str>,
    body: Value,
    expected_status: StatusCode,
) -> Value {
    let mut builder = Request::builder().method(method.clone()).uri(uri);
    if let Some(key) = idempotency_key {
        builder = builder.header("Idempotency-Key", key);
    }
    let request = if method == Method::GET {
        builder.body(Body::empty()).unwrap()
    } else {
        builder
            .header("content-type", "application/json")
            .body(Body::from(body.to_string()))
            .unwrap()
    };
    let response = router.clone().oneshot(request).await.unwrap();
    assert_eq!(response.status(), expected_status);
    let bytes = to_bytes(response.into_body(), usize::MAX).await.unwrap();
    serde_json::from_slice(&bytes).unwrap()
}
