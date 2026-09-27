use crate::product::application::generation::{
    GeneratedMediaStore, GenerationOutput, StoredGenerationOutput,
};
use crate::product::application::media::{MediaAccessGrant, MediaAccessProvider};
use crate::product::domain::{
    GenerationJobId, MediaId, MediaItem, MediaKind, ProductError, ProductResult,
};
use async_trait::async_trait;
use base64::{engine::general_purpose::STANDARD, Engine as _};
use futures_util::StreamExt;
use reqwest::Client;
use std::path::{Path, PathBuf};
use tokio::io::AsyncWriteExt;

const MAX_GENERATED_MEDIA_BYTES: u64 = 512 * 1024 * 1024;
const GENERATED_PREFIX: &str = "generated";
const UPLOADED_PREFIX: &str = "uploaded";

/// Safe default for installations that have not configured object storage yet.
///
/// Metadata APIs remain usable, while access fields stay `null` instead of
/// exposing internal object keys or inventing URLs that cannot be fetched.
/// Replace this adapter at the composition root when an object store is added.
#[derive(Clone, Debug, Default)]
pub struct MetadataOnlyMediaAccessProvider;

#[async_trait]
impl MediaAccessProvider for MetadataOnlyMediaAccessProvider {
    async fn thumbnail(&self, _media: &MediaItem) -> ProductResult<Option<MediaAccessGrant>> {
        Ok(None)
    }

    async fn preview(&self, _media: &MediaItem) -> ProductResult<Option<MediaAccessGrant>> {
        Ok(None)
    }
}

/// Local development implementation of both the generated-media sink and the
/// read-side access provider. Production deployments should replace this with
/// an object-store adapter while keeping the same application ports.
#[derive(Clone)]
pub struct LocalMediaStore {
    root: PathBuf,
    client: Client,
}

impl LocalMediaStore {
    pub fn new(root: impl AsRef<Path>) -> ProductResult<Self> {
        let root = root.as_ref().to_path_buf();
        std::fs::create_dir_all(root.join(GENERATED_PREFIX))
            .map_err(|error| ProductError::Storage(error.to_string()))?;
        std::fs::create_dir_all(root.join(UPLOADED_PREFIX))
            .map_err(|error| ProductError::Storage(error.to_string()))?;
        let client = Client::builder()
            .connect_timeout(std::time::Duration::from_secs(15))
            .timeout(std::time::Duration::from_secs(30 * 60))
            .build()
            .map_err(|error| ProductError::External(error.to_string()))?;
        Ok(Self { root, client })
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    pub async fn store_upload(&self, bytes: &[u8], mime_type: &str) -> ProductResult<String> {
        let extension = media_extension(mime_type)?;
        let object_key = format!("{UPLOADED_PREFIX}/{}.{}", uuid::Uuid::new_v4(), extension);
        tokio::fs::write(self.root.join(&object_key), bytes)
            .await
            .map_err(|error| ProductError::Storage(error.to_string()))?;
        Ok(object_key)
    }

    pub async fn store_generation_input(
        &self,
        media_id: MediaId,
        bytes: &[u8],
        mime_type: &str,
    ) -> ProductResult<String> {
        let extension = media_extension(mime_type)?;
        let object_key = format!("{UPLOADED_PREFIX}/{media_id}.{extension}");
        let path = self.root.join(&object_key);
        match tokio::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&path)
            .await
        {
            Ok(mut file) => file
                .write_all(bytes)
                .await
                .map_err(|error| ProductError::Storage(error.to_string()))?,
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
                let existing = tokio::fs::read(&path)
                    .await
                    .map_err(|error| ProductError::Storage(error.to_string()))?;
                if existing != bytes {
                    return Err(ProductError::Validation(
                        "generation input ID is already in use".into(),
                    ));
                }
            }
            Err(error) => return Err(ProductError::Storage(error.to_string())),
        }
        Ok(object_key)
    }

    async fn generation_input_url(&self, media: &MediaItem) -> ProductResult<Option<String>> {
        let Some(key) = media
            .source_object_key
            .as_deref()
            .filter(|key| safe_media_key(key))
        else {
            return Ok(None);
        };
        let bytes = tokio::fs::read(self.root.join(key))
            .await
            .map_err(|error| ProductError::Storage(error.to_string()))?;
        if bytes.is_empty() || bytes.len() > 8 * 1024 * 1024 {
            return Err(ProductError::Validation(
                "generation input must be between 1 byte and 8 MB".into(),
            ));
        }
        Ok(Some(format!(
            "data:{};base64,{}",
            media.mime_type,
            STANDARD.encode(bytes)
        )))
    }

    fn access(&self, media: &MediaItem) -> Option<MediaAccessGrant> {
        let key = media.source_object_key.as_deref()?;
        if !safe_media_key(key) {
            return None;
        }
        Some(MediaAccessGrant {
            url: format!("/api/v1/media-files/{key}"),
            expires_at: None,
            width: media.width?,
            height: media.height?,
            mime_type: media.mime_type.clone(),
        })
    }
}

