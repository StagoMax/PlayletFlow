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

#[tokio::test]
async fn rename_copy_and_delete_folder_persist_with_independent_media() {
    let fixture = TestDatabase::new();
    let router = fixture.router();
    let uri = fixture.collection_uri();
    let folder = send_json(
        &router,
        Method::POST,
        &uri,
        Some("test-folder"),
        json!({ "parentId": null, "kind": "folder", "name": "角色" }),
        StatusCode::CREATED,
    )
    .await;
    let folder_id = folder["id"].as_str().unwrap();
    let image = send_json(
        &router,
        Method::POST,
        &uri,
        Some("test-image"),
        json!({ "parentId": folder_id, "kind": "object", "name": "面部", "objectType": "image" }),
        StatusCode::CREATED,
    )
    .await;
    let image_id = image["id"].as_str().unwrap();
    let renamed = send_json(
        &router,
        Method::PATCH,
        &format!("{uri}/{image_id}"),
        None,
        json!({ "parentId": folder_id, "name": "正面照", "expectedRevision": 1 }),
        StatusCode::OK,
    )
    .await;
    assert_eq!(renamed["name"], "正面照");
    send_json(
        &router,
        Method::POST,
        &format!("{uri}/{image_id}/media"),
        None,
        Value::Null,
        StatusCode::OK,
    )
    .await;

    let copied = send_json(
        &router,
        Method::POST,
        &format!("{uri}/{folder_id}/copies"),
        Some("copy-folder"),
        Value::Null,
        StatusCode::CREATED,
    )
    .await;
    let copy_id = copied["id"].as_str().unwrap();
    assert_eq!(copied["name"], "角色 副本");
    let listed = send_json(
        &router,
        Method::GET,
        &uri,
        None,
        Value::Null,
        StatusCode::OK,
    )
    .await;
    let copied_image = listed
        .as_array()
        .unwrap()
        .iter()
        .find(|node| node["parentId"] == copy_id)
        .unwrap();
    assert_eq!(copied_image["name"], "正面照");
    assert_eq!(copied_image["targetId"], copied_image["id"]);
    assert_ne!(copied_image["id"], image["id"]);
    let replayed = send_json(
        &router,
        Method::POST,
        &format!("{uri}/{folder_id}/copies"),
        Some("copy-folder"),
        Value::Null,
        StatusCode::CREATED,
    )
    .await;
    assert_eq!(replayed["id"], copied["id"]);

    let stale = router
        .clone()
        .oneshot(
            Request::builder()
                .method(Method::DELETE)
                .uri(format!("{uri}/{image_id}?expectedRevision=1"))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(stale.status(), StatusCode::CONFLICT);
    let deleted = router
        .clone()
        .oneshot(
            Request::builder()
                .method(Method::DELETE)
                .uri(format!("{uri}/{folder_id}?expectedRevision=1"))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(deleted.status(), StatusCode::NO_CONTENT);
    let listed = send_json(
        &router,
        Method::GET,
        &uri,
        None,
        Value::Null,
        StatusCode::OK,
    )
    .await;
    assert_eq!(listed.as_array().unwrap().len(), 2);
    let connection = fixture.database.connect().unwrap();
    let deleted_at: Option<String> = connection
        .query_row(
            "SELECT deleted_at FROM media_items WHERE id = ?1",
            [image_id],
            |row| row.get(0),
        )
        .unwrap();
    assert!(deleted_at.is_some());
    let copy_media: Option<String> = connection
        .query_row(
            "SELECT deleted_at FROM media_items WHERE id = ?1",
            [copied_image["id"].as_str().unwrap()],
            |row| row.get(0),
        )
        .unwrap();
    assert!(copy_media.is_none());
}

#[tokio::test]
async fn script_node_and_its_folder_cannot_be_deleted_or_copied() {
    let fixture = TestDatabase::new();
    let uri = fixture.collection_uri();
    let folder_id = uuid::Uuid::new_v4().to_string();
    let script_id = uuid::Uuid::new_v4().to_string();
    let now = Utc::now().to_rfc3339();
    let connection = fixture.database.connect().unwrap();
    connection.execute(
        "INSERT INTO workspace_nodes (id, project_id, storyboard_id, kind, name, position, revision, created_at, updated_at)
         VALUES (?1, ?2, ?3, 'folder', '脚本', '00000000001000000000', 1, ?4, ?4)",
        rusqlite::params![folder_id, fixture.project_id.to_string(), fixture.storyboard_id.to_string(), now],
    ).unwrap();
    connection.execute(
        "INSERT INTO workspace_nodes (id, project_id, storyboard_id, parent_id, kind, name, object_type,
          target_type, target_id, position, revision, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, 'object', '该片段的脚本', 'text', 'script', ?3,
                 '00000000002000000000', 1, ?5, ?5)",
        rusqlite::params![script_id, fixture.project_id.to_string(), fixture.storyboard_id.to_string(), folder_id, now],
    ).unwrap();
    drop(connection);
    let router = fixture.router();
    for node_id in [&folder_id, &script_id] {
        for method in [Method::DELETE, Method::POST] {
            let path = if method == Method::DELETE {
                format!("{uri}/{node_id}?expectedRevision=1")
            } else {
                format!("{uri}/{node_id}/copies")
            };
            let mut request = Request::builder().method(method).uri(path);
            if node_id == &folder_id {
                request = request.header("Idempotency-Key", "copy-script-folder");
            } else {
                request = request.header("Idempotency-Key", "copy-script-object");
            }
            let response = router
                .clone()
                .oneshot(request.body(Body::empty()).unwrap())
                .await
                .unwrap();
            assert_eq!(response.status(), StatusCode::CONFLICT);
        }
    }
    let nodes = send_json(
        &router,
        Method::GET,
        &uri,
        None,
        Value::Null,
        StatusCode::OK,
    )
    .await;
    assert_eq!(nodes.as_array().unwrap().len(), 2);
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
    assert_eq!(response.status(), expected_status, "{uri}");
    let bytes = to_bytes(response.into_body(), usize::MAX).await.unwrap();
    serde_json::from_slice(&bytes).unwrap()
}
