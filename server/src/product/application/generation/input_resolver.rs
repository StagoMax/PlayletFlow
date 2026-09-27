use super::GenerationInputResolver;
use crate::product::application::media::{MediaAccessProvider, MediaRepository};
use crate::product::domain::{
    GenerationInputRole, GenerationInputSelection, GenerationJob, MediaKind, MediaStatus,
    ProductError, ProductResult, ResolvedGenerationInput,
};
use std::sync::Arc;

#[derive(Clone)]
pub struct MediaGenerationInputResolver {
    media: Arc<dyn MediaRepository>,
    access: Arc<dyn MediaAccessProvider>,
}

impl MediaGenerationInputResolver {
    pub fn new(media: Arc<dyn MediaRepository>, access: Arc<dyn MediaAccessProvider>) -> Self {
        Self { media, access }
    }
}

#[async_trait::async_trait]
impl GenerationInputResolver for MediaGenerationInputResolver {
    async fn resolve(&self, job: &GenerationJob) -> ProductResult<Vec<ResolvedGenerationInput>> {
        let requested = match &job.spec.input {
            GenerationInputSelection::TextOnly => Vec::new(),
            GenerationInputSelection::FirstLastFrames {
                first_frame_media_id,
                last_frame_media_id,
            } => std::iter::once((*first_frame_media_id, GenerationInputRole::FirstFrame))
                .chain(
                    last_frame_media_id
                        .iter()
                        .map(|id| (*id, GenerationInputRole::LastFrame)),
                )
                .collect(),
            GenerationInputSelection::ReferenceImages { media_ids } => media_ids
                .iter()
                .map(|id| (*id, GenerationInputRole::ReferenceImage))
                .collect(),
        };

        let mut resolved = Vec::with_capacity(requested.len());
        for (media_id, role) in requested {
            let media = self
                .media
                .find_media(job.project_id, media_id)
                .await?
                .ok_or_else(|| {
                    ProductError::Validation("generation input media no longer exists".into())
                })?;
            if media.kind != MediaKind::Image || media.status != MediaStatus::Ready {
                return Err(ProductError::Validation(
                    "generation inputs must be ready images".into(),
                ));
            }
            let url = self.access.generation_input(&media).await?.ok_or_else(|| {
                ProductError::DependencyUnavailable(
                    "generation input media has no provider-readable URL".into(),
                )
            })?;
            if !url.starts_with("https://") && !url.starts_with("data:image/") {
                return Err(ProductError::DependencyUnavailable(
                    "generation input media must have an HTTPS URL or encoded image".into(),
                ));
            }
            resolved.push(ResolvedGenerationInput {
                media_id,
                role,
                url,
            });
        }
        Ok(resolved)
    }
}
