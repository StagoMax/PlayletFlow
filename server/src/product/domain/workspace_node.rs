use super::{validate_name, ProductError, ProductResult, ProjectId, StoryboardId};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

pub const MAX_WORKSPACE_NODE_NAME_CHARS: usize = 120;

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum WorkspaceNodeKind {
    Folder,
    Object,
}

impl WorkspaceNodeKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Folder => "folder",
            Self::Object => "object",
        }
    }

    pub fn parse(value: &str) -> ProductResult<Self> {
        match value {
            "folder" => Ok(Self::Folder),
            "object" => Ok(Self::Object),
            _ => Err(ProductError::Storage(format!(
                "unknown workspace node kind: {value}"
            ))),
        }
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum WorkspaceObjectType {
    Text,
    Image,
    Video,
}

impl WorkspaceObjectType {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Text => "text",
            Self::Image => "image",
            Self::Video => "video",
        }
    }

    pub fn parse(value: &str) -> ProductResult<Self> {
        match value {
            "text" => Ok(Self::Text),
            "image" => Ok(Self::Image),
            "video" => Ok(Self::Video),
            _ => Err(ProductError::Storage(format!(
                "unknown workspace object type: {value}"
            ))),
        }
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum WorkspaceTargetType {
    Script,
    Media,
    Empty,
}

impl WorkspaceTargetType {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Script => "script",
            Self::Media => "media",
            Self::Empty => "empty",
        }
    }

    pub fn parse(value: &str) -> ProductResult<Self> {
        match value {
            "script" => Ok(Self::Script),
            "media" => Ok(Self::Media),
            "empty" => Ok(Self::Empty),
            _ => Err(ProductError::Storage(format!(
                "unknown workspace target type: {value}"
            ))),
        }
    }
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceNode {
    pub id: String,
    pub project_id: ProjectId,
    pub storyboard_id: StoryboardId,
    pub parent_id: Option<String>,
    pub kind: WorkspaceNodeKind,
    pub name: String,
    pub object_type: Option<WorkspaceObjectType>,
    pub target_type: Option<WorkspaceTargetType>,
    pub target_id: Option<String>,
    pub position: String,
    pub revision: i64,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
    #[serde(default)]
    pub unseen_update_at: Option<DateTime<Utc>>,
}

impl WorkspaceNode {
    pub fn folder(
        project_id: ProjectId,
        storyboard_id: StoryboardId,
        parent_id: Option<String>,
        name: String,
        now: DateTime<Utc>,
    ) -> ProductResult<Self> {
        Ok(Self {
            id: uuid::Uuid::new_v4().to_string(),
            project_id,
            storyboard_id,
            parent_id,
            kind: WorkspaceNodeKind::Folder,
            name: validate_name(name, MAX_WORKSPACE_NODE_NAME_CHARS, "workspace node")?,
            object_type: None,
            target_type: None,
            target_id: None,
            position: String::new(),
            revision: 1,
            created_at: now,
            updated_at: now,
            unseen_update_at: None,
        })
    }

    pub fn object(
        project_id: ProjectId,
        storyboard_id: StoryboardId,
        parent_id: Option<String>,
        name: String,
        object_type: WorkspaceObjectType,
        now: DateTime<Utc>,
    ) -> ProductResult<Self> {
        Ok(Self {
            id: uuid::Uuid::new_v4().to_string(),
            project_id,
            storyboard_id,
            parent_id,
            kind: WorkspaceNodeKind::Object,
            name: validate_name(name, MAX_WORKSPACE_NODE_NAME_CHARS, "workspace node")?,
            object_type: Some(object_type),
            target_type: Some(WorkspaceTargetType::Empty),
            target_id: None,
            position: String::new(),
            revision: 1,
            created_at: now,
            updated_at: now,
            unseen_update_at: None,
        })
    }

    pub fn media_object(
        project_id: ProjectId,
        storyboard_id: StoryboardId,
        parent_id: Option<String>,
        name: String,
        object_type: WorkspaceObjectType,
        now: DateTime<Utc>,
    ) -> ProductResult<Self> {
        if object_type == WorkspaceObjectType::Text {
            return Err(ProductError::Validation(
                "a prompted media object must be an image or video".to_owned(),
            ));
        }
        let id = uuid::Uuid::new_v4().to_string();
        Ok(Self {
            id: id.clone(),
            project_id,
            storyboard_id,
            parent_id,
            kind: WorkspaceNodeKind::Object,
            name: validate_name(name, MAX_WORKSPACE_NODE_NAME_CHARS, "workspace node")?,
            object_type: Some(object_type),
            target_type: Some(WorkspaceTargetType::Media),
            target_id: Some(id),
            position: String::new(),
            revision: 1,
            created_at: now,
            updated_at: now,
            unseen_update_at: None,
        })
    }
}
