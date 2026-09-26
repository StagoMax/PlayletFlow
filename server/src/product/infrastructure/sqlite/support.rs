use crate::product::application::idempotency::IdempotencyContext;
use crate::product::domain::{ProductError, ProductResult, ProjectId};
use chrono::{DateTime, Duration, Utc};
use rusqlite::types::Type;
use rusqlite::{params, Connection, OptionalExtension, Row, Transaction, TransactionBehavior};
use serde::de::DeserializeOwned;
use serde::Serialize;
use uuid::Uuid;

pub const POSITION_STEP: u64 = 1_000_000_000;

pub fn immediate(connection: &mut Connection) -> ProductResult<Transaction<'_>> {
    connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(Into::into)
}

pub fn replay<T: DeserializeOwned>(
    transaction: &Transaction<'_>,
    context: &IdempotencyContext,
) -> ProductResult<Option<T>> {
    transaction.execute(
        "DELETE FROM idempotency_records WHERE expires_at <= ?1",
        [Utc::now().to_rfc3339()],
    )?;
    let record = transaction
        .query_row(
            "SELECT request_hash, response_json FROM idempotency_records
             WHERE actor_scope = ?1 AND route = ?2 AND idempotency_key = ?3",
            params![context.actor_scope, context.operation, context.key],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, Option<String>>(1)?)),
        )
        .optional()?;
    let Some((request_hash, response)) = record else {
        return Ok(None);
    };
    if request_hash != context.request_hash {
        return Err(ProductError::Conflict {
            code: "IDEMPOTENCY_KEY_REUSED",
            message: "idempotency key was already used with a different request".to_owned(),
        });
    }
    let response = response.ok_or_else(|| {
        ProductError::Storage("idempotent operation has no stored response".to_owned())
    })?;
    serde_json::from_str(&response)
        .map(Some)
        .map_err(|error| ProductError::Storage(error.to_string()))
}

pub fn remember<T: Serialize>(
    transaction: &Transaction<'_>,
    context: &IdempotencyContext,
    response: &T,
) -> ProductResult<()> {
    let now = Utc::now();
    transaction.execute(
        "INSERT INTO idempotency_records
         (actor_scope, route, idempotency_key, request_hash, status_code, response_json, created_at, expires_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
        params![
            context.actor_scope,
            context.operation,
            context.key,
            context.request_hash,
            context.success_status,
            serde_json::to_string(response)
                .map_err(|error| ProductError::Storage(error.to_string()))?,
            now.to_rfc3339(),
            (now + Duration::hours(24)).to_rfc3339()
        ],
    )?;
    Ok(())
}

pub fn append_event(
    transaction: &Transaction<'_>,
    project_id: ProjectId,
    event_type: &str,
    payload: serde_json::Value,
) -> ProductResult<()> {
    transaction.execute(
        "INSERT INTO product_outbox_events
         (id, project_id, event_type, payload_json, occurred_at)
         VALUES (?1, ?2, ?3, ?4, ?5)",
        params![
            Uuid::new_v4().to_string(),
            project_id.to_string(),
            event_type,
            payload.to_string(),
            Utc::now().to_rfc3339()
        ],
    )?;
    Ok(())
}

pub fn format_position(value: u64) -> String {
    format!("{value:020}")
}

pub fn next_position(
    transaction: &Transaction<'_>,
    table: &str,
    scope_column: &str,
    scope_id: &str,
) -> ProductResult<String> {
    let sql = format!(
        "SELECT position FROM {table} WHERE {scope_column} = ?1 ORDER BY position DESC LIMIT 1"
    );
    let last = transaction
        .query_row(&sql, [scope_id], |row| row.get::<_, String>(0))
        .optional()?;
    let last = last
        .as_deref()
        .and_then(|value| value.parse::<u64>().ok())
        .unwrap_or_default();
    let next = last
        .checked_add(POSITION_STEP)
        .ok_or_else(|| ProductError::Storage("position overflow".to_owned()))?;
    Ok(format_position(next))
}

pub fn uuid_from_row(row: &Row<'_>, index: usize) -> rusqlite::Result<Uuid> {
    let value: String = row.get(index)?;
    Uuid::parse_str(&value).map_err(|error| {
        rusqlite::Error::FromSqlConversionFailure(index, Type::Text, Box::new(error))
    })
}

pub fn time_from_row(row: &Row<'_>, index: usize) -> rusqlite::Result<DateTime<Utc>> {
    let value: String = row.get(index)?;
    DateTime::parse_from_rfc3339(&value)
        .map(|value| value.with_timezone(&Utc))
        .map_err(|error| {
            rusqlite::Error::FromSqlConversionFailure(index, Type::Text, Box::new(error))
        })
}

pub fn optional_time_from_row(
    row: &Row<'_>,
    index: usize,
) -> rusqlite::Result<Option<DateTime<Utc>>> {
    let value: Option<String> = row.get(index)?;
    value
        .map(|value| {
            DateTime::parse_from_rfc3339(&value)
                .map(|value| value.with_timezone(&Utc))
                .map_err(|error| {
                    rusqlite::Error::FromSqlConversionFailure(index, Type::Text, Box::new(error))
                })
        })
        .transpose()
}

pub fn revision_error(actual: Option<i64>, expected: i64) -> ProductError {
    match actual {
        Some(actual) => ProductError::RevisionConflict { expected, actual },
        None => ProductError::NotFound,
    }
}
