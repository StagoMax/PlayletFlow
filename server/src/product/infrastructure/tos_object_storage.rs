use crate::product::application::generation::{
    GeneratedMediaStore, GenerationOutput, StoredGenerationOutput,
};
use crate::product::application::object_storage::{
    ObjectStorage, ObjectWriteMode, ObjectWriteOutcome, StoredObject,
};
use crate::product::domain::{GenerationJobId, ProductError, ProductResult};
use async_trait::async_trait;
use futures_util::future::BoxFuture;
use std::future::Future;
use std::sync::Arc;
use std::time::Duration;
use tokio::runtime::Handle;
use ve_tos_rust_sdk::asynchronous::auth::SignerAPI;
use ve_tos_rust_sdk::asynchronous::bucket::BucketAPI;
use ve_tos_rust_sdk::asynchronous::object::{ObjectAPI, ObjectContent};
use ve_tos_rust_sdk::asynchronous::tos::{self, AsyncRuntime, TosClientImpl};
use ve_tos_rust_sdk::auth::PreSignedURLInput;
use ve_tos_rust_sdk::bucket::{
    CORSRule, CreateBucketInput, DoesBucketExistInput, PutBucketCORSInput,
};
use ve_tos_rust_sdk::credential::{CommonCredentials, CommonCredentialsProvider};
use ve_tos_rust_sdk::enumeration::ACLType;
use ve_tos_rust_sdk::error::TosError;
use ve_tos_rust_sdk::object::{GetObjectInput, PutObjectFromBufferInput};

const DEFAULT_MAX_DOWNLOAD_BYTES: usize = 512 * 1024 * 1024;

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TosObjectStorageConfig {
    pub access_key: String,
    pub secret_key: String,
    pub region: String,
    pub endpoint: String,
    pub bucket: String,
    pub max_download_bytes: usize,
}

impl TosObjectStorageConfig {
    pub fn from_env() -> ProductResult<Option<Self>> {
        let access_key = optional_env("TOS_ACCESS_KEY");
        let secret_key = optional_env("TOS_SECRET_KEY");
        let bucket = optional_env("TOS_BUCKET");
        if access_key.is_none() && secret_key.is_none() && bucket.is_none() {
            return Ok(None);
        }
        let access_key = required(access_key, "TOS_ACCESS_KEY")?;
        let secret_key = required(secret_key, "TOS_SECRET_KEY")?;
        let bucket = required(bucket, "TOS_BUCKET")?;
        let region = optional_env("TOS_REGION").unwrap_or_else(|| "cn-beijing".into());
        let endpoint = optional_env("TOS_ENDPOINT")
            .unwrap_or_else(|| format!("https://tos-{region}.volces.com"));
        let endpoint = if endpoint.starts_with("http://") || endpoint.starts_with("https://") {
            endpoint
        } else {
            format!("https://{endpoint}")
        };
        let max_download_bytes = optional_env("VIDEOFLOW_GENERATION_MAX_DOWNLOAD_BYTES")
            .map(|value| {
                value.parse::<usize>().map_err(|_| {
                    ProductError::Validation(
                        "VIDEOFLOW_GENERATION_MAX_DOWNLOAD_BYTES must be a positive integer".into(),
                    )
                })
            })
            .transpose()?
            .unwrap_or(DEFAULT_MAX_DOWNLOAD_BYTES);
        if max_download_bytes == 0 {
            return Err(ProductError::Validation(
                "VIDEOFLOW_GENERATION_MAX_DOWNLOAD_BYTES must be positive".into(),
            ));
        }
        Ok(Some(Self {
            access_key,
            secret_key,
            region,
            endpoint,
            bucket,
            max_download_bytes,
        }))
    }
}

fn optional_env(name: &str) -> Option<String> {
    std::env::var(name)
        .ok()
        .map(|value| value.trim().to_owned())
        .filter(|value| !value.is_empty())
}

fn required(value: Option<String>, name: &str) -> ProductResult<String> {
    value.ok_or_else(|| ProductError::Validation(format!("{name} is required when TOS is enabled")))
}

#[derive(Debug, Default)]
struct TokioRuntime;

#[async_trait]
impl AsyncRuntime for TokioRuntime {
    type JoinError = tokio::task::JoinError;

    async fn sleep(&self, duration: Duration) {
        tokio::time::sleep(duration).await;
    }

