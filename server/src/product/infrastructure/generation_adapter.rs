use crate::product::application::generation::{
    GenerationPoll, GenerationProvider, GenerationRequest, GenerationSubmission,
};
use crate::product::domain::{GenerationJob, MediaKind, ProductError, ProductResult};
use async_trait::async_trait;

/// Safe default used until a real media generation provider is configured.
/// The worker interprets this dependency error as a deferral, so neither the
/// job attempt nor its outbox event is consumed.
#[derive(Clone, Debug, Default)]
pub struct WaitingForProviderAdapter;

#[async_trait]
impl GenerationProvider for WaitingForProviderAdapter {
    fn name(&self) -> &str {
        "unconfigured"
    }

    async fn submit(&self, _request: &GenerationRequest) -> ProductResult<GenerationSubmission> {
        Err(ProductError::DependencyUnavailable(
            "no generation provider is configured".into(),
        ))
    }

    async fn poll(&self, _job: &GenerationJob, _kind: MediaKind) -> ProductResult<GenerationPoll> {
        Err(ProductError::DependencyUnavailable(
            "no generation provider is configured".into(),
        ))
    }
}
