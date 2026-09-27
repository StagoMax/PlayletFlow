use super::*;
use crate::product::application::workspace_threads::RuntimeThreadGateway;
use crate::product::domain::{ProductError, ProductResult, WorkspaceThreadBinding};
use crate::product::infrastructure::sqlite::{
    demo_storyboard_id, seed_demo_workspace, ProductDatabase, SqliteWorkspaceThreadStore,
    DEMO_PROJECT_ID,
};
use async_trait::async_trait;
use axum::body::{to_bytes, Body};
use axum::http::Request;
use serde_json::Value;
use std::path::PathBuf;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use tower::ServiceExt;

#[derive(Default)]
struct MockRuntime(AtomicUsize);

#[async_trait]
impl RuntimeThreadGateway for MockRuntime {
    async fn create_thread(&self, _title: String) -> ProductResult<Uuid> {
        let number = self.0.fetch_add(1, Ordering::SeqCst) + 1;
        Ok(Uuid::from_u128(number as u128))
    }

    async fn delete_thread(&self, _thread_id: Uuid) -> ProductResult<()> {
        Ok(())
    }
}

struct TestApp {
    path: PathBuf,
    router: Router,
    service: WorkspaceThreadService,
    runtime: Arc<MockRuntime>,
}

impl TestApp {
    fn new() -> Self {
        let path = std::env::temp_dir().join(format!(
            "videoflow-workspace-thread-api-{}.sqlite",
            Uuid::new_v4()
        ));
        let database = ProductDatabase::open(&path).expect("open product test database");
        seed_demo_workspace(&database).expect("seed demo workspace");
        let runtime = Arc::new(MockRuntime::default());
        let service = WorkspaceThreadService::new(
            Arc::new(SqliteWorkspaceThreadStore::new(database)),
            runtime.clone(),
        );
        Self {
            path,
            router: router(service.clone()),
            service,
            runtime,
        }
    }

