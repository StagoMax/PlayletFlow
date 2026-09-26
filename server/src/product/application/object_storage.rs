use crate::product::domain::ProductResult;
use async_trait::async_trait;
use std::time::Duration;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ObjectWriteMode {
    Create,
    Upsert,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ObjectWriteOutcome {
    Stored,
    AlreadyExists,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct StoredObject {
    pub bytes: Vec<u8>,
    pub content_type: Option<String>,
}

#[async_trait]
pub trait ObjectStorage: Send + Sync {
    async fn get(&self, key: &str) -> ProductResult<Option<StoredObject>>;

    async fn put(
        &self,
        key: &str,
        content_type: &str,
        bytes: Vec<u8>,
        mode: ObjectWriteMode,
    ) -> ProductResult<ObjectWriteOutcome>;

    async fn signed_get_url(&self, key: &str, expires_in: Duration) -> ProductResult<String>;
}
