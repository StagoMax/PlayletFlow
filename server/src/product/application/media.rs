use crate::product::domain::{
    MediaId, MediaItem, MediaRole, ProductError, ProductResult, ProjectId, StoryboardId,
};
use async_trait::async_trait;
use chrono::{DateTime, Utc};
use std::sync::Arc;
use uuid::Uuid;

pub const DEFAULT_MEDIA_PAGE_SIZE: usize = 50;
pub const MAX_MEDIA_PAGE_SIZE: usize = 100;

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct MediaCursor {
    pub created_at: DateTime<Utc>,
    pub id: MediaId,
}

impl MediaCursor {
    pub fn encode(&self) -> String {
        format!("{}|{}", self.created_at.to_rfc3339(), self.id)
    }

    pub fn decode(value: &str) -> ProductResult<Self> {
        let (created_at, id) = value
            .split_once('|')
            .ok_or_else(|| ProductError::Validation("invalid media cursor".into()))?;
        let created_at = DateTime::parse_from_rfc3339(created_at)
            .map_err(|_| ProductError::Validation("invalid media cursor".into()))?
            .with_timezone(&Utc);
        let id = Uuid::parse_str(id)
            .map(MediaId)
            .map_err(|_| ProductError::Validation("invalid media cursor".into()))?;
        Ok(Self { created_at, id })
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct MediaListQuery {
    pub project_id: ProjectId,
    pub storyboard_id: StoryboardId,
    pub roles: Vec<MediaRole>,
    pub cursor: Option<MediaCursor>,
    pub limit: usize,
}

#[derive(Clone, Debug, PartialEq)]
pub struct MediaPage {
    pub items: Vec<MediaItem>,
    pub next_cursor: Option<String>,
    pub total: usize,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct UpdateMediaMetadata {
    pub project_id: ProjectId,
    pub media_id: MediaId,
    pub name: String,
    pub prompt: Option<String>,
    pub expected_revision: i64,
}

#[async_trait]
pub trait MediaRepository: Send + Sync {
    async fn find_media(
        &self,
        project_id: ProjectId,
        id: MediaId,
    ) -> ProductResult<Option<MediaItem>>;
    async fn list_storyboard_media(&self, query: &MediaListQuery) -> ProductResult<MediaPage>;
    async fn insert_media(&self, media: &MediaItem) -> ProductResult<()>;
    async fn update_media_metadata(&self, update: &UpdateMediaMetadata)
        -> ProductResult<MediaItem>;
    async fn soft_delete_storyboard_media(
        &self,
        project_id: ProjectId,
        media_id: MediaId,
        expected_revision: i64,
    ) -> ProductResult<()>;
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct MediaAccessGrant {
    pub url: String,
    pub expires_at: Option<DateTime<Utc>>,
    pub width: i64,
    pub height: i64,
    pub mime_type: String,
}

#[async_trait]
pub trait MediaAccessProvider: Send + Sync {
    async fn thumbnail(&self, media: &MediaItem) -> ProductResult<Option<MediaAccessGrant>>;
    async fn preview(&self, media: &MediaItem) -> ProductResult<Option<MediaAccessGrant>>;
    async fn generation_input(&self, media: &MediaItem) -> ProductResult<Option<String>> {
        Ok(self.preview(media).await?.map(|grant| grant.url))
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct MediaPresentation {
    pub media: MediaItem,
    pub thumbnail: Option<MediaAccessGrant>,
    pub preview: Option<MediaAccessGrant>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct MediaPresentationPage {
    pub items: Vec<MediaPresentation>,
    pub next_cursor: Option<String>,
    pub total: usize,
}

#[derive(Clone)]
pub struct MediaCatalogService {
    repository: Arc<dyn MediaRepository>,
    access: Arc<dyn MediaAccessProvider>,
}

impl MediaCatalogService {
    pub fn new(repository: Arc<dyn MediaRepository>, access: Arc<dyn MediaAccessProvider>) -> Self {
        Self { repository, access }
    }

    pub async fn list(&self, query: MediaListQuery) -> ProductResult<MediaPresentationPage> {
        if query.limit == 0 || query.limit > MAX_MEDIA_PAGE_SIZE {
            return Err(ProductError::Validation(format!(
                "media page size must be between 1 and {MAX_MEDIA_PAGE_SIZE}"
            )));
        }
        let page = self.repository.list_storyboard_media(&query).await?;
        let mut items = Vec::with_capacity(page.items.len());
        for media in page.items {
            let thumbnail = validate_access_grant(self.access.thumbnail(&media).await?)?;
            items.push(MediaPresentation {
                media,
                thumbnail,
                preview: None,
            });
        }
        Ok(MediaPresentationPage {
            items,
            next_cursor: page.next_cursor,
            total: page.total,
        })
    }

    pub async fn get(
        &self,
        project_id: ProjectId,
        media_id: MediaId,
    ) -> ProductResult<MediaPresentation> {
        let media = self
            .repository
            .find_media(project_id, media_id)
            .await?
            .ok_or(ProductError::NotFound)?;
        self.present_with_preview(media).await
    }

    pub async fn update(
        &self,
        mut update: UpdateMediaMetadata,
    ) -> ProductResult<MediaPresentation> {
        update.name = update.name.trim().to_owned();
        validate_update(&update)?;
        let media = self.repository.update_media_metadata(&update).await?;
        self.present_with_preview(media).await
    }

    pub async fn delete(
        &self,
        project_id: ProjectId,
        media_id: MediaId,
        expected_revision: i64,
    ) -> ProductResult<()> {
        if expected_revision < 1 {
            return Err(ProductError::Validation(
                "expectedRevision must be at least 1".into(),
            ));
        }
        self.repository
            .soft_delete_storyboard_media(project_id, media_id, expected_revision)
            .await
    }

    pub async fn refresh_access(
        &self,
        project_id: ProjectId,
        media_id: MediaId,
    ) -> ProductResult<MediaPresentation> {
        self.get(project_id, media_id).await
    }

    async fn present_with_preview(&self, media: MediaItem) -> ProductResult<MediaPresentation> {
        let thumbnail = validate_access_grant(self.access.thumbnail(&media).await?)?;
        let preview = validate_access_grant(self.access.preview(&media).await?)?;
        Ok(MediaPresentation {
            media,
            thumbnail,
            preview,
        })
    }
}

fn validate_access_grant(
    grant: Option<MediaAccessGrant>,
) -> ProductResult<Option<MediaAccessGrant>> {
    if grant.as_ref().is_some_and(|grant| {
        grant.url.trim().is_empty()
            || grant.width < 1
            || grant.height < 1
            || grant.mime_type.trim().is_empty()
    }) {
        return Err(ProductError::External(
            "media access provider returned invalid metadata".into(),
        ));
    }
    Ok(grant)
}

fn validate_update(update: &UpdateMediaMetadata) -> ProductResult<()> {
    if update.name.is_empty() || update.name.chars().count() > 200 {
        return Err(ProductError::Validation(
            "name must contain 1 to 200 characters".into(),
        ));
    }
    if update
        .prompt
        .as_ref()
        .is_some_and(|prompt| prompt.chars().count() > 10_000)
    {
        return Err(ProductError::Validation(
            "prompt must contain at most 10000 characters".into(),
        ));
    }
    if update.expected_revision < 1 {
        return Err(ProductError::Validation(
            "expectedRevision must be at least 1".into(),
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cursor_round_trips() {
        let cursor = MediaCursor {
            created_at: DateTime::parse_from_rfc3339("2026-09-26T10:00:00Z")
                .unwrap()
                .with_timezone(&Utc),
            id: MediaId(Uuid::new_v4()),
        };
        assert_eq!(MediaCursor::decode(&cursor.encode()).unwrap(), cursor);
        assert!(MediaCursor::decode("broken").is_err());
    }

    #[test]
    fn update_validation_rejects_empty_names_and_invalid_revision() {
        let base = UpdateMediaMetadata {
            project_id: ProjectId(Uuid::new_v4()),
            media_id: MediaId(Uuid::new_v4()),
            name: String::new(),
            prompt: None,
            expected_revision: 1,
        };
        assert!(validate_update(&base).is_err());
        assert!(validate_update(&UpdateMediaMetadata {
            name: "frame".into(),
            expected_revision: 0,
            ..base
        })
        .is_err());
    }
}
