use crate::product::api;
use crate::product::application::workspace_nodes::{
    SaveWorkspaceObjectPromptInput, WorkspaceNodeService,
};
use crate::product::domain::{ProjectId, StoryboardId};
use crate::product::infrastructure::sqlite::SqliteWorkspaceNodeRepository;
use crate::product::ProductDatabase;
use axum::body::{to_bytes, Body};
use axum::http::{Method, Request, StatusCode};
use chrono::Utc;
use serde_json::{json, Value};
use std::path::PathBuf;
use std::sync::Arc;
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
async fn viewing_ai_content_clears_only_the_update_that_was_displayed() {
    let fixture = TestDatabase::new();
    let router = fixture.router();
    let uri = fixture.collection_uri();
    let object = send_json(
        &router,
        Method::POST,
        &uri,
        Some("viewed-video"),
        json!({ "parentId": null, "kind": "object", "name": "视频提示词", "objectType": "video" }),
        StatusCode::CREATED,
    )
    .await;
    let object_id = object["id"].as_str().unwrap();
    let unseen_update = "2026-09-27T09:00:00Z";
    fixture
        .database
        .connect()
        .unwrap()
        .execute(
            "UPDATE workspace_nodes SET unseen_update_at = ?1 WHERE id = ?2",
            rusqlite::params![unseen_update, object_id],
        )
        .unwrap();

    let listed = send_json(
        &router,
        Method::GET,
        &uri,
        None,
        Value::Null,
        StatusCode::OK,
    )
    .await;
    assert_eq!(
        listed
            .as_array()
            .unwrap()
            .iter()
            .find(|node| node["id"] == object_id)
            .unwrap()["unseenUpdateAt"],
        unseen_update
    );

    let stale_view = send_json(
        &router,
        Method::PUT,
        &format!("{uri}/{object_id}/viewed"),
        None,
        json!({ "seenThrough": "2026-09-27T08:59:59Z" }),
        StatusCode::OK,
    )
    .await;
    assert_eq!(stale_view["unseenUpdateAt"], unseen_update);

    let viewed = send_json(
        &router,
        Method::PUT,
        &format!("{uri}/{object_id}/viewed"),
        None,
        json!({ "seenThrough": unseen_update }),
        StatusCode::OK,
    )
    .await;
    assert_eq!(viewed["unseenUpdateAt"], Value::Null);

    let replayed = send_json(
        &router,
        Method::PUT,
        &format!("{uri}/{object_id}/viewed"),
        None,
        json!({ "seenThrough": unseen_update }),
        StatusCode::OK,
    )
    .await;
    assert_eq!(replayed["unseenUpdateAt"], Value::Null);
}