#[async_trait]
impl GeneratedMediaStore for LocalMediaStore {
    async fn store(
        &self,
        job_id: GenerationJobId,
        output: &GenerationOutput,
    ) -> ProductResult<StoredGenerationOutput> {
        let extension = media_extension(&output.mime_type)?;
        let object_key = format!("{GENERATED_PREFIX}/{job_id}.{extension}");
        let destination = self.root.join(&object_key);
        if !destination.exists() {
            let response = self
                .client
                .get(&output.url)
                .send()
                .await
                .map_err(|error| ProductError::DependencyUnavailable(error.to_string()))?;
            if !response.status().is_success() {
                return Err(ProductError::DependencyUnavailable(format!(
                    "generated media download returned HTTP {}",
                    response.status()
                )));
            }
            if response
                .content_length()
                .is_some_and(|length| length > MAX_GENERATED_MEDIA_BYTES)
            {
                return Err(ProductError::External(
                    "generated media exceeds the storage size limit".into(),
                ));
            }
            let temporary =
                destination.with_extension(format!("{extension}.{}.part", uuid::Uuid::new_v4()));
            let mut file = tokio::fs::File::create(&temporary)
                .await
                .map_err(|error| ProductError::Storage(error.to_string()))?;
            let mut received = 0_u64;
            let mut stream = response.bytes_stream();
            while let Some(chunk) = stream.next().await {
                let chunk = chunk
                    .map_err(|error| ProductError::DependencyUnavailable(error.to_string()))?;
                received = received.saturating_add(chunk.len() as u64);
                if received > MAX_GENERATED_MEDIA_BYTES {
                    let _ = tokio::fs::remove_file(&temporary).await;
                    return Err(ProductError::External(
                        "generated media exceeds the storage size limit".into(),
                    ));
                }
                file.write_all(&chunk)
                    .await
                    .map_err(|error| ProductError::Storage(error.to_string()))?;
            }
            file.flush()
                .await
                .map_err(|error| ProductError::Storage(error.to_string()))?;
            drop(file);
            if let Err(error) = tokio::fs::rename(&temporary, &destination).await {
                if destination.exists() {
                    let _ = tokio::fs::remove_file(&temporary).await;
                } else {
                    return Err(ProductError::Storage(error.to_string()));
                }
            }
        }
        Ok(StoredGenerationOutput {
            object_key,
            kind: output.kind,
            mime_type: output.mime_type.clone(),
            width: output.width,
            height: output.height,
            duration_ms: output.duration_ms,
        })
    }
}

#[async_trait]
impl MediaAccessProvider for LocalMediaStore {
    async fn thumbnail(&self, media: &MediaItem) -> ProductResult<Option<MediaAccessGrant>> {
        Ok((media.kind == MediaKind::Image)
            .then(|| self.access(media))
            .flatten())
    }

    async fn preview(&self, media: &MediaItem) -> ProductResult<Option<MediaAccessGrant>> {
        Ok(self.access(media))
    }

    async fn generation_input(&self, media: &MediaItem) -> ProductResult<Option<String>> {
        self.generation_input_url(media).await
    }
}

fn safe_media_key(key: &str) -> bool {
    let mut parts = key.split('/');
    matches!(parts.next(), Some(GENERATED_PREFIX | UPLOADED_PREFIX))
        && parts
            .next()
            .is_some_and(|name| !name.is_empty() && !name.contains(['/', '\\']))
        && parts.next().is_none()
}

fn media_extension(mime_type: &str) -> ProductResult<&'static str> {
    match mime_type {
        "image/jpeg" => Ok("jpg"),
        "image/png" => Ok("png"),
        "image/webp" => Ok("webp"),
        "video/mp4" => Ok("mp4"),
        "video/quicktime" => Ok("mov"),
        _ => Err(ProductError::Validation(format!(
            "unsupported generated media type: {mime_type}"
        ))),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn generated_keys_cannot_escape_the_media_root() {
        assert!(safe_media_key("generated/job.mp4"));
        assert!(safe_media_key("uploaded/file.png"));
        assert!(!safe_media_key("../secret"));
        assert!(!safe_media_key("generated/nested/file.mp4"));
        assert!(!safe_media_key("private/source"));
    }
}