    async fn send(
        &self,
        method: &str,
        uri: &str,
        idempotency_key: Option<&str>,
    ) -> (StatusCode, Option<Value>) {
        let mut builder = Request::builder().method(method).uri(uri);
        if let Some(key) = idempotency_key {
            builder = builder.header("Idempotency-Key", key);
        }
        let response = self
            .router
            .clone()
            .oneshot(builder.body(Body::empty()).unwrap())
            .await
            .unwrap();
        let status = response.status();
        let bytes = to_bytes(response.into_body(), usize::MAX).await.unwrap();
        let body = (!bytes.is_empty()).then(|| serde_json::from_slice(&bytes).unwrap());
        (status, body)
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

fn route(storyboard_index: usize) -> String {
    format!(
        "/api/v1/projects/{}/storyboards/{}/ai-thread",
        DEMO_PROJECT_ID,
        demo_storyboard_id(storyboard_index)
    )
}

fn list_route(storyboard_index: usize) -> String {
    format!(
        "/api/v1/projects/{}/storyboards/{}/ai-threads",
        DEMO_PROJECT_ID,
        demo_storyboard_id(storyboard_index)
    )
}

#[tokio::test]
async fn create_is_idempotent_and_get_restores_latest_binding() {
    let app = TestApp::new();
    let uri = route(12);
    let (status, first) = app
        .send("POST", &uri, Some("workspace-thread-key-12"))
        .await;
    assert_eq!(status, StatusCode::CREATED);
    let first = first.unwrap();

    let (status, replay) = app
        .send("POST", &uri, Some("workspace-thread-key-12"))
        .await;
    assert_eq!(status, StatusCode::CREATED);
    assert_eq!(replay.unwrap(), first);
    assert_eq!(app.runtime.0.load(Ordering::SeqCst), 1);

    let (status, restored) = app.send("GET", &uri, None).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(restored.unwrap(), first);
}

#[tokio::test]
async fn list_returns_all_bindings_with_the_latest_first() {
    let app = TestApp::new();
    let uri = route(12);
    let (_, first) = app.send("POST", &uri, Some("first-thread")).await;
    let (_, second) = app.send("POST", &uri, Some("second-thread")).await;

    let (status, body) = app.send("GET", &list_route(12), None).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        body.unwrap(),
        serde_json::json!([second.unwrap(), first.unwrap()])
    );
}

#[tokio::test]
async fn delete_removes_only_the_scoped_binding_and_latest_falls_back() {
    let app = TestApp::new();
    let uri = route(12);
    let (_, first) = app.send("POST", &uri, Some("delete-first")).await;
    let (_, second) = app.send("POST", &uri, Some("delete-second")).await;
    let first = first.unwrap();
    let second = second.unwrap();
    let delete_uri = format!(
        "{}/{}",
        list_route(12),
        second["threadId"].as_str().unwrap()
    );

    let (status, _) = app.send("DELETE", &delete_uri, None).await;
    assert_eq!(status, StatusCode::NO_CONTENT);
    let (_, latest) = app.send("GET", &uri, None).await;
    assert_eq!(latest.unwrap(), first);
    let (_, listed) = app.send("GET", &list_route(12), None).await;
    assert_eq!(listed.unwrap(), serde_json::json!([first]));
    let (status, _) = app.send("DELETE", &delete_uri, None).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn delete_rejects_a_thread_bound_to_another_storyboard() {
    let app = TestApp::new();
    let (_, binding) = app.send("POST", &route(12), Some("other-scope")).await;
    let binding = binding.unwrap();
    let uri = format!(
        "{}/{}",
        list_route(11),
        binding["threadId"].as_str().unwrap()
    );
    let (status, _) = app.send("DELETE", &uri, None).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    let (_, listed) = app.send("GET", &list_route(12), None).await;
    assert_eq!(listed.unwrap(), serde_json::json!([binding]));
}

#[tokio::test]
async fn invalid_scope_is_rejected_before_runtime_creation() {
    let app = TestApp::new();
    let uri = format!(
        "/api/v1/projects/{}/storyboards/{}/ai-thread",
        Uuid::new_v4(),
        demo_storyboard_id(1)
    );
    let (status, body) = app
        .send("POST", &uri, Some("invalid-workspace-thread-key"))
        .await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    assert_eq!(body.unwrap()["error"]["code"], "RESOURCE_NOT_FOUND");
    assert_eq!(app.runtime.0.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn model_context_is_derived_from_the_bound_storyboard_only() {
    let app = TestApp::new();
    let (_, body) = app
        .send("POST", &route(12), Some("trusted-context-thread-key"))
        .await;
    let binding: WorkspaceThreadBinding = serde_json::from_value(body.unwrap()).unwrap();
    let context = app
        .service
        .model_context(binding.thread_id)
        .await
        .unwrap()
        .unwrap();
    assert!(context.contains("桥下短暂对峙"));
    assert!(context.contains("林舟"));
    let decoded: Value = serde_json::from_str(&context).unwrap();
    assert!(decoded["folders"].as_array().unwrap().iter().any(|folder| {
        folder["id"] == format!("folder-assets-{}", demo_storyboard_id(12))
            && folder["parentId"].is_null()
    }));
    assert!(context.contains("bindingId"));
    assert!(context.contains("50000000-0000-4000-8000-000000000012"));
    assert!(context.contains("生成版本 03"));
    assert!(!context.contains("雾港建立镜头"));
}

#[tokio::test]
async fn references_resolve_to_canonical_resources_inside_the_bound_storyboard() {
    let app = TestApp::new();
    let (_, body) = app
        .send("POST", &route(12), Some("reference-resolution-thread-key"))
        .await;
    let binding: WorkspaceThreadBinding = serde_json::from_value(body.unwrap()).unwrap();
    let script_id = format!("script-{}", demo_storyboard_id(12));
    let references = app
        .service
        .resolve_references(
            binding.thread_id,
            &[script_id.clone(), "video-draft-12".into()],
        )
        .await
        .unwrap();

    assert_eq!(references.len(), 2);
    assert_eq!(references[0].id, script_id);
    assert_eq!(references[0].name, "片段脚本");
    assert_eq!(references[0].kind, "text");
    assert_eq!(references[1].id, "video-draft-12");
    assert_eq!(references[1].name, "生成版本 03");
    assert_eq!(references[1].kind, "video");

    let outside_scope = app
        .service
        .resolve_references(binding.thread_id, &["video-draft-11".into()])
        .await;
    assert!(matches!(outside_scope, Err(ProductError::NotFound)));
}
