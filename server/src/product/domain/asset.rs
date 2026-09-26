use super::{
    validate_name, Asset, AssetBinding, AssetBindingId, AssetId, AssetKind, AssetRepresentation,
    AssetRepresentationId, AssetSection, AssetSectionId, AssetViewKind, MediaId, ProductError,
    ProductResult, ProjectId, StoryboardId,
};
use chrono::{DateTime, Utc};
use std::str::FromStr;

pub const MAX_ASSET_NAME_CHARS: usize = 200;
pub const MAX_SECTION_NAME_CHARS: usize = 120;
pub const MAX_REPRESENTATION_LABEL_CHARS: usize = 120;
pub const MAX_ASSET_DESCRIPTION_CHARS: usize = 2_000;
pub const MAX_PROMPT_CHARS: usize = 10_000;

impl AssetKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Character => "character",
            Self::Scene => "scene",
            Self::Prop => "prop",
            Self::Custom => "custom",
        }
    }
}

impl FromStr for AssetKind {
    type Err = ProductError;

    fn from_str(value: &str) -> ProductResult<Self> {
        match value {
            "character" => Ok(Self::Character),
            "scene" => Ok(Self::Scene),
            "prop" => Ok(Self::Prop),
            "custom" => Ok(Self::Custom),
            _ => Err(ProductError::Storage(format!(
                "unknown asset kind in storage: {value}"
            ))),
        }
    }
}

impl AssetViewKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Front => "front",
            Self::Back => "back",
            Self::Side => "side",
            Self::Top => "top",
            Self::ThreeView => "threeView",
            Self::Custom => "custom",
        }
    }
}

impl FromStr for AssetViewKind {
    type Err = ProductError;

    fn from_str(value: &str) -> ProductResult<Self> {
        match value {
            "front" => Ok(Self::Front),
            "back" => Ok(Self::Back),
            "side" => Ok(Self::Side),
            "top" => Ok(Self::Top),
            "threeView" => Ok(Self::ThreeView),
            "custom" => Ok(Self::Custom),
            _ => Err(ProductError::Storage(format!(
                "unknown asset view kind in storage: {value}"
            ))),
        }
    }
}

impl Asset {
    pub fn new(
        project_id: ProjectId,
        kind: AssetKind,
        name: String,
        description: Option<String>,
        canonical_prompt: Option<String>,
        now: DateTime<Utc>,
    ) -> ProductResult<Self> {
        Ok(Self {
            id: AssetId::new(),
            project_id,
            kind,
            name: validate_name(name, MAX_ASSET_NAME_CHARS, "asset")?,
            description: validate_optional_text(
                description,
                MAX_ASSET_DESCRIPTION_CHARS,
                "asset description",
            )?,
            canonical_prompt: validate_optional_text(
                canonical_prompt,
                MAX_PROMPT_CHARS,
                "asset prompt",
            )?,
            revision: 1,
            representations: Vec::new(),
            created_at: now,
            updated_at: now,
            deleted_at: None,
        })
    }
}

impl AssetSection {
    pub fn new(
        project_id: ProjectId,
        storyboard_id: StoryboardId,
        parent_id: Option<AssetSectionId>,
        name: String,
        kind: AssetKind,
    ) -> ProductResult<Self> {
        Ok(Self {
            id: AssetSectionId::new(),
            project_id,
            storyboard_id,
            parent_id,
            name: validate_name(name, MAX_SECTION_NAME_CHARS, "asset section")?,
            kind,
            position: String::new(),
            revision: 1,
        })
    }
}

impl AssetRepresentation {
    pub fn new(
        asset_id: AssetId,
        label: String,
        view_kind: AssetViewKind,
        media_id: Option<MediaId>,
    ) -> ProductResult<Self> {
        Ok(Self {
            id: AssetRepresentationId::new(),
            asset_id,
            label: validate_name(
                label,
                MAX_REPRESENTATION_LABEL_CHARS,
                "asset representation",
            )?,
            view_kind,
            media_id,
            position: String::new(),
        })
    }
}

impl AssetBinding {
    pub fn new(
        project_id: ProjectId,
        storyboard_id: StoryboardId,
        section_id: AssetSectionId,
        asset_id: AssetId,
        now: DateTime<Utc>,
    ) -> Self {
        Self {
            id: AssetBindingId::new(),
            project_id,
            storyboard_id,
            section_id,
            asset_id,
            position: String::new(),
            prompt_override: None,
            derived_media_id: None,
            revision: 1,
            created_at: now,
            updated_at: now,
        }
    }
}

pub fn validate_optional_text(
    value: Option<String>,
    max_chars: usize,
    field: &str,
) -> ProductResult<Option<String>> {
    let Some(value) = value else {
        return Ok(None);
    };
    let value = value.trim().to_owned();
    if value.is_empty() {
        return Ok(None);
    }
    if value.chars().count() > max_chars {
        return Err(ProductError::Validation(format!(
            "{field} exceeds {max_chars} characters"
        )));
    }
    Ok(Some(value))
}

pub fn validate_revision(revision: i64) -> ProductResult<i64> {
    if revision < 1 {
        return Err(ProductError::Validation(
            "expectedRevision must be at least 1".to_owned(),
        ));
    }
    Ok(revision)
}
