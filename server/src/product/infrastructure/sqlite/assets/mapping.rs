use crate::product::application::assets::{AssetBindingView, AssetSectionView, AssetView};
use crate::product::domain::{
    Asset, AssetBinding, AssetBindingId, AssetId, AssetKind, AssetRepresentation,
    AssetRepresentationId, AssetSection, AssetSectionId, AssetViewKind, MediaId, ProductResult,
    ProjectId, StoryboardId,
};
use crate::product::infrastructure::sqlite::support::{
    optional_time_from_row, time_from_row, uuid_from_row,
};
use rusqlite::{params, Connection, OptionalExtension, Row};
use std::str::FromStr;

pub(super) fn section_id_from_row(row: &Row<'_>, index: usize) -> rusqlite::Result<AssetSectionId> {
    uuid_from_row(row, index).map(AssetSectionId::from)
}

pub(super) fn binding_id_from_row(row: &Row<'_>, index: usize) -> rusqlite::Result<AssetBindingId> {
    uuid_from_row(row, index).map(AssetBindingId::from)
}

pub(super) fn uuid_at(row: &Row<'_>, index: usize) -> rusqlite::Result<uuid::Uuid> {
    uuid_from_row(row, index)
}

pub(super) fn ensure_storyboard(
    connection: &Connection,
    project_id: ProjectId,
    storyboard_id: StoryboardId,
) -> ProductResult<()> {
    let exists: bool = connection.query_row(
        "SELECT EXISTS(SELECT 1 FROM storyboards WHERE id = ?1 AND project_id = ?2 AND deleted_at IS NULL)",
        params![storyboard_id.to_string(), project_id.to_string()],
        |row| row.get(0),
    )?;
    if exists {
        Ok(())
    } else {
        Err(crate::product::domain::ProductError::NotFound)
    }
}

pub(super) fn load_section_view(
    connection: &Connection,
    project_id: ProjectId,
    storyboard_id: StoryboardId,
    section_id: AssetSectionId,
) -> ProductResult<Option<AssetSectionView>> {
    connection
        .query_row(
            "SELECT s.id, s.project_id, s.storyboard_id, s.parent_id, s.name, s.kind, s.position, s.revision,
                    (SELECT COUNT(*) FROM asset_bindings b WHERE b.section_id = s.id)
             FROM asset_sections s
             WHERE s.id = ?1 AND s.storyboard_id = ?2 AND s.project_id = ?3",
            params![section_id.to_string(), storyboard_id.to_string(), project_id.to_string()],
            section_view_from_row,
        )
        .optional()
        .map_err(Into::into)
}

pub(super) fn section_view_from_row(row: &Row<'_>) -> rusqlite::Result<AssetSectionView> {
    let parent = row
        .get::<_, Option<String>>(3)?
        .map(|value| uuid::Uuid::parse_str(&value))
        .transpose()
        .map_err(|error| {
            rusqlite::Error::FromSqlConversionFailure(
                3,
                rusqlite::types::Type::Text,
                Box::new(error),
            )
        })?
        .map(AssetSectionId::from);
    let kind = AssetKind::from_str(&row.get::<_, String>(5)?).map_err(storage_conversion(5))?;
    Ok(AssetSectionView {
        section: AssetSection {
            id: AssetSectionId::from(uuid_from_row(row, 0)?),
            project_id: ProjectId::from(uuid_from_row(row, 1)?),
            storyboard_id: StoryboardId::from(uuid_from_row(row, 2)?),
            parent_id: parent,
            name: row.get(4)?,
            kind,
            position: row.get(6)?,
            revision: row.get(7)?,
        },
        binding_count: row.get::<_, i64>(8)?.try_into().unwrap_or_default(),
    })
}

pub(super) fn load_asset_view(
    connection: &Connection,
    project_id: ProjectId,
    asset_id: AssetId,
) -> ProductResult<Option<AssetView>> {
    let mut value = connection
        .query_row(
            "SELECT a.id, a.project_id, a.kind, a.name, a.description, a.canonical_prompt,
                    a.revision, a.created_at, a.updated_at, a.deleted_at,
                    (SELECT COUNT(*) FROM asset_bindings b WHERE b.asset_id = a.id)
             FROM assets a WHERE a.id = ?1 AND a.project_id = ?2 AND a.deleted_at IS NULL",
            params![asset_id.to_string(), project_id.to_string()],
            asset_view_from_row,
        )
        .optional()?;
    if let Some(view) = value.as_mut() {
        view.asset.representations = load_representations(connection, asset_id)?;
    }
    Ok(value)
}

