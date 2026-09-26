use super::support::{format_position, immediate, POSITION_STEP};
use super::ProductDatabase;
use crate::product::domain::ProductResult;
use rusqlite::{params, Transaction};

pub const DEMO_PROJECT_ID: &str = "10000000-0000-4000-8000-000000000001";
pub const DEMO_STORYBOARD_COUNT: usize = 200;

const DEMO_ASSET_ID: &str = "40000000-0000-4000-8000-000000000001";
const FIXTURE_TIME: &str = "2026-09-26T00:00:00Z";
const STORYBOARD_NAMES: [&str; 24] = [
    "雾港建立镜头",
    "列车穿过雨幕",
    "主角走下站台",
    "寻找失踪信号",
    "旧码头入口",
    "无人机掠过水面",
    "仓库内部",
    "发现遗留终端",
    "警报突然亮起",
    "追逐开始",
    "穿越集装箱",
    "桥下短暂对峙",
    "信号源现身",
    "机械守卫苏醒",
    "霓虹街巷逃脱",
    "天台喘息",
    "远处塔楼启动",
    "再次收到讯息",
    "乘船离港",
    "水下灯群",
    "抵达防波堤",
    "最后的坐标",
    "晨光穿过云层",
    "未完待续",
];

pub fn demo_storyboard_id(index: usize) -> String {
    format!("20000000-0000-4000-8000-{index:012}")
}

/// Seeds the deterministic browser/E2E workspace. This is called only when the
/// local runtime is explicitly started with `--fixture`.
pub fn seed_demo_workspace(database: &ProductDatabase) -> ProductResult<()> {
    let mut connection = database.connect()?;
    let transaction = immediate(&mut connection)?;
    transaction.execute(
        "INSERT INTO projects (id, name, revision, created_at, updated_at)
         VALUES (?1, '霓虹港湾 · 概念短片', 1, ?2, ?2)
         ON CONFLICT(id) DO UPDATE SET name = excluded.name, updated_at = excluded.updated_at",
        params![DEMO_PROJECT_ID, FIXTURE_TIME],
    )?;
    transaction.execute(
        "INSERT INTO assets
         (id, project_id, kind, name, description, canonical_prompt, revision, created_at, updated_at)
         VALUES (?1, ?2, 'character', '林舟', '故事主角',
                 '28岁东亚女性，冷静克制，深蓝防雨风衣', 1, ?3, ?3)
         ON CONFLICT(id) DO UPDATE SET name = excluded.name,
             canonical_prompt = excluded.canonical_prompt, updated_at = excluded.updated_at",
        params![DEMO_ASSET_ID, DEMO_PROJECT_ID, FIXTURE_TIME],
    )?;

    for offset in 0..DEMO_STORYBOARD_COUNT {
        let index = offset + 1;
        let name = STORYBOARD_NAMES
            .get(offset)
            .map(|name| (*name).to_owned())
            .unwrap_or_else(|| format!("验收分镜 {index}"));
        let storyboard_id = demo_storyboard_id(index);
        let section_id = scoped_id(3, index);
        let binding_id = scoped_id(5, index);
        let media_id = scoped_id(6, index);
        let script = format!(
            "雨水打在金属顶棚上。林舟停在{name}的入口，确认终端上闪烁的坐标后继续向前。镜头从环境全景缓慢推进到她手中的信号终端。"
        );
        transaction.execute(
            "INSERT INTO storyboards
             (id, project_id, name, position, revision, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, 1, ?5, ?5)
             ON CONFLICT(id) DO UPDATE SET name = excluded.name,
                 position = excluded.position, updated_at = excluded.updated_at",
            params![
                storyboard_id,
                DEMO_PROJECT_ID,
                name,
                format_position((index as u64) * POSITION_STEP),
                FIXTURE_TIME
            ],
        )?;
        transaction.execute(
            "INSERT INTO storyboard_scripts (storyboard_id, text, revision, updated_at)
             VALUES (?1, ?2, 1, ?3)
             ON CONFLICT(storyboard_id) DO UPDATE SET text = excluded.text,
                 updated_at = excluded.updated_at",
            params![storyboard_id, script, FIXTURE_TIME],
        )?;
        transaction.execute(
            "INSERT INTO asset_sections
             (id, project_id, storyboard_id, parent_id, name, kind, position, revision, created_at, updated_at)
             VALUES (?1, ?2, ?3, NULL, '人物', 'character', ?4, 1, ?5, ?5)
             ON CONFLICT(id) DO UPDATE SET name = excluded.name, updated_at = excluded.updated_at",
            params![
                section_id,
                DEMO_PROJECT_ID,
                storyboard_id,
                format_position(POSITION_STEP),
                FIXTURE_TIME
            ],
        )?;
        transaction.execute(
            "INSERT INTO asset_bindings
             (id, project_id, storyboard_id, section_id, asset_id, position,
              prompt_override, revision, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, NULL, 1, ?7, ?7)
             ON CONFLICT(id) DO UPDATE SET section_id = excluded.section_id,
                 updated_at = excluded.updated_at",
            params![
                binding_id,
                DEMO_PROJECT_ID,
                storyboard_id,
                section_id,
                DEMO_ASSET_ID,
                format_position(POSITION_STEP),
                FIXTURE_TIME
            ],
        )?;
        transaction.execute(
            "INSERT INTO media_items
             (id, project_id, storyboard_id, kind, role, name, prompt, mime_type,
              width, height, duration_ms, status, revision, created_at, updated_at)
             VALUES (?1, ?2, ?3, 'video', 'generatedVideo', '生成版本 03',
                     '镜头缓慢前推，细雨与远处警示灯形成视差', 'video/mp4',
                     1920, 1080, 6000, 'placeholder', 1, ?4, ?4)
             ON CONFLICT(id) DO UPDATE SET prompt = excluded.prompt,
                 updated_at = excluded.updated_at",
            params![media_id, DEMO_PROJECT_ID, storyboard_id, FIXTURE_TIME],
        )?;
        seed_workspace_nodes(&transaction, &storyboard_id, index)?;
    }
    transaction.commit()?;
    Ok(())
}