    fn spawn<'a, F>(&self, future: F) -> BoxFuture<'a, Result<F::Output, Self::JoinError>>
    where
        F: Future + Send + 'static,
        F::Output: Send + 'static,
    {
        Box::pin(Handle::current().spawn(future))
    }

    fn block_on<F: Future>(&self, future: F) -> F::Output {
        Handle::current().block_on(future)
    }
}

type Client =
    TosClientImpl<CommonCredentialsProvider<CommonCredentials>, CommonCredentials, TokioRuntime>;

#[derive(Clone)]
pub struct TosObjectStorage {
    client: Arc<Client>,
    download_client: reqwest::Client,
    bucket: Arc<str>,
    max_download_bytes: usize,
}

impl TosObjectStorage {
    pub fn new(config: TosObjectStorageConfig) -> ProductResult<Self> {
        let client = tos::builder::<TokioRuntime>()
            .connection_timeout(10_000)
            .request_timeout(120_000)
            .max_retry_count(3)
            .ak(config.access_key)
            .sk(config.secret_key)
            .region(config.region)
            .endpoint(config.endpoint)
            .build()
            .map_err(|error| map_tos(error, "initialize TOS client"))?;
        let download_client = reqwest::Client::builder()
            .connect_timeout(Duration::from_secs(15))
            .timeout(Duration::from_secs(300))
            .build()
            .map_err(|error| ProductError::External(format!("build media client: {error}")))?;
        Ok(Self {
            client: Arc::new(client),
            download_client,
            bucket: config.bucket.into(),
            max_download_bytes: config.max_download_bytes,
        })
    }

    pub async fn ensure_bucket(&self) -> ProductResult<()> {
        // TOS deliberately returns either 404 or 403 when a bucket is absent or
        // inaccessible. A 403 therefore cannot answer the existence question;
        // a create attempt gives us the precise permission/name error instead.
        let needs_create = match self
            .client
            .does_bucket_exist(&DoesBucketExistInput::new(self.bucket.as_ref()))
            .await
        {
            Ok(exists) => !exists,
            Err(error) if is_status(&error, 403) => true,
            Err(error) => return Err(map_tos(error, "check TOS bucket")),
        };
        if needs_create {
            let mut input = CreateBucketInput::new(self.bucket.as_ref());
            input.set_acl(ACLType::ACLPrivate);
            self.client
                .create_bucket(&input)
                .await
                .map_err(|error| map_tos(error, "create TOS bucket"))?;
        }

        let mut rule = CORSRule::new();
        rule.set_allowed_origins(vec!["*".into()]);
        rule.set_allowed_methods(vec!["GET".into(), "HEAD".into()]);
        rule.set_allowed_headers(vec!["*".into()]);
        rule.set_expose_headers(vec!["ETag".into(), "x-tos-request-id".into()]);
        rule.set_max_age_seconds(3_600);
        self.client
            .put_bucket_cors(&PutBucketCORSInput::new_with_rules(
                self.bucket.as_ref(),
                vec![rule],
            ))
            .await
            .map_err(|error| map_tos(error, "configure TOS bucket CORS"))?;
        Ok(())
    }

    fn output_key(job_id: GenerationJobId, mime_type: &str) -> String {
        format!("outputs/{job_id}/result.{}", extension(mime_type))
    }
}

#[async_trait]
impl ObjectStorage for TosObjectStorage {
    async fn get(&self, key: &str) -> ProductResult<Option<StoredObject>> {
        validate_key(key)?;
        let result = self
            .client
            .get_object(&GetObjectInput::new(self.bucket.as_ref(), key))
            .await;
        let mut output = match result {
            Ok(output) => output,
            Err(error) if is_status(&error, 404) => return Ok(None),
            Err(error) => return Err(map_tos(error, "read TOS object")),
        };
        let content_type =
            (!output.content_type().is_empty()).then(|| output.content_type().to_owned());
        let bytes = output
            .read_all()
            .await
            .map_err(|error| map_tos(error, "read TOS object body"))?;
        Ok(Some(StoredObject {
            bytes,
            content_type,
        }))
    }

