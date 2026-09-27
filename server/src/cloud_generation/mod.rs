mod api;
pub(crate) mod record;
pub(crate) mod service;

pub use api::router;

use crate::product::domain::{ProductError, ProductResult};
use crate::product::infrastructure::{TosObjectStorage, TosObjectStorageConfig};

pub async fn bootstrap_tos() -> ProductResult<()> {
    let config = TosObjectStorageConfig::from_env()?.ok_or_else(|| {
        ProductError::Validation(
            "TOS_ACCESS_KEY, TOS_SECRET_KEY, and TOS_BUCKET are required".into(),
        )
    })?;
    TosObjectStorage::new(config)?.ensure_bucket().await
}
