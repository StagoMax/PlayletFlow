use crate::product::domain::{ProductError, ProductResult, ProjectId, StoryboardId};
use crate::product::infrastructure::sqlite::support::{
    format_position, uuid_from_row, POSITION_STEP,
};
use rusqlite::types::Type;
use rusqlite::{params, Connection, Row, Transaction};

pub(super) fn ordered_positions_excluding(
    connection: &Connection,
    project_id: ProjectId,
    excluded_id: Option<StoryboardId>,
) -> ProductResult<Vec<(StoryboardId, u64)>> {
    let sql = if excluded_id.is_some() {
        "SELECT id, position FROM storyboards
         WHERE project_id = ?1 AND deleted_at IS NULL AND id <> ?2 ORDER BY position, id"
    } else {
        "SELECT id, position FROM storyboards
         WHERE project_id = ?1 AND deleted_at IS NULL ORDER BY position, id"
    };
    let mut statement = connection.prepare(sql)?;
    let read = |row: &Row<'_>| {
        let id = StoryboardId(uuid_from_row(row, 0)?);
        let position: String = row.get(1)?;
        let position = position.parse::<u64>().map_err(|error| {
            rusqlite::Error::FromSqlConversionFailure(1, Type::Text, Box::new(error))
        })?;
        Ok((id, position))
    };
    let rows = match excluded_id {
        Some(id) => statement.query_map(params![project_id.to_string(), id.to_string()], read)?,
        None => statement.query_map([project_id.to_string()], read)?,
    };
    rows.collect::<Result<Vec<_>, _>>().map_err(Into::into)
}

pub(super) fn allocate_after(
    transaction: &Transaction<'_>,
    project_id: ProjectId,
    insert_after_id: Option<StoryboardId>,
    excluded_id: Option<StoryboardId>,
) -> ProductResult<String> {
    let mut ordered = ordered_positions_excluding(transaction, project_id, excluded_id)?;
    let insertion = match insert_after_id {
        Some(id) => ordered
            .iter()
            .position(|(candidate, _)| *candidate == id)
            .map(|index| index + 1)
            .ok_or(ProductError::NotFound)?,
        None => ordered.len(),
    };
    allocate_at(
        transaction,
        project_id,
        &mut ordered,
        insertion,
        excluded_id,
    )
}

pub(super) fn allocate_at(
    transaction: &Transaction<'_>,
    project_id: ProjectId,
    ordered: &mut Vec<(StoryboardId, u64)>,
    insertion: usize,
    excluded_id: Option<StoryboardId>,
) -> ProductResult<String> {
    if insertion > ordered.len() {
        return Err(ProductError::Validation(
            "storyboard insertion point is invalid".to_owned(),
        ));
    }
    if let Some(position) = position_at(ordered, insertion) {
        if position_available(transaction, project_id, position, excluded_id)? {
            return Ok(format_position(position));
        }
    }
    rebalance_positions(transaction, project_id, excluded_id)?;
    *ordered = ordered_positions_excluding(transaction, project_id, excluded_id)?;
    let position = position_at(ordered, insertion).ok_or_else(|| {
        ProductError::Storage("unable to allocate storyboard position".to_owned())
    })?;
    if !position_available(transaction, project_id, position, excluded_id)? {
        return Err(ProductError::Storage(
            "storyboard position remains occupied after rebalance".to_owned(),
        ));
    }
    Ok(format_position(position))
}

pub(super) fn position_available(
    connection: &Connection,
    project_id: ProjectId,
    position: u64,
    excluded_id: Option<StoryboardId>,
) -> ProductResult<bool> {
    let position = format_position(position);
    let occupied = match excluded_id {
        Some(id) => connection.query_row(
            "SELECT EXISTS(SELECT 1 FROM storyboards
             WHERE project_id = ?1 AND position = ?2 AND id <> ?3)",
            params![project_id.to_string(), position, id.to_string()],
            |row| row.get::<_, bool>(0),
        )?,
        None => connection.query_row(
            "SELECT EXISTS(SELECT 1 FROM storyboards WHERE project_id = ?1 AND position = ?2)",
            params![project_id.to_string(), position],
            |row| row.get::<_, bool>(0),
        )?,
    };
    Ok(!occupied)
}

