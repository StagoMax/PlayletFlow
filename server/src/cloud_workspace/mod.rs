mod api;
pub(crate) use api::workspace_token;
mod tools;

pub use api::router;
pub use tools::{registry_for, scope_context};

use crate::product::infrastructure::{TosObjectStorage, TosObjectStorageConfig};
use anyhow::{anyhow, Context, Result};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::sync::Arc;
use uuid::Uuid;

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CloudDocument {
    pub snapshot: Value,
    #[serde(default)]
    pub proposals: Vec<Value>,
}

#[derive(Clone)]
pub struct VersionedDocument {
    pub document: CloudDocument,
    pub etag: String,
}

#[derive(Clone)]
pub struct CloudWorkspaceStore {
    storage: Arc<TosObjectStorage>,
}

impl CloudWorkspaceStore {
    pub fn from_env() -> Result<Self> {
        let config = TosObjectStorageConfig::from_env()?
            .context("cloud workspace requires configured TOS storage")?;
        Ok(Self {
            storage: Arc::new(TosObjectStorage::new(config)?),
        })
    }

    fn key(token: Uuid) -> String {
        let digest = Sha256::digest(token.as_bytes());
        format!("agent-workspaces/v1/{digest:x}.json")
    }

    pub async fn get(&self, token: Uuid) -> Result<Option<VersionedDocument>> {
        let Some((bytes, etag)) = self.storage.get_versioned(&Self::key(token)).await? else {
            return Ok(None);
        };
        if bytes.len() > 2_000_000 {
            return Err(anyhow!("workspace exceeds cloud document limit"));
        }
        Ok(Some(VersionedDocument {
            document: serde_json::from_slice(&bytes).context("decode cloud workspace")?,
            etag,
        }))
    }

    pub async fn replace_snapshot(
        &self,
        token: Uuid,
        snapshot: Value,
        expected_etag: Option<&str>,
    ) -> Result<Option<String>> {
        let current = self.get(token).await?;
        if current.as_ref().map(|value| value.etag.as_str()) != expected_etag {
            return Ok(None);
        }
        let document = CloudDocument {
            snapshot,
            proposals: current.map_or_else(Vec::new, |value| value.document.proposals),
        };
        self.put(token, &document, expected_etag).await
    }

    pub async fn mutate<T>(
        &self,
        token: Uuid,
        mut change: impl FnMut(&mut CloudDocument) -> Result<T>,
    ) -> Result<T> {
        for _ in 0..5 {
            let current = self
                .get(token)
                .await?
                .context("workspace has not been initialized")?;
            let mut document = current.document;
            let result = change(&mut document)?;
            if self
                .put(token, &document, Some(&current.etag))
                .await?
                .is_some()
            {
                return Ok(result);
            }
        }
        Err(anyhow!("workspace changed concurrently; please retry"))
    }

    async fn put(
        &self,
        token: Uuid,
        document: &CloudDocument,
        etag: Option<&str>,
    ) -> Result<Option<String>> {
        let bytes = serde_json::to_vec(document)?;
        if bytes.len() > 2_000_000 {
            return Err(anyhow!("workspace exceeds cloud document limit"));
        }
        Ok(self
            .storage
            .put_versioned(&Self::key(token), bytes, etag)
            .await?)
    }
}