#[tokio::test]
async fn ctrl_z_endpoint_restores_the_previous_agent_prompt() {
    let fixture = TestDatabase::new();
    let router = fixture.router();
    let uri = fixture.collection_uri();
    let object = send_json(
        &router,
        Method::POST,
        &uri,
        Some("prompt-history-video"),
        json!({ "parentId": null, "kind": "object", "name": "镜头", "objectType": "video" }),
        StatusCode::CREATED,
    )
    .await;
    let object_id = object["id"].as_str().unwrap();
    send_json(
        &router,
        Method::POST,
        &format!("{uri}/{object_id}/media"),
        None,
        Value::Null,
        StatusCode::OK,
    )
    .await;
    fixture
        .database
        .connect()
        .unwrap()
        .execute(
            "UPDATE media_items SET prompt = '旧提示词' WHERE id = ?1",
            [object_id],
        )
        .unwrap();
    let service = WorkspaceNodeService::new(Arc::new(SqliteWorkspaceNodeRepository::new(
        fixture.database.clone(),
    )));
    service
        .save_object_prompt(
            SaveWorkspaceObjectPromptInput {
                project_id: fixture.project_id,
                storyboard_id: fixture.storyboard_id,
                target_id: object_id.to_owned(),
                prompt: "Agent 最新提示词".into(),
                expected_revision: 1,
            },
            "agent-save".into(),
        )
        .await
        .unwrap();

    let restored = send_json(
        &router,
        Method::POST,
        &format!("{uri}/{object_id}/prompt/undo"),
        Some("ctrl-z-prompt"),
        json!({ "expectedRevision": 2 }),
        StatusCode::OK,
    )
    .await;
    assert_eq!(restored["prompt"], "旧提示词");
    assert_eq!(restored["revision"], 3);
    assert_eq!(
        fixture
            .database
            .connect()
            .unwrap()
            .query_row(
                "SELECT prompt FROM media_items WHERE id = ?1",
                [object_id],
                |row| row.get::<_, String>(0),
            )
            .unwrap(),
        "旧提示词"
    );
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

#[tokio::test]
async fn reorder_nodes_persists_cross_folder_order_and_rejects_cycles() {
    let fixture = TestDatabase::new();
    let router = fixture.router();
    let uri = fixture.collection_uri();
    let mut roots = Vec::new();
    for (index, name) in ["资产", "脚本", "视频"].iter().enumerate() {
        roots.push(
            send_json(
                &router,
                Method::POST,
                &uri,
                Some(&format!("reorder-root-{index}")),
                json!({ "parentId": null, "kind": "folder", "name": name }),
                StatusCode::CREATED,
            )
            .await,
        );
    }
    let first = roots[0]["id"].as_str().unwrap();
    let last = roots[2]["id"].as_str().unwrap();
    let changed = send_json(
        &router,
        Method::PATCH,
        &format!("{uri}/{last}/order"),
        None,
        json!({ "beforeId": first, "afterId": null, "expectedRevision": 1 }),
        StatusCode::OK,
    )
    .await;
    assert_eq!(changed["revision"], 2);
    let listed = send_json(
        &router,
        Method::GET,
        &uri,
        None,
        Value::Null,
        StatusCode::OK,
    )
    .await;
    let names: Vec<_> = listed
        .as_array()
        .unwrap()
        .iter()
        .map(|node| node["name"].as_str().unwrap())
        .collect();
    assert_eq!(names, ["视频", "资产", "脚本"]);

    let child = send_json(
        &router,
        Method::POST,
        &uri,
        Some("reorder-child"),
        json!({ "parentId": first, "kind": "object", "name": "封面", "objectType": "image" }),
        StatusCode::CREATED,
    )
    .await;
    let moved = send_json(
        &router,
        Method::PATCH,
        &format!("{uri}/{last}/order"),
        None,
        json!({ "beforeId": child["id"], "afterId": null, "expectedRevision": 2 }),
        StatusCode::OK,
    )
    .await;
    assert_eq!(moved["parentId"], first);
    let listed = send_json(
        &router,
        Method::GET,
        &uri,
        None,
        Value::Null,
        StatusCode::OK,
    )
    .await;
    let child_order: Vec<_> = listed
        .as_array()
        .unwrap()
        .iter()
        .filter(|node| node["parentId"] == first)
        .map(|node| node["name"].as_str().unwrap())
        .collect();
    assert_eq!(child_order, ["视频", "封面"]);

    let descendant = send_json(
        &router,
        Method::POST,
        &uri,
        Some("reorder-descendant"),
        json!({ "parentId": last, "kind": "folder", "name": "子目录" }),
        StatusCode::CREATED,
    )
    .await;
    let invalid = send_json(
        &router,
        Method::PATCH,
        &format!("{uri}/{last}/order"),
        None,
        json!({ "beforeId": descendant["id"], "afterId": null, "expectedRevision": 3 }),
        StatusCode::CONFLICT,
    )
    .await;
    assert_eq!(invalid["error"]["code"], "WORKSPACE_NODE_CYCLE");
    let stale = send_json(
        &router,
        Method::PATCH,
        &format!("{uri}/{last}/order"),
        None,
        json!({ "beforeId": null, "afterId": first, "expectedRevision": 1 }),
        StatusCode::CONFLICT,
    )
    .await;
    assert_eq!(stale["error"]["code"], "REVISION_CONFLICT");
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
    let status = response.status();
    let bytes = to_bytes(response.into_body(), usize::MAX).await.unwrap();
    assert_eq!(
        status,
        expected_status,
        "{uri}: {}",
        String::from_utf8_lossy(&bytes)
    );
    serde_json::from_slice(&bytes).unwrap()
}
