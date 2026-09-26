use super::*;
use crate::product::application::proposals::ProposalService;
use crate::product::application::workspace_threads::WorkspaceThreadStore;
use crate::product::infrastructure::sqlite::{
    demo_storyboard_id, seed_demo_workspace, ProductDatabase, SqliteProposalRepository,
    SqliteWorkspaceThreadStore, DEMO_PROJECT_ID,
};
use opentopia_core::policy::PermissionMode;
use opentopia_core::{CapabilityProjection, ExecutionAuthority, LocalSandboxConfig};
use rusqlite::params;
use serde_json::json;
use std::path::PathBuf;

struct ToolFixture {
    database: ProductDatabase,
    path: PathBuf,
    registry: ToolRegistry,
    thread_id: Uuid,
    turn_id: Uuid,
}

impl ToolFixture {
    fn new() -> Self {
        let path =
            std::env::temp_dir().join(format!("videoflow-product-tools-{}.sqlite", Uuid::new_v4()));
        let database = ProductDatabase::open(&path).unwrap();
        seed_demo_workspace(&database).unwrap();
        let thread_id = Uuid::new_v4();
        let turn_id = Uuid::new_v4();
        let connection = database.connect().unwrap();
        connection
            .execute(
                "INSERT INTO workspace_thread_bindings \
             (thread_id, project_id, storyboard_id, created_at) \
             VALUES (?1, ?2, ?3, '2026-09-26T00:00:00Z')",
                params![
                    thread_id.to_string(),
                    DEMO_PROJECT_ID,
                    demo_storyboard_id(12)
                ],
            )
            .unwrap();
        for (prefix, storyboard) in [(7, 12), (8, 12), (7, 1)] {
            connection
                .execute(
                    "INSERT INTO media_items \
                 (id, project_id, storyboard_id, kind, role, name, prompt, mime_type, \
                  source_object_key, status, revision, created_at, updated_at) \
                 VALUES (?1, ?2, ?3, 'image', 'keyframe', ?4, '参考画面', \
                         'image/png', ?5, 'ready', 1, ?6, ?6)",
                    params![
                        fixture_id(prefix, storyboard).to_string(),
                        DEMO_PROJECT_ID,
                        demo_storyboard_id(storyboard),
                        format!("参考图 {prefix}"),
                        format!("fixture/{prefix}-{storyboard}.png"),
                        "2026-09-26T00:00:00Z",
                    ],
                )
                .unwrap();
        }
        drop(connection);
        let workspace_store: Arc<dyn WorkspaceThreadStore> =
            Arc::new(SqliteWorkspaceThreadStore::new(database.clone()));
        let proposals =
            ProposalService::new(Arc::new(SqliteProposalRepository::new(database.clone())));
        let mut registry = ToolRegistry::default();
        register_product_tools(
            &mut registry,
            proposals,
            WorkspaceThreadScopeResolver::new(workspace_store),
        );
        Self {
            database,
            path,
            registry,
            thread_id,
            turn_id,
        }
    }

    fn context(&self, thread_id: Uuid) -> ToolInvocationContext {
        let authority = ExecutionAuthority::new(
            std::env::temp_dir(),
            PermissionMode::Unrestricted,
            LocalSandboxConfig::default(),
            CapabilityProjection::unrestricted(),
        )
        .unwrap();
        let mut context = authority.local_tool_context();
        context.thread_id = Some(thread_id);
        context.agent_turn_id = Some(self.turn_id);
        context
    }

    fn tool(&self, name: &str) -> Arc<dyn Tool> {
        self.registry.get(name).unwrap()
    }

    fn count(&self, table: &str) -> i64 {
        self.database
            .connect()
            .unwrap()
            .query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |row| {
                row.get(0)
            })
            .unwrap()
    }
}

