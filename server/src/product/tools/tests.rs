use super::*;
use crate::product::application::proposals::ProposalService;
use crate::product::application::workspace_nodes::{
    UndoWorkspaceObjectPromptInput, WorkspaceNodeService,
};
use crate::product::application::workspace_threads::WorkspaceThreadStore;
use crate::product::infrastructure::sqlite::{
    demo_storyboard_id, seed_demo_workspace, ProductDatabase, SqliteProposalRepository,
    SqliteWorkspaceNodeRepository, SqliteWorkspaceThreadStore, DEMO_PROJECT_ID,
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
            WorkspaceNodeService::new(Arc::new(SqliteWorkspaceNodeRepository::new(
                database.clone(),
            ))),
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
            CREATE_OBJECT_TOOL_NAME,
            IMAGE_TOOL_NAME,
            TEXT_TOOL_NAME,
            VIDEO_TOOL_NAME,
            READ_TOOL_NAME,
            SAVE_OBJECT_PROMPT_TOOL_NAME,
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
async fn saves_image_and_video_prompts_directly_without_generation_or_proposals() {
    let fixture = ToolFixture::new();
    let create = fixture.tool(CREATE_OBJECT_TOOL_NAME);
    let save = fixture.tool(SAVE_OBJECT_PROMPT_TOOL_NAME);
    let mut saved_image: Option<(String, String)> = None;

    for (object_type, name, prompt) in [
        ("image", "新图片对象", "电影感人物定妆，柔和侧光"),
        ("video", "新视频对象", "镜头从全景缓慢推进到人物近景"),
    ] {
        let created = create
            .execute(
                ToolCall::new(
                    CREATE_OBJECT_TOOL_NAME,
                    json!({
                        "parentId": null,
                        "name": name,
                        "objectType": object_type,
                        "prompt": "初始提示词"
                    }),
                ),
                fixture.context(fixture.thread_id),
            )
            .await
            .unwrap();
        let created: Value = serde_json::from_str(&created.output).unwrap();
        let object_id = created["objectId"].as_str().unwrap();
        let call = ToolCall::new(
            SAVE_OBJECT_PROMPT_TOOL_NAME,
            json!({
                "targetId": object_id,
                "baseRevision": 1,
                "prompt": prompt
            }),
        );
        let first = save
            .execute(call.clone(), fixture.context(fixture.thread_id))
            .await
            .unwrap();
        let replay = save
            .execute(call, fixture.context(fixture.thread_id))
            .await
            .unwrap();
        let first: Value = serde_json::from_str(&first.output).unwrap();
        let replay: Value = serde_json::from_str(&replay.output).unwrap();
        assert_eq!(first, replay);
        assert_eq!(first["objectType"], object_type);
        assert_eq!(first["revision"], 2);
        assert_eq!(first["generationRequested"], false);

        let saved: (String, String, i64, Option<String>) = fixture
            .database
            .connect()
            .unwrap()
            .query_row(
                "SELECT media.kind, media.prompt, media.revision, node.unseen_update_at
                 FROM media_items media JOIN workspace_nodes node ON node.target_id = media.id
                 WHERE media.id = ?1",
                [object_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            )
            .unwrap();
        assert_eq!(saved.0, object_type);
        assert_eq!(saved.1, prompt);
        assert_eq!(saved.2, 2);
        assert!(
            saved.3.is_some(),
            "Agent-authored prompt must remain marked unseen"
        );
        if object_type == "image" {
            saved_image = Some((object_id.to_owned(), prompt.to_owned()));
        }
    }

    let (image_id, expected_image_prompt) = saved_image.expect("image object was created");
    let protected_image: (String, i64) = fixture
        .database
        .connect()
        .unwrap()
        .query_row(
            "SELECT prompt, revision FROM media_items WHERE id = ?1",
            [image_id.clone()],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .unwrap();
    assert_eq!(protected_image.0, expected_image_prompt);
    assert_eq!(
        protected_image.1, 2,
        "saving the video prompt must not revise the image object"
    );

    // Resource search returns the media ID, which is not necessarily the same as
    // the workspace node ID. Preserve that abstraction boundary for linked media.
    let linked_media_id = fixture_id(6, 12).to_string();
    let linked_object_id = format!("node-video-draft-{}", demo_storyboard_id(12));
    fixture
        .database
        .connect()
        .unwrap()
        .execute(
            "UPDATE workspace_nodes SET target_id = ?1 WHERE id = ?2",
            params![linked_media_id, linked_object_id],
        )
        .unwrap();
    let linked = save
        .execute(
            ToolCall::new(
                SAVE_OBJECT_PROMPT_TOOL_NAME,
                json!({
                    "targetId": linked_media_id,
                    "baseRevision": 1,
                    "prompt": "关联媒体的新视频提示词"
                }),
            ),
            fixture.context(fixture.thread_id),
        )
        .await
        .unwrap();
    let linked: Value = serde_json::from_str(&linked.output).unwrap();
    assert_eq!(linked["objectId"], linked_object_id);
    assert_eq!(linked["mediaId"], linked_media_id);
    assert_eq!(linked["objectType"], "video");
    assert_eq!(linked["revision"], 2);

    let linked_unseen: Option<String> = fixture
        .database
        .connect()
        .unwrap()
        .query_row(
            "SELECT unseen_update_at FROM workspace_nodes WHERE id = ?1",
            [linked_object_id],
            |row| row.get(0),
        )
        .unwrap();
    assert!(linked_unseen.is_some());
    assert_eq!(fixture.count("workspace_object_prompt_history"), 3);

    let undo_service = WorkspaceNodeService::new(Arc::new(SqliteWorkspaceNodeRepository::new(
        fixture.database.clone(),
    )));
    let restored = undo_service
        .undo_object_prompt(
            UndoWorkspaceObjectPromptInput {
                project_id: ProjectId(Uuid::parse_str(DEMO_PROJECT_ID).unwrap()),
                storyboard_id: StoryboardId(Uuid::parse_str(&demo_storyboard_id(12)).unwrap()),
                target_id: image_id.clone(),
                expected_revision: 2,
            },
            "undo-image-prompt".into(),
        )
        .await
        .unwrap();
    assert_eq!(restored.prompt, "初始提示词");
    assert_eq!(restored.revision, 3);
    let restored_state: (String, i64, Option<String>) = fixture
        .database
        .connect()
        .unwrap()
        .query_row(
            "SELECT media.prompt, media.revision, node.unseen_update_at
             FROM media_items media JOIN workspace_nodes node ON node.target_id = media.id
             WHERE media.id = ?1",
            [image_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .unwrap();
    assert_eq!(restored_state, ("初始提示词".into(), 3, None));

    assert_eq!(fixture.count("generation_jobs"), 0);
    assert_eq!(fixture.count("change_proposals"), 0);
}

#[tokio::test]
async fn creates_prompted_media_objects_in_the_requested_folder_without_generation() {
    let fixture = ToolFixture::new();
    let parent_id = format!("folder-{}-characters", demo_storyboard_id(12));
    let call = ToolCall::new(
        CREATE_OBJECT_TOOL_NAME,
        json!({
            "parentId": parent_id,
            "name": "雨夜人物定妆",
            "objectType": "image",
            "prompt": "  林舟站在雨夜桥下，冷蓝侧光  "
        }),
    );
    let tool = fixture.tool(CREATE_OBJECT_TOOL_NAME);
    let first = tool
        .execute(call.clone(), fixture.context(fixture.thread_id))
        .await
        .unwrap();
    let replay = tool
        .execute(call, fixture.context(fixture.thread_id))
        .await
        .unwrap();
    let first: Value = serde_json::from_str(&first.output).unwrap();
    let replay: Value = serde_json::from_str(&replay.output).unwrap();
    assert_eq!(first["objectId"], replay["objectId"]);
    assert_eq!(first["mediaId"], first["objectId"]);
    assert_eq!(first["parentId"], parent_id);
    assert_eq!(first["generationRequested"], false);

    let object_id = first["objectId"].as_str().unwrap();
    let saved: (String, String, String, String, String, i64) = fixture
        .database
        .connect()
        .unwrap()
        .query_row(
            "SELECT node.object_type, node.target_type, node.target_id, media.prompt,
                    media.status, media.revision
             FROM workspace_nodes node JOIN media_items media ON media.id = node.target_id
             WHERE node.id = ?1",
            [object_id],
            |row| {
                Ok((
                    row.get(0)?,
                    row.get(1)?,
                    row.get(2)?,
                    row.get(3)?,
                    row.get(4)?,
                    row.get(5)?,
                ))
            },
        )
        .unwrap();
    assert_eq!(
        saved,
        (
            "image".into(),
            "media".into(),
            object_id.into(),
            "林舟站在雨夜桥下，冷蓝侧光".into(),
            "placeholder".into(),
            1,
        )
    );
    assert_eq!(fixture.count("generation_jobs"), 0);

    let video = tool
        .execute(
            ToolCall::new(
                CREATE_OBJECT_TOOL_NAME,
                json!({
                    "parentId": null,
                    "name": "桥下推进镜头",
                    "objectType": "video",
                    "prompt": "镜头缓慢向前推进"
                }),
            ),
            fixture.context(fixture.thread_id),
        )
        .await
        .unwrap();
    let video: Value = serde_json::from_str(&video.output).unwrap();
    assert_eq!(video["objectType"], "video");
    assert_eq!(video["parentId"], Value::Null);
    assert_eq!(fixture.count("generation_jobs"), 0);
}

#[tokio::test]
async fn create_object_rejects_a_folder_outside_the_bound_storyboard() {
    let fixture = ToolFixture::new();
    let result = fixture
        .tool(CREATE_OBJECT_TOOL_NAME)
        .execute(
            ToolCall::new(
                CREATE_OBJECT_TOOL_NAME,
                json!({
                    "parentId": format!("folder-assets-{}", demo_storyboard_id(1)),
                    "name": "越界对象",
                    "objectType": "image",
                    "prompt": "不应创建"
                }),
            ),
            fixture.context(fixture.thread_id),
        )
        .await;
    assert!(result.is_err());
    assert_eq!(fixture.count("generation_jobs"), 0);
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
