use super::*;
use crate::product::application::generation::resolve_generation_spec;
use crate::product::domain::{GenerationJobId, MediaKind, ProjectId, ProposalId, StoryboardId};
use crate::product::infrastructure::sqlite::ProductDatabase;
use axum::body::{to_bytes, Body};
use axum::http::Request;
use rusqlite::params;
use serde_json::Value;
use std::path::PathBuf;
use tower::ServiceExt;

struct ApiFixture {
    database: ProductDatabase,
    path: PathBuf,
    project_id: ProjectId,
    storyboard_id: StoryboardId,
    media_id: MediaId,
    job_id: GenerationJobId,
}

impl ApiFixture {
    fn new() -> Self {
        let path = std::env::temp_dir().join(format!(
            "videoflow-generation-api-{}.sqlite",
            Uuid::new_v4()
        ));
        let database = ProductDatabase::open(&path).unwrap();
        let fixture = Self {
            database,
            path,
            project_id: ProjectId::new(),
            storyboard_id: StoryboardId::new(),
            media_id: MediaId::new(),
            job_id: GenerationJobId::new(),
        };
        fixture.seed_failed_job();
        fixture
    }

    fn router(&self) -> Router {
        crate::product::api::router(self.database.clone())
    }

    fn seed_failed_job(&self) {
        let connection = self.database.connect().unwrap();
        let proposal_id = ProposalId::new();
        let now = "2026-09-26T00:00:00+00:00";
        connection
            .execute(
                "INSERT INTO projects (id, name, revision, created_at, updated_at) \
                 VALUES (?1, 'Generation API', 1, ?2, ?2)",
                params![self.project_id.to_string(), now],
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO storyboards \
                 (id, project_id, name, position, revision, created_at, updated_at) \
                 VALUES (?1, ?2, 'Shot', 'a', 1, ?3, ?3)",
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
                 (id, project_id, storyboard_id, kind, role, name, prompt, mime_type, status, revision, created_at, updated_at) \
                 VALUES (?1, ?2, ?3, 'image', 'keyframe', 'Frame', 'prompt', 'image/webp', 'ready', 2, ?4, ?4)",
                params![
                    self.media_id.to_string(),
                    self.project_id.to_string(),
                    self.storyboard_id.to_string(),
                    now
                ],
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO change_proposals \
                 (id, project_id, storyboard_id, target_type, target_id, base_revision, before_value, proposed_value, \
                  summary, status, source_thread_id, source_turn_id, source_tool_call_id, revision, created_at, resolved_at) \
                 VALUES (?1, ?2, ?3, 'mediaPrompt', ?4, 1, 'old', 'prompt', 'summary', 'applied', ?5, ?6, 'call', 3, ?7, ?7)",
                params![
                    proposal_id.to_string(),
                    self.project_id.to_string(),
                    self.storyboard_id.to_string(),
                    self.media_id.to_string(),
                    Uuid::new_v4().to_string(),
                    Uuid::new_v4().to_string(),
                    now
                ],
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO generation_jobs \
                 (id, project_id, storyboard_id, proposal_id, target_type, target_id, target_revision, \
                  generation_spec_json, status, attempt, provider, error, created_at, updated_at) \
                 VALUES (?1, ?2, ?3, ?4, 'mediaPrompt', ?5, 2, ?6, 'failed', 1, 'test', 'failed', ?7, ?7)",
                params![
                    self.job_id.to_string(),
                    self.project_id.to_string(),
                    self.storyboard_id.to_string(),
                    proposal_id.to_string(),
                    self.media_id.to_string(),
                    serde_json::to_string(
                        &resolve_generation_spec(MediaKind::Image, None).unwrap()
                    )
                    .unwrap(),
                    now
                ],
            )
            .unwrap();
    }
}

