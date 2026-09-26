use super::assets::copy_in_transaction;
use super::storyboard_order::allocate_after;
use super::storyboard_storage::{insert_script, insert_storyboard, require_project};
use super::support::{append_event, immediate, remember, replay};
use crate::product::application::assets::CopyAssetBindingsInput;
use crate::product::application::storyboards::{
    CreatedStoryboardRecord, IdempotencyContext, ReuseStoryboardAssets, StoryboardAssetCopySummary,
};
use crate::product::domain::{ProductResult, Storyboard, StoryboardId, StoryboardScript};
use rusqlite::Connection;
use serde_json::json;

pub(super) fn create_storyboard_with_assets(
    connection: &mut Connection,
    mut storyboard: Storyboard,
    script: StoryboardScript,
    insert_after_id: Option<StoryboardId>,
    reuse_assets: Option<ReuseStoryboardAssets>,
    idempotency: IdempotencyContext,
) -> ProductResult<CreatedStoryboardRecord> {
    let transaction = immediate(connection)?;
    if let Some(created) = replay::<CreatedStoryboardRecord>(&transaction, &idempotency)? {
        transaction.commit()?;
        return Ok(created);
    }
    require_project(&transaction, storyboard.project_id)?;
    storyboard.position =
        allocate_after(&transaction, storyboard.project_id, insert_after_id, None)?;
    insert_storyboard(&transaction, &storyboard)?;
    insert_script(&transaction, &script)?;
    append_event(
        &transaction,
        storyboard.project_id,
        "storyboard.created",
        json!({ "storyboardId": storyboard.id, "revision": storyboard.revision }),
    )?;
    let asset_copy = if let Some(reuse) = reuse_assets {
        let copied = copy_in_transaction(
            &transaction,
            &CopyAssetBindingsInput {
                project_id: storyboard.project_id,
                source_storyboard_id: reuse.source_storyboard_id,
                target_storyboard_id: storyboard.id,
                binding_ids: reuse.binding_ids,
                include_section_structure: true,
                target_section_id: None,
                include_prompt_overrides: reuse.include_prompt_overrides,
            },
        )?;
        StoryboardAssetCopySummary {
            created: copied.created_binding_ids.len() as u64,
            skipped: copied.skipped.len() as u64,
        }
    } else {
        StoryboardAssetCopySummary::default()
    };
    let created = CreatedStoryboardRecord {
        storyboard,
        asset_copy,
    };
    remember(&transaction, &idempotency, &created)?;
    transaction.commit()?;
    Ok(created)
}