pub(super) fn asset_view_from_row(row: &Row<'_>) -> rusqlite::Result<AssetView> {
    let kind = AssetKind::from_str(&row.get::<_, String>(2)?).map_err(storage_conversion(2))?;
    Ok(AssetView {
        asset: Asset {
            id: AssetId::from(uuid_from_row(row, 0)?),
            project_id: ProjectId::from(uuid_from_row(row, 1)?),
            kind,
            name: row.get(3)?,
            description: row.get(4)?,
            canonical_prompt: row.get(5)?,
            revision: row.get(6)?,
            representations: Vec::new(),
            created_at: time_from_row(row, 7)?,
            updated_at: time_from_row(row, 8)?,
            deleted_at: optional_time_from_row(row, 9)?,
        },
        reference_count: row.get::<_, i64>(10)?.try_into().unwrap_or_default(),
    })
}

fn load_representations(
    connection: &Connection,
    asset_id: AssetId,
) -> ProductResult<Vec<AssetRepresentation>> {
    let mut statement = connection.prepare(
        "SELECT id, asset_id, label, view_kind, media_id, position
         FROM asset_representations WHERE asset_id = ?1 ORDER BY position, id",
    )?;
    let values = statement
        .query_map([asset_id.to_string()], representation_from_row)?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(values)
}

fn representation_from_row(row: &Row<'_>) -> rusqlite::Result<AssetRepresentation> {
    let media_id = row
        .get::<_, Option<String>>(4)?
        .map(|value| uuid::Uuid::parse_str(&value))
        .transpose()
        .map_err(|error| {
            rusqlite::Error::FromSqlConversionFailure(
                4,
                rusqlite::types::Type::Text,
                Box::new(error),
            )
        })?
        .map(MediaId::from);
    let view_kind =
        AssetViewKind::from_str(&row.get::<_, String>(3)?).map_err(storage_conversion(3))?;
    Ok(AssetRepresentation {
        id: AssetRepresentationId::from(uuid_from_row(row, 0)?),
        asset_id: AssetId::from(uuid_from_row(row, 1)?),
        label: row.get(2)?,
        view_kind,
        media_id,
        position: row.get(5)?,
    })
}

pub(super) fn load_binding_view(
    connection: &Connection,
    project_id: ProjectId,
    storyboard_id: StoryboardId,
    binding_id: AssetBindingId,
) -> ProductResult<Option<AssetBindingView>> {
    let binding = connection
        .query_row(
            "SELECT id, project_id, storyboard_id, section_id, asset_id, position,
                    prompt_override, derived_media_id, revision, created_at, updated_at
             FROM asset_bindings WHERE id = ?1 AND storyboard_id = ?2 AND project_id = ?3",
            params![
                binding_id.to_string(),
                storyboard_id.to_string(),
                project_id.to_string()
            ],
            binding_from_row,
        )
        .optional()?;
    let Some(binding) = binding else {
        return Ok(None);
    };
    let asset = load_asset_view(connection, project_id, binding.asset_id)?
        .ok_or(crate::product::domain::ProductError::NotFound)?;
    Ok(Some(AssetBindingView { binding, asset }))
}

pub(super) fn binding_from_row(row: &Row<'_>) -> rusqlite::Result<AssetBinding> {
    let derived_media_id = row
        .get::<_, Option<String>>(7)?
        .map(|value| uuid::Uuid::parse_str(&value))
        .transpose()
        .map_err(|error| {
            rusqlite::Error::FromSqlConversionFailure(
                7,
                rusqlite::types::Type::Text,
                Box::new(error),
            )
        })?
        .map(MediaId::from);
    Ok(AssetBinding {
        id: AssetBindingId::from(uuid_from_row(row, 0)?),
        project_id: ProjectId::from(uuid_from_row(row, 1)?),
        storyboard_id: StoryboardId::from(uuid_from_row(row, 2)?),
        section_id: AssetSectionId::from(uuid_from_row(row, 3)?),
        asset_id: AssetId::from(uuid_from_row(row, 4)?),
        position: row.get(5)?,
        prompt_override: row.get(6)?,
        derived_media_id,
        revision: row.get(8)?,
        created_at: time_from_row(row, 9)?,
        updated_at: time_from_row(row, 10)?,
    })
}

fn storage_conversion(
    index: usize,
) -> impl FnOnce(crate::product::domain::ProductError) -> rusqlite::Error {
    move |error| {
        rusqlite::Error::FromSqlConversionFailure(
            index,
            rusqlite::types::Type::Text,
            Box::new(error),
        )
    }
}
