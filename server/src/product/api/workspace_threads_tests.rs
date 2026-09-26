use super::*;
use crate::product::application::workspace_threads::RuntimeThreadGateway;
use crate::product::domain::{ProductResult, WorkspaceThreadBinding};
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
    assert!(context.contains("bindingId"));
    assert!(context.contains("50000000-0000-4000-8000-000000000012"));
    assert!(context.contains("生成版本 03"));
    assert!(!context.contains("雾港建立镜头"));
}