impl Drop for ApiFixture {
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

#[tokio::test]
async fn latest_media_job_restores_status_after_reopening_an_object() {
    let fixture = ApiFixture::new();
    let route = format!(
        "/api/v1/projects/{}/media/{}/generation-jobs/latest",
        fixture.project_id, fixture.media_id
    );
    let response = fixture
        .router()
        .oneshot(Request::get(&route).body(Body::empty()).unwrap())
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let body: Value =
        serde_json::from_slice(&to_bytes(response.into_body(), usize::MAX).await.unwrap()).unwrap();
    assert_eq!(body["id"], fixture.job_id.to_string());
    assert_eq!(body["status"], "failed");

    let missing = format!(
        "/api/v1/projects/{}/media/{}/generation-jobs/latest",
        fixture.project_id,
        MediaId::new()
    );
    let response = fixture
        .router()
        .oneshot(Request::get(missing).body(Body::empty()).unwrap())
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let body: Value =
        serde_json::from_slice(&to_bytes(response.into_body(), usize::MAX).await.unwrap()).unwrap();
    assert!(body.is_null());
}

#[tokio::test]
async fn get_and_idempotent_retry_follow_the_frozen_contract() {
    let fixture = ApiFixture::new();
    let route = format!(
        "/api/v1/projects/{}/generation-jobs/{}",
        fixture.project_id, fixture.job_id
    );
    let get_response = fixture
        .router()
        .oneshot(Request::get(&route).body(Body::empty()).unwrap())
        .await
        .unwrap();
    assert_eq!(get_response.status(), StatusCode::OK);

    let retry_route = format!("{route}/retry");
    for _ in 0..2 {
        let response = fixture
            .router()
            .oneshot(
                Request::post(&retry_route)
                    .header("Idempotency-Key", "generation-retry-1")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::ACCEPTED);
        let body: Value =
            serde_json::from_slice(&to_bytes(response.into_body(), usize::MAX).await.unwrap())
                .unwrap();
        assert_eq!(body["status"], "waitingForProvider");
        assert_eq!(body["attempt"], 1);
        assert!(body.get("providerJobId").is_none());
    }

    let requested_count: i64 = fixture
        .database
        .connect()
        .unwrap()
        .query_row(
            "SELECT COUNT(*) FROM product_outbox_events WHERE event_type = 'generation.requested'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(requested_count, 1);
}

#[tokio::test]
async fn retry_requires_idempotency_and_project_scope() {
    let fixture = ApiFixture::new();
    let retry_route = format!(
        "/api/v1/projects/{}/generation-jobs/{}/retry",
        fixture.project_id, fixture.job_id
    );
    let missing_key = fixture
        .router()
        .oneshot(Request::post(&retry_route).body(Body::empty()).unwrap())
        .await
        .unwrap();
    assert_eq!(missing_key.status(), StatusCode::BAD_REQUEST);

    let wrong_project = format!(
        "/api/v1/projects/{}/generation-jobs/{}",
        ProjectId::new(),
        fixture.job_id
    );
    let response = fixture
        .router()
        .oneshot(Request::get(wrong_project).body(Body::empty()).unwrap())
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn direct_media_generation_updates_prompt_and_queues_one_idempotent_job() {
    let fixture = ApiFixture::new();
    let route = format!(
        "/api/v1/projects/{}/storyboards/{}/media/{}/generations",
        fixture.project_id, fixture.storyboard_id, fixture.media_id,
    );
    let body = serde_json::json!({
        "prompt": "  cinematic rain and neon reflections  ",
        "expectedRevision": 2
    });
    let mut job_id = None;
    for _ in 0..2 {
        let response = fixture
            .router()
            .oneshot(
                Request::post(&route)
                    .header("Content-Type", "application/json")
                    .header("Idempotency-Key", "direct-generation-1")
                    .body(Body::from(body.to_string()))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::ACCEPTED);
        let body: Value =
            serde_json::from_slice(&to_bytes(response.into_body(), usize::MAX).await.unwrap())
                .unwrap();
        assert_eq!(body["proposalId"], Value::Null);
        assert_eq!(body["status"], "waitingForProvider");
        assert_eq!(body["targetRevision"], 3);
        assert_eq!(body["spec"]["model"], "doubao-seedream-5-0-260128");
        if let Some(existing) = &job_id {
            assert_eq!(body["id"], *existing);
        } else {
            job_id = Some(body["id"].clone());
        }
    }

    let connection = fixture.database.connect().unwrap();
    let (prompt, revision): (String, i64) = connection
        .query_row(
            "SELECT prompt, revision FROM media_items WHERE id = ?1",
            [fixture.media_id.to_string()],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .unwrap();
    assert_eq!(prompt, "cinematic rain and neon reflections");
    assert_eq!(revision, 3);
    let direct_jobs: i64 = connection
        .query_row(
            "SELECT COUNT(*) FROM generation_jobs WHERE proposal_id IS NULL",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(direct_jobs, 1);
}

#[tokio::test]
async fn direct_generation_accepts_asset_media_bound_to_the_current_storyboard() {
    let fixture = ApiFixture::new();
    let asset_id = Uuid::new_v4();
    let section_id = Uuid::new_v4();
    let media_id = MediaId::new();
    {
        let connection = fixture.database.connect().unwrap();
        let now = "2026-09-26T00:00:00+00:00";
        connection.execute(
            "INSERT INTO assets (id, project_id, kind, name, revision, created_at, updated_at) \
             VALUES (?1, ?2, 'character', 'Bound character', 1, ?3, ?3)",
            params![asset_id.to_string(), fixture.project_id.to_string(), now],
        ).unwrap();
        connection.execute(
            "INSERT INTO asset_sections \
             (id, project_id, storyboard_id, name, kind, position, revision, created_at, updated_at) \
             VALUES (?1, ?2, ?3, 'Characters', 'character', '100', 1, ?4, ?4)",
            params![
                section_id.to_string(),
                fixture.project_id.to_string(),
                fixture.storyboard_id.to_string(),
                now,
            ],
        ).unwrap();
        connection.execute(
            "INSERT INTO asset_bindings \
             (id, project_id, storyboard_id, section_id, asset_id, position, revision, created_at, updated_at) \
             VALUES (?1, ?2, ?3, ?4, ?5, '100', 1, ?6, ?6)",
            params![
                Uuid::new_v4().to_string(),
                fixture.project_id.to_string(),
                fixture.storyboard_id.to_string(),
                section_id.to_string(),
                asset_id.to_string(),
                now,
            ],
        ).unwrap();
        connection.execute(
            "INSERT INTO media_items \
             (id, project_id, asset_id, kind, role, name, prompt, mime_type, status, revision, created_at, updated_at) \
             VALUES (?1, ?2, ?3, 'image', 'assetView', 'Face', 'old prompt', 'image/webp', 'ready', 1, ?4, ?4)",
            params![media_id.to_string(), fixture.project_id.to_string(), asset_id.to_string(), now],
        ).unwrap();
    }

    let route = format!(
        "/api/v1/projects/{}/storyboards/{}/media/{}/generations",
        fixture.project_id, fixture.storyboard_id, media_id,
    );
    let response = fixture
        .router()
        .oneshot(
            Request::post(route)
                .header("Content-Type", "application/json")
                .header("Idempotency-Key", "bound-asset-generation")
                .body(Body::from(
                    serde_json::json!({
                        "prompt": "updated bound asset",
                        "expectedRevision": 1
                    })
                    .to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::ACCEPTED);
    let body: Value =
        serde_json::from_slice(&to_bytes(response.into_body(), usize::MAX).await.unwrap()).unwrap();
    assert_eq!(body["targetId"], media_id.to_string());
    assert_eq!(body["targetRevision"], 2);
}