fn seed_workspace_nodes(
    transaction: &Transaction<'_>,
    storyboard_id: &str,
    storyboard_index: usize,
) -> ProductResult<()> {
    let suffix = &storyboard_id[storyboard_id.len() - 2..];
    let script_folder = format!("folder-script-{storyboard_id}");
    let asset_folder = format!("folder-assets-{storyboard_id}");
    let video_folder = format!("folder-video-{storyboard_id}");
    let character_folder = format!("folder-{storyboard_id}-characters");
    let scene_folder = format!("folder-{storyboard_id}-scenes");
    let prop_folder = format!("folder-{storyboard_id}-props");
    let subject_folder = format!("folder-{storyboard_id}-characters-lin-zhou");
    let keyframe_folder = format!("folder-{storyboard_id}-keyframes");
    let generated_folder = format!("folder-{storyboard_id}-videos");
    let folders = [
        (&script_folder, None, "脚本"),
        (&asset_folder, None, "资产"),
        (&video_folder, None, "视频"),
        (&character_folder, Some(asset_folder.as_str()), "角色"),
        (&scene_folder, Some(asset_folder.as_str()), "场景"),
        (&prop_folder, Some(asset_folder.as_str()), "道具"),
        (&subject_folder, Some(character_folder.as_str()), "林舟"),
        (&keyframe_folder, Some(video_folder.as_str()), "分镜关键帧"),
        (&generated_folder, Some(video_folder.as_str()), "生成的视频"),
    ];
    let mut position = 0_u64;
    for (id, parent_id, name) in folders {
        position += POSITION_STEP;
        insert_fixture_node(
            transaction,
            id,
            storyboard_id,
            parent_id,
            "folder",
            name,
            None,
            None,
            None,
            position,
        )?;
    }
    let objects = [
        (
            format!("script-{storyboard_id}"),
            script_folder.as_str(),
            "该分镜的脚本",
            "text",
            "script",
            storyboard_id.to_owned(),
        ),
        (
            format!("node-character-face-{storyboard_id}"),
            subject_folder.as_str(),
            "面部三视图",
            "image",
            "media",
            format!("character-face-{suffix}"),
        ),
        (
            format!("node-character-costume-{storyboard_id}"),
            subject_folder.as_str(),
            "防雨服装",
            "image",
            "media",
            format!("character-costume-{suffix}"),
        ),
        (
            format!("node-scene-harbor-{storyboard_id}"),
            scene_folder.as_str(),
            if storyboard_index > 12 {
                "高塔外围"
            } else {
                "雨夜旧码头"
            },
            "image",
            "media",
            format!("scene-harbor-{suffix}"),
        ),
        (
            format!("node-prop-terminal-{storyboard_id}"),
            prop_folder.as_str(),
            "便携式信号终端",
            "image",
            "media",
            format!("prop-terminal-{suffix}"),
        ),
        (
            format!("node-first-frame-{storyboard_id}"),
            keyframe_folder.as_str(),
            "首帧",
            "image",
            "media",
            format!("first-frame-{suffix}"),
        ),
        (
            format!("node-key-frame-{storyboard_id}"),
            keyframe_folder.as_str(),
            "关键帧",
            "image",
            "media",
            format!("key-frame-{suffix}"),
        ),
        (
            format!("node-last-frame-{storyboard_id}"),
            keyframe_folder.as_str(),
            "尾帧",
            "image",
            "media",
            format!("last-frame-{suffix}"),
        ),
        (
            format!("node-video-draft-{storyboard_id}"),
            generated_folder.as_str(),
            "生成版本 03",
            "video",
            "media",
            format!("video-draft-{suffix}"),
        ),
        (
            format!("node-video-alt-{storyboard_id}"),
            generated_folder.as_str(),
            "备选版本 02",
            "video",
            "media",
            format!("video-alt-{suffix}"),
        ),
    ];
    for (id, parent_id, name, object_type, target_type, target_id) in objects {
        position += POSITION_STEP;
        insert_fixture_node(
            transaction,
            &id,
            storyboard_id,
            Some(parent_id),
            "object",
            name,
            Some(object_type),
            Some(target_type),
            Some(&target_id),
            position,
        )?;
    }
    Ok(())
}

