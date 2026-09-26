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
    fn new(storyboard_index: usize) -> Self {
        let path =
            std::env::temp_dir().join(format!("videoflow-product-tools-{}.sqlite", Uuid::new_v4()));
        let database = ProductDatabase::open(&path).expect("open product tool database");
        seed_demo_workspace(&database).expect("seed product tool fixture");
        let thread_id = Uuid::new_v4();
        let turn_id = Uuid::new_v4();
        database
            .connect()
            .unwrap()
            .execute(
                "INSERT INTO workspace_thread_bindings
                 (thread_id, project_id, storyboard_id, created_at)
                 VALUES (?1, ?2, ?3, '2026-09-26T00:00:00Z')",
                params![
                    thread_id.to_string(),
                    DEMO_PROJECT_ID,
                    demo_storyboard_id(storyboard_index)
                ],
            )
            .unwrap();

        let workspace_store: Arc<dyn WorkspaceThreadStore> =
            Arc::new(SqliteWorkspaceThreadStore::new(database.clone()));
        let proposals =
            ProposalService::new(Arc::new(SqliteProposalRepository::new(database.clone())));
        let scope = WorkspaceThreadScopeResolver::new(workspace_store);
        let mut registry = ToolRegistry::default();
        register_product_tools(&mut registry, proposals, scope);

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
        self.registry.get(name).expect("registered product tool")
    }

    fn scalar_i64(&self, sql: &str) -> i64 {
        self.database
            .connect()
            .unwrap()
            .query_row(sql, [], |row| row.get(0))
            .unwrap()
    }

    fn scalar_string(&self, sql: &str) -> String {
        self.database
            .connect()
            .unwrap()
            .query_row(sql, [], |row| row.get(0))
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
fn tool_contracts_do_not_accept_model_selected_workspace_scope() {
    let fixture = ToolFixture::new(12);
    assert_eq!(
        fixture.registry.list(),
        vec![
            MEDIA_PROMPT_TOOL_NAME.to_owned(),
            SCRIPT_TOOL_NAME.to_owned()
        ]
    );

    let script = fixture.tool(SCRIPT_TOOL_NAME);
    let script_schema = script.schema();
    assert_eq!(script_schema["additionalProperties"], false);
    assert!(script_schema["properties"].get("projectId").is_none());
    assert!(script_schema["properties"].get("storyboardId").is_none());
    assert!(script
        .input_error(&json!({
            "projectId": Uuid::new_v4(),
            "storyboardId": Uuid::new_v4(),
            "proposedText": "replacement",
            "summary": "scope injection"
        }))
        .is_some());

    let prompt = fixture.tool(MEDIA_PROMPT_TOOL_NAME);
    assert_eq!(
        prompt.schema()["properties"]["targetType"]["enum"],
        json!(["media", "assetBinding"])
    );
    let policy = prompt.execution_policy(&ToolCall::new(MEDIA_PROMPT_TOOL_NAME, json!({})));
    assert!(policy.idempotent);
    assert!(!policy.read_only);
    assert!(!policy.parallel_safe);
}

#[tokio::test]
async fn script_tool_creates_one_pending_proposal_without_changing_script() {
    let fixture = ToolFixture::new(12);
    let tool = fixture.tool(SCRIPT_TOOL_NAME);
    let call = ToolCall::new(
        SCRIPT_TOOL_NAME,
        json!({
            "proposedText": "雨幕下，林舟停下并重新确认信号。",
            "summary": "收紧开场节奏"
        }),
    );

    let first = tool
        .execute(call.clone(), fixture.context(fixture.thread_id))
        .await
        .unwrap();
    let replay = tool
        .execute(call.clone(), fixture.context(fixture.thread_id))
        .await
        .unwrap();
    let output: Value = serde_json::from_str(&first.output).unwrap();
    let replay_output: Value = serde_json::from_str(&replay.output).unwrap();

    assert_eq!(first.call_id, call.id);
    assert_eq!(output["proposalId"], replay_output["proposalId"]);
    assert_eq!(output["status"], "pending");
    assert_eq!(output["targetType"], "script");
    assert_eq!(output["baseRevision"], 1);
    assert_eq!(
        fixture.scalar_i64("SELECT COUNT(*) FROM change_proposals"),
        1
    );
    assert_eq!(
        fixture.scalar_string(
            "SELECT text FROM storyboard_scripts WHERE storyboard_id =
             '20000000-0000-4000-8000-000000000012'"
        ),
        "雨水打在金属顶棚上。林舟停在桥下短暂对峙的入口，确认终端上闪烁的坐标后继续向前。镜头从环境全景缓慢推进到她手中的信号终端。"
    );
    assert_eq!(
        fixture.scalar_string("SELECT source_thread_id FROM change_proposals LIMIT 1"),
        fixture.thread_id.to_string()
    );
    assert_eq!(
        fixture.scalar_string("SELECT source_turn_id FROM change_proposals LIMIT 1"),
        fixture.turn_id.to_string()
    );
}

#[tokio::test]
async fn prompt_tool_rejects_unbound_or_cross_storyboard_targets() {
    let fixture = ToolFixture::new(12);
    let tool = fixture.tool(MEDIA_PROMPT_TOOL_NAME);
    let cross_storyboard = ToolCall::new(
        MEDIA_PROMPT_TOOL_NAME,
        json!({
            "targetType": "media",
            "targetId": fixture_id(6, 1),
            "proposedPrompt": "不应写入的越权提示词",
            "summary": "越权尝试"
        }),
    );
    let error = tool
        .execute(cross_storyboard, fixture.context(fixture.thread_id))
        .await
        .expect_err("another storyboard's media must be rejected");
    assert!(error.to_string().contains("resource not found"));

    let unbound = ToolCall::new(
        MEDIA_PROMPT_TOOL_NAME,
        json!({
            "targetType": "media",
            "targetId": fixture_id(6, 12),
            "proposedPrompt": "没有绑定的线程也不能写入",
            "summary": "伪造线程"
        }),
    );
    let error = tool
        .execute(unbound, fixture.context(Uuid::new_v4()))
        .await
        .expect_err("unbound threads must be rejected");
    assert!(error.to_string().contains("resource not found"));
    assert_eq!(
        fixture.scalar_i64("SELECT COUNT(*) FROM change_proposals"),
        0
    );
}

#[tokio::test]
async fn prompt_tool_accepts_media_and_asset_bindings_from_bound_storyboard_only() {
    let fixture = ToolFixture::new(12);
    let tool = fixture.tool(MEDIA_PROMPT_TOOL_NAME);

    let media = tool
        .execute(
            ToolCall::new(
                MEDIA_PROMPT_TOOL_NAME,
                json!({
                    "targetType": "media",
                    "targetId": fixture_id(6, 12),
                    "proposedPrompt": "镜头贴近人物，雨滴形成前景散景",
                    "summary": "加强镜头纵深"
                }),
            ),
            fixture.context(fixture.thread_id),
        )
        .await
        .unwrap();
    let media_output: Value = serde_json::from_str(&media.output).unwrap();
    assert_eq!(media_output["targetType"], "mediaPrompt");

    let binding = tool
        .execute(
            ToolCall::new(
                MEDIA_PROMPT_TOOL_NAME,
                json!({
                    "targetType": "assetBinding",
                    "targetId": fixture_id(5, 12),
                    "proposedPrompt": "仅在当前分镜使用的深蓝防雨风衣",
                    "summary": "创建分镜级服装覆盖"
                }),
            ),
            fixture.context(fixture.thread_id),
        )
        .await
        .unwrap();
    let binding_output: Value = serde_json::from_str(&binding.output).unwrap();
    assert_eq!(binding_output["targetType"], "assetBindingPrompt");
    assert_eq!(
        fixture.scalar_i64("SELECT COUNT(*) FROM change_proposals"),
        2
    );
    assert_eq!(
        fixture.scalar_i64("SELECT COUNT(*) FROM asset_bindings WHERE prompt_override IS NOT NULL"),
        0,
        "creating a proposal must not apply the prompt override"
    );
    assert_eq!(
        fixture.scalar_string(
            "SELECT prompt FROM media_items WHERE id =
             '60000000-0000-4000-8000-000000000012'"
        ),
        "镜头缓慢前推，细雨与远处警示灯形成视差"
    );
}