    async fn put(
        &self,
        key: &str,
        content_type: &str,
        bytes: Vec<u8>,
        mode: ObjectWriteMode,
    ) -> ProductResult<ObjectWriteOutcome> {
        validate_key(key)?;
        let mut input =
            PutObjectFromBufferInput::new_with_content(self.bucket.as_ref(), key, bytes);
        input.set_content_type(content_type);
        if mode == ObjectWriteMode::Create {
            input.set_forbid_overwrite(true);
        }
        match self.client.put_object_from_buffer(&input).await {
            Ok(_) => Ok(ObjectWriteOutcome::Stored),
            Err(error) if mode == ObjectWriteMode::Create && is_conflict(&error) => {
                Ok(ObjectWriteOutcome::AlreadyExists)
            }
            Err(error) => Err(map_tos(error, "write TOS object")),
        }
    }

    async fn signed_get_url(&self, key: &str, expires_in: Duration) -> ProductResult<String> {
        validate_key(key)?;
        let mut input = PreSignedURLInput::new_with_key(self.bucket.as_ref(), key);
        input.set_expires(expires_in.as_secs().clamp(1, 604_800) as i64);
        self.client
            .pre_signed_url(&input)
            .await
            .map(|output| output.signed_url().to_owned())
            .map_err(|error| map_tos(error, "sign TOS object URL"))
    }
}

#[async_trait]
impl GeneratedMediaStore for TosObjectStorage {
    async fn store(
        &self,
        job_id: GenerationJobId,
        output: &GenerationOutput,
    ) -> ProductResult<StoredGenerationOutput> {
        let response = self
            .download_client
            .get(&output.url)
            .send()
            .await
            .map_err(|error| {
                ProductError::DependencyUnavailable(format!(
                    "download generated media failed: {error}"
                ))
            })?;
        if !response.status().is_success() {
            return Err(ProductError::DependencyUnavailable(format!(
                "download generated media returned HTTP {}",
                response.status()
            )));
        }
        if response
            .content_length()
            .is_some_and(|size| size > self.max_download_bytes as u64)
        {
            return Err(ProductError::External(
                "generated media exceeds the configured storage limit".into(),
            ));
        }
        let bytes = response.bytes().await.map_err(|error| {
            ProductError::DependencyUnavailable(format!("read generated media failed: {error}"))
        })?;
        if bytes.len() > self.max_download_bytes {
            return Err(ProductError::External(
                "generated media exceeds the configured storage limit".into(),
            ));
        }
        let object_key = Self::output_key(job_id, &output.mime_type);
        self.put(
            &object_key,
            &output.mime_type,
            bytes.to_vec(),
            ObjectWriteMode::Upsert,
        )
        .await?;
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

fn validate_key(key: &str) -> ProductResult<()> {
    if key.is_empty()
        || key.starts_with('/')
        || key.contains("\\")
        || key
            .split('/')
            .any(|segment| segment.is_empty() || segment == "..")
    {
        return Err(ProductError::Validation("invalid object key".into()));
    }
    Ok(())
}

fn extension(mime_type: &str) -> &'static str {
    match mime_type {
        "image/png" => "png",
        "image/webp" => "webp",
        "video/mp4" => "mp4",
        "video/quicktime" => "mov",
        _ => "jpg",
    }
}

fn is_status(error: &TosError, expected: isize) -> bool {
    matches!(error, TosError::TosServerError { status_code, .. } if *status_code == expected)
}

fn is_conflict(error: &TosError) -> bool {
    matches!(error, TosError::TosServerError { status_code, .. } if *status_code == 409 || *status_code == 412)
}

fn map_tos(error: TosError, operation: &str) -> ProductError {
    match error {
        TosError::TosServerError {
            status_code,
            request_id,
            code,
            ..
        } => {
            let message = format!(
                "{operation} failed with TOS HTTP {status_code} ({code}, request {request_id})"
            );
            if status_code == 429 || status_code >= 500 {
                ProductError::DependencyUnavailable(message)
            } else {
                ProductError::External(message)
            }
        }
        TosError::TosClientError { message, .. } => {
            ProductError::DependencyUnavailable(format!("{operation} failed: {message}"))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn object_keys_and_extensions_are_restricted() {
        assert!(validate_key("jobs/123.json").is_ok());
        assert!(validate_key("/jobs/123.json").is_err());
        assert!(validate_key("jobs/../secret").is_err());
        assert_eq!(extension("video/mp4"), "mp4");
        assert_eq!(extension("image/png"), "png");
    }
}