#[allow(clippy::too_many_arguments)]
fn insert_fixture_node(
    transaction: &Transaction<'_>,
    id: &str,
    storyboard_id: &str,
    parent_id: Option<&str>,
    kind: &str,
    name: &str,
    object_type: Option<&str>,
    target_type: Option<&str>,
    target_id: Option<&str>,
    position: u64,
) -> ProductResult<()> {
    transaction.execute(
        "INSERT INTO workspace_nodes
         (id, project_id, storyboard_id, parent_id, kind, name, object_type, target_type,
          target_id, position, revision, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, 1, ?11, ?11)
         ON CONFLICT(id) DO UPDATE SET name = excluded.name, updated_at = excluded.updated_at",
        params![
            id,
            DEMO_PROJECT_ID,
            storyboard_id,
            parent_id,
            kind,
            name,
            object_type,
            target_type,
            target_id,
            format_position(position),
            FIXTURE_TIME,
        ],
    )?;
    Ok(())
}

fn scoped_id(prefix: u8, index: usize) -> String {
    format!("{prefix}0000000-0000-4000-8000-{index:012}")
}

#[cfg(test)]
mod tests {
    use super::*;
    use uuid::Uuid;

    #[test]
    fn seeds_the_same_workspace_idempotently() {
        let path = std::env::temp_dir().join(format!("videoflow-demo-{}.sqlite", Uuid::new_v4()));
        let database = ProductDatabase::open(&path).expect("open fixture database");
        seed_demo_workspace(&database).expect("seed fixture");
        seed_demo_workspace(&database).expect("seed fixture again");
        let connection = database.connect().unwrap();
        let projects: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM projects WHERE id = ?1",
                [DEMO_PROJECT_ID],
                |row| row.get(0),
            )
            .unwrap();
        let storyboards: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM storyboards WHERE project_id = ?1",
                [DEMO_PROJECT_ID],
                |row| row.get(0),
            )
            .unwrap();
        let bindings: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM asset_bindings WHERE project_id = ?1",
                [DEMO_PROJECT_ID],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(projects, 1);
        assert_eq!(storyboards, DEMO_STORYBOARD_COUNT as i64);
        assert_eq!(bindings, DEMO_STORYBOARD_COUNT as i64);
        drop(connection);
        for candidate in [
            path.clone(),
            path.with_extension("sqlite-wal"),
            path.with_extension("sqlite-shm"),
        ] {
            let _ = std::fs::remove_file(candidate);
        }
    }
}