impl Drop for ToolFixture {
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

fn fixture_id(prefix: u8, storyboard_index: usize) -> Uuid {
    Uuid::parse_str(&format!(
        "{prefix}0000000-0000-4000-8000-{storyboard_index:012}"
    ))
    .unwrap()
}

#[test]
fn only_storyboard_tools_are_registered() {
    let fixture = ToolFixture::new();
    assert_eq!(
        fixture.registry.list(),
        vec![
            IMAGE_TOOL_NAME,
            TEXT_TOOL_NAME,
            VIDEO_TOOL_NAME,
            READ_TOOL_NAME,
            SEARCH_TOOL_NAME,
        ]
    );
    for name in fixture.registry.list() {
        let schema = fixture.tool(&name).schema();
        assert_eq!(schema["additionalProperties"], false);
        assert!(schema["properties"].get("projectId").is_none());
        assert!(schema["properties"].get("storyboardId").is_none());
    }
}

#[tokio::test]
async fn search_and_read_are_scoped_to_the_bound_storyboard() {
    let fixture = ToolFixture::new();
    let search = fixture
        .tool(SEARCH_TOOL_NAME)
        .execute(
            ToolCall::new(SEARCH_TOOL_NAME, json!({"query":"参考图","kind":"image"})),
            fixture.context(fixture.thread_id),
        )
        .await
        .unwrap();
    let result: Value = serde_json::from_str(&search.output).unwrap();
    assert_eq!(result["total"], 2);
    assert!(result["items"]
        .as_array()
        .unwrap()
        .iter()
        .all(|item| item["revision"] == 1));

    let read = fixture
        .tool(READ_TOOL_NAME)
        .execute(
            ToolCall::new(
                READ_TOOL_NAME,
                json!({"kind":"text","id":demo_storyboard_id(12)}),
            ),
            fixture.context(fixture.thread_id),
        )
        .await
        .unwrap();
    let text: Value = serde_json::from_str(&read.output).unwrap();
    assert!(text["content"].as_str().unwrap().contains("桥下短暂对峙"));

    let denied = fixture
        .tool(READ_TOOL_NAME)
        .execute(
            ToolCall::new(
                READ_TOOL_NAME,
                json!({"kind":"image","id":fixture_id(7, 1)}),
            ),
            fixture.context(fixture.thread_id),
        )
        .await;
    assert!(denied.is_err());
    let unbound = fixture
        .tool(SEARCH_TOOL_NAME)
        .execute(
            ToolCall::new(SEARCH_TOOL_NAME, json!({})),
            fixture.context(Uuid::new_v4()),
        )
        .await;
    assert!(unbound.is_err());
}

#[tokio::test]
async fn text_patch_creates_one_pending_proposal_without_editing_script() {
    let fixture = ToolFixture::new();
    let call = ToolCall::new(
        TEXT_TOOL_NAME,
        json!({
            "targetId":demo_storyboard_id(12),"baseRevision":1,
            "oldText":"林舟停在桥下短暂对峙的入口",
            "newText":"林舟停在桥下，确认对方的位置",
            "summary":"收紧开场节奏"
        }),
    );
    let tool = fixture.tool(TEXT_TOOL_NAME);
    let result = tool
        .execute(call.clone(), fixture.context(fixture.thread_id))
        .await
        .unwrap();
    let replay = tool
        .execute(call, fixture.context(fixture.thread_id))
        .await
        .unwrap();
    let first: Value = serde_json::from_str(&result.output).unwrap();
    let second: Value = serde_json::from_str(&replay.output).unwrap();
    assert_eq!(first["proposalId"], second["proposalId"]);
    assert_eq!(first["targetType"], "script");
    assert_eq!(fixture.count("change_proposals"), 1);
    let script: String = fixture
        .database
        .connect()
        .unwrap()
        .query_row(
            "SELECT text FROM storyboard_scripts WHERE storyboard_id = ?1",
            [demo_storyboard_id(12)],
            |row| row.get(0),
        )
        .unwrap();
    assert!(script.contains("林舟停在桥下短暂对峙的入口"));
}

#[tokio::test]
async fn image_and_video_prompt_inputs_are_saved_and_checked() {
    let fixture = ToolFixture::new();
    let image = fixture
        .tool(IMAGE_TOOL_NAME)
        .execute(
            ToolCall::new(
                IMAGE_TOOL_NAME,
                json!({
                    "targetType":"assetBinding","targetId":fixture_id(5, 12),"baseRevision":1,
                    "proposedPrompt":"深蓝风衣，参考图片 1 的雨夜光线",
                    "input":{"type":"referenceImages","mediaIds":[fixture_id(7, 12)]},
                    "summary":"统一人物光线"
                }),
            ),
            fixture.context(fixture.thread_id),
        )
        .await
        .unwrap();
    let image_result: Value = serde_json::from_str(&image.output).unwrap();
    assert_eq!(
        image_result["proposedInput"]["mediaIds"][0],
        fixture_id(7, 12).to_string()
    );

    let video = fixture
        .tool(VIDEO_TOOL_NAME)
        .execute(
            ToolCall::new(
                VIDEO_TOOL_NAME,
                json!({
                    "targetId":fixture_id(6, 12),"baseRevision":1,
                    "proposedPrompt":"从首帧移动到尾帧",
                    "input":{"type":"firstLastFrames","firstFrameMediaId":fixture_id(7, 12),
                             "lastFrameMediaId":fixture_id(7, 12)},
                    "summary":"锁定首尾帧"
                }),
            ),
            fixture.context(fixture.thread_id),
        )
        .await
        .unwrap();
    let video_result: Value = serde_json::from_str(&video.output).unwrap();
    assert_eq!(video_result["proposedInput"]["type"], "firstLastFrames");

    let denied = fixture
        .tool(VIDEO_TOOL_NAME)
        .execute(
            ToolCall::new(
                VIDEO_TOOL_NAME,
                json!({
                    "targetId":fixture_id(6, 12),"baseRevision":1,
                    "proposedPrompt":"越界参考","input":{"type":"referenceImages",
                        "mediaIds":[fixture_id(7, 1)]},"summary":"越界"
                }),
            ),
            fixture.context(fixture.thread_id),
        )
        .await;
    assert!(denied.is_err());

    let mixed = fixture
        .tool(VIDEO_TOOL_NAME)
        .execute(
            ToolCall::new(
                VIDEO_TOOL_NAME,
                json!({
                    "targetId":fixture_id(6, 12),"baseRevision":1,
                    "proposedPrompt":"混用","input":{"type":"firstLastFrames",
                        "firstFrameMediaId":fixture_id(7, 12),"mediaIds":[fixture_id(8, 12)]},
                    "summary":"混用"
                }),
            ),
            fixture.context(fixture.thread_id),
        )
        .await;
    assert!(mixed.is_err());

    let shared_media_id = fixture_id(9, 12);
    let connection = fixture.database.connect().unwrap();
    let asset_id: String = connection
        .query_row(
            "SELECT asset_id FROM asset_bindings WHERE id = ?1",
            [fixture_id(5, 12).to_string()],
            |row| row.get(0),
        )
        .unwrap();
    connection
        .execute(
            "INSERT INTO media_items \
             (id, project_id, asset_id, kind, role, name, prompt, mime_type, \
              source_object_key, status, revision, created_at, updated_at) \
             VALUES (?1, ?2, ?3, 'image', 'assetView', '共享资产画面', '原始提示词', \
                     'image/png', 'fixture/shared.png', 'ready', 1, ?4, ?4)",
            params![
                shared_media_id.to_string(),
                DEMO_PROJECT_ID,
                asset_id,
                "2026-09-26T00:00:00Z",
            ],
        )
        .unwrap();
    drop(connection);
    let read = fixture
        .tool(READ_TOOL_NAME)
        .execute(
            ToolCall::new(READ_TOOL_NAME, json!({"kind":"image","id":shared_media_id})),
            fixture.context(fixture.thread_id),
        )
        .await
        .unwrap();
    let resource: Value = serde_json::from_str(&read.output).unwrap();
    assert_eq!(resource["editable"], false);
    let shared_edit = fixture
        .tool(IMAGE_TOOL_NAME)
        .execute(
            ToolCall::new(
                IMAGE_TOOL_NAME,
                json!({
                    "targetType":"media","targetId":shared_media_id,"baseRevision":1,
                    "proposedPrompt":"改动共享图","input":{"type":"textOnly"},
                    "summary":"不应跨片段改共享媒体"
                }),
            ),
            fixture.context(fixture.thread_id),
        )
        .await;
    assert!(shared_edit.is_err());
    assert_eq!(fixture.count("change_proposals"), 2);
}

#[tokio::test]
async fn confirming_prompt_uses_and_reads_back_suggested_references() {
    let fixture = ToolFixture::new();
    let result = fixture
        .tool(IMAGE_TOOL_NAME)
        .execute(
            ToolCall::new(
                IMAGE_TOOL_NAME,
                json!({
                    "targetType":"media","targetId":fixture_id(7, 12),"baseRevision":1,
                    "proposedPrompt":"按参考图片 1 的构图重新绘制",
                    "input":{"type":"referenceImages","mediaIds":[fixture_id(8, 12)]},
                    "summary":"更新关键帧"
                }),
            ),
            fixture.context(fixture.thread_id),
        )
        .await
        .unwrap();
    let output: Value = serde_json::from_str(&result.output).unwrap();
    let proposal_id = crate::product::domain::ProposalId(
        Uuid::parse_str(output["proposalId"].as_str().unwrap()).unwrap(),
    );
    let service = ProposalService::new(Arc::new(SqliteProposalRepository::new(
        fixture.database.clone(),
    )));
    let applied = service
        .apply_with_generation(
            crate::product::domain::ProjectId(Uuid::parse_str(DEMO_PROJECT_ID).unwrap()),
            proposal_id,
            1,
            1,
            None,
            Uuid::new_v4().to_string(),
        )
        .await
        .unwrap();
    let job = applied.generation_job.unwrap();
    assert_eq!(
        job.spec.input,
        GenerationInputSelection::ReferenceImages {
            media_ids: vec![MediaId(fixture_id(8, 12))],
        }
    );
    let read = fixture
        .tool(READ_TOOL_NAME)
        .execute(
            ToolCall::new(
                READ_TOOL_NAME,
                json!({"kind":"image","id":fixture_id(7, 12)}),
            ),
            fixture.context(fixture.thread_id),
        )
        .await
        .unwrap();
    let current: Value = serde_json::from_str(&read.output).unwrap();
    assert_eq!(
        current["generationInput"]["mediaIds"][0],
        fixture_id(8, 12).to_string()
    );
}