pub(super) fn position_at(ordered: &[(StoryboardId, u64)], insertion: usize) -> Option<u64> {
    if ordered.is_empty() {
        return Some(POSITION_STEP);
    }
    let left = insertion
        .checked_sub(1)
        .and_then(|index| ordered.get(index).map(|(_, position)| *position))
        .unwrap_or(0);
    let right = ordered.get(insertion).map(|(_, position)| *position);
    match right {
        Some(right) if right > left + 1 => Some(left + (right - left) / 2),
        Some(_) => None,
        None => left.checked_add(POSITION_STEP),
    }
}

pub(super) fn insertion_index(
    ordered: &[(StoryboardId, u64)],
    before_id: Option<StoryboardId>,
    after_id: Option<StoryboardId>,
) -> ProductResult<usize> {
    let before = before_id
        .map(|id| {
            ordered
                .iter()
                .position(|(candidate, _)| *candidate == id)
                .ok_or(ProductError::NotFound)
        })
        .transpose()?;
    let after = after_id
        .map(|id| {
            ordered
                .iter()
                .position(|(candidate, _)| *candidate == id)
                .ok_or(ProductError::NotFound)
        })
        .transpose()?;
    match (before, after) {
        (Some(before), Some(after)) if after + 1 == before => Ok(before),
        (Some(_), Some(_)) => Err(ProductError::Validation(
            "beforeId and afterId must be adjacent".to_owned(),
        )),
        (Some(before), None) => Ok(before),
        (None, Some(after)) => Ok(after + 1),
        (None, None) => Err(ProductError::Validation(
            "beforeId or afterId is required".to_owned(),
        )),
    }
}

pub(super) fn rebalance_positions(
    transaction: &Transaction<'_>,
    project_id: ProjectId,
    excluded_id: Option<StoryboardId>,
) -> ProductResult<()> {
    let ordered = ordered_positions_excluding(transaction, project_id, excluded_id)?;
    let mut deleted = {
        let sql = if excluded_id.is_some() {
            "SELECT id FROM storyboards
             WHERE project_id = ?1 AND deleted_at IS NOT NULL AND id <> ?2
             ORDER BY position, id"
        } else {
            "SELECT id FROM storyboards
             WHERE project_id = ?1 AND deleted_at IS NOT NULL ORDER BY position, id"
        };
        let mut statement = transaction.prepare(sql)?;
        let read = |row: &Row<'_>| Ok(StoryboardId(uuid_from_row(row, 0)?));
        let rows = match excluded_id {
            Some(id) => {
                statement.query_map(params![project_id.to_string(), id.to_string()], read)?
            }
            None => statement.query_map([project_id.to_string()], read)?,
        };
        rows.collect::<Result<Vec<_>, _>>()?
    };
    for (id, _) in &ordered {
        transaction.execute(
            "UPDATE storyboards SET position = ?1 WHERE id = ?2",
            params![format!("tmp-{id}"), id.to_string()],
        )?;
    }
    for id in &deleted {
        transaction.execute(
            "UPDATE storyboards SET position = ?1 WHERE id = ?2",
            params![format!("tmp-{id}"), id.to_string()],
        )?;
    }
    let mut all_ids = ordered.iter().map(|(id, _)| *id).collect::<Vec<_>>();
    all_ids.append(&mut deleted);
    for (index, id) in all_ids.iter().enumerate() {
        let position = POSITION_STEP
            .checked_mul(index as u64 + 1)
            .ok_or_else(|| ProductError::Storage("storyboard position overflow".to_owned()))?;
        transaction.execute(
            "UPDATE storyboards SET position = ?1 WHERE id = ?2",
            params![format_position(position), id.to_string()],
        )?;
    }
    Ok(())
}
