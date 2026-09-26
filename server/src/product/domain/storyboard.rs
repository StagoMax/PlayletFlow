use super::{ProductError, ProductResult, ProjectId, StoryboardId};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

pub const MAX_PROJECT_NAME_CHARS: usize = 200;
pub const MAX_STORYBOARD_NAME_CHARS: usize = 200;
pub const MAX_SCRIPT_CHARS: usize = 20_000;

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Project {
    pub id: ProjectId,
    pub name: String,
    pub revision: i64,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

impl Project {
    pub fn new(name: impl Into<String>, now: DateTime<Utc>) -> ProductResult<Self> {
        Ok(Self {
            id: ProjectId::new(),
            name: validate_name(name.into(), MAX_PROJECT_NAME_CHARS, "project")?,
            revision: 1,
            created_at: now,
            updated_at: now,
        })
    }
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Storyboard {
    pub id: StoryboardId,
    pub project_id: ProjectId,
    pub name: String,
    pub position: String,
    pub revision: i64,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
    pub deleted_at: Option<DateTime<Utc>>,
}

impl Storyboard {
    pub fn new(
        project_id: ProjectId,
        name: impl Into<String>,
        now: DateTime<Utc>,
    ) -> ProductResult<Self> {
        Ok(Self {
            id: StoryboardId::new(),
            project_id,
            name: validate_name(name.into(), MAX_STORYBOARD_NAME_CHARS, "storyboard")?,
            position: String::new(),
            revision: 1,
            created_at: now,
            updated_at: now,
            deleted_at: None,
        })
    }
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StoryboardScript {
    pub storyboard_id: StoryboardId,
    pub text: String,
    pub revision: i64,
    pub updated_at: DateTime<Utc>,
}

impl StoryboardScript {
    pub fn empty(storyboard_id: StoryboardId, now: DateTime<Utc>) -> Self {
        Self {
            storyboard_id,
            text: String::new(),
            revision: 1,
            updated_at: now,
        }
    }

    pub fn validate_text(text: String) -> ProductResult<String> {
        if text.chars().count() > MAX_SCRIPT_CHARS {
            return Err(ProductError::Validation(format!(
                "script exceeds {MAX_SCRIPT_CHARS} characters"
            )));
        }
        Ok(text)
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct StoryboardCatalogEntry {
    pub storyboard: Storyboard,
    pub pending_proposal_count: u64,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct StoryboardCounts {
    pub asset_bindings: u64,
    pub keyframes: u64,
    pub videos: u64,
}

#[derive(Clone, Debug, PartialEq)]
pub struct StoryboardSnapshot {
    pub entry: StoryboardCatalogEntry,
    pub script: StoryboardScript,
    pub counts: StoryboardCounts,
}

pub fn validate_name(value: String, max_chars: usize, field: &str) -> ProductResult<String> {
    let value = value.trim().to_owned();
    let length = value.chars().count();
    if length == 0 {
        return Err(ProductError::Validation(format!(
            "{field} name is required"
        )));
    }
    if length > max_chars {
        return Err(ProductError::Validation(format!(
            "{field} name exceeds {max_chars} characters"
        )));
    }
    Ok(value)
}
