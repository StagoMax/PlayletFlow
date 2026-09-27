use super::volcengine_response::{decode, network_error};
use crate::product::application::generation::{
    GenerationOutput, GenerationPoll, GenerationProvider, GenerationRequest, GenerationSubmission,
};
use crate::product::domain::{
    GenerationInputRole, GenerationJob, MediaKind, ProductError, ProductResult,
};
use async_trait::async_trait;
use reqwest::Client;
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use std::time::Duration;

const DEFAULT_BASE_URL: &str = "https://ark.cn-beijing.volces.com/api/v3";

#[derive(Clone)]
pub struct VolcengineGenerationConfig {
    pub api_key: String,
    pub base_url: String,
    pub watermark: bool,
}

impl VolcengineGenerationConfig {
    pub fn from_env() -> ProductResult<Option<Self>> {
        let Some(api_key) = env_nonempty("ARK_API_KEY") else {
            return Ok(None);
        };
        let watermark = env_nonempty("VIDEOFLOW_GENERATION_WATERMARK")
            .map(|value| match value.as_str() {
                "1" | "true" | "TRUE" => Ok(true),
                "0" | "false" | "FALSE" => Ok(false),
                _ => Err(ProductError::Validation(
                    "VIDEOFLOW_GENERATION_WATERMARK must be true or false".into(),
                )),
            })
            .transpose()?
            .unwrap_or(false);
        Ok(Some(Self {
            api_key,
            base_url: env_nonempty("VIDEOFLOW_ARK_BASE_URL")
                .unwrap_or_else(|| DEFAULT_BASE_URL.into())
                .trim_end_matches('/')
                .to_owned(),
            watermark,
        }))
    }
}

fn env_nonempty(name: &str) -> Option<String> {
    std::env::var(name)
        .ok()
        .map(|value| value.trim().to_owned())
        .filter(|value| !value.is_empty())
}

#[derive(Clone)]
pub struct VolcengineGenerationProvider {
    config: VolcengineGenerationConfig,
    client: Client,
}

impl VolcengineGenerationProvider {
    pub fn new(config: VolcengineGenerationConfig) -> ProductResult<Self> {
        let client = Client::builder()
            .connect_timeout(Duration::from_secs(15))
            .timeout(Duration::from_secs(10 * 60))
            .build()
            .map_err(|error| ProductError::External(error.to_string()))?;
        Ok(Self { config, client })
    }

    async fn submit_image(
        &self,
        request: &GenerationRequest,
    ) -> ProductResult<GenerationSubmission> {
        let references = request
            .inputs
            .iter()
            .map(|input| input.url.as_str())
            .collect::<Vec<_>>();
        let body = ImageRequest {
            model: &request.job.spec.model,
            prompt: &request.prompt,
            image: (!references.is_empty()).then_some(references),
            size: request
                .job
                .spec
                .image_size
                .as_deref()
                .ok_or_else(|| ProductError::External("image job has no imageSize".into()))?,
            response_format: "url",
            sequential_image_generation: supports_sequential_image_generation_field(
                &request.job.spec.model,
            )
            .then_some("disabled"),
            watermark: self.config.watermark,
        };
        let response: ImageResponse = self
            .post("images/generations", request.job.id.to_string(), &body)
            .await?;
        let image =
            response.data.into_iter().next().ok_or_else(|| {
                ProductError::External("Seedream returned no generated image".into())
            })?;
        ensure_https_url(&image.url)?;
        let (width, height) = image.size.as_deref().and_then(parse_dimensions).unzip();
        Ok(GenerationSubmission::Succeeded {
            provider_job_id: format!("image-{}", request.job.id),
            output: GenerationOutput {
                url: image.url,
                kind: MediaKind::Image,
                mime_type: image_mime(image.output_format.as_deref()).into(),
                width,
                height,
                duration_ms: None,
            },
        })
    }

    async fn submit_video(
        &self,
        request: &GenerationRequest,
    ) -> ProductResult<GenerationSubmission> {
        let mut content = vec![VideoContent::Text {
            text: &request.prompt,
        }];
        content.extend(request.inputs.iter().map(|input| VideoContent::ImageUrl {
            image_url: VideoImageUrl { url: &input.url },
            role: match input.role {
                GenerationInputRole::FirstFrame => "first_frame",
                GenerationInputRole::LastFrame => "last_frame",
                GenerationInputRole::ReferenceImage => "reference_image",
            },
        }));
        let spec = &request.job.spec;
        let body = VideoRequest {
            model: &spec.model,
            content,
            resolution: spec
                .video_resolution
                .as_deref()
                .ok_or_else(|| ProductError::External("video job has no videoResolution".into()))?,
            ratio: spec
                .video_ratio
                .as_deref()
                .ok_or_else(|| ProductError::External("video job has no videoRatio".into()))?,
            duration: spec
                .duration_seconds
                .ok_or_else(|| ProductError::External("video job has no durationSeconds".into()))?,
            generate_audio: spec.generate_audio.unwrap_or(false),
            watermark: self.config.watermark,
        };
        let response: VideoCreateResponse = self
            .post(
                "contents/generations/tasks",
                request.job.id.to_string(),
                &body,
            )
            .await?;
        if response.id.trim().is_empty() {
            return Err(ProductError::External(
                "Seedance returned an empty task id".into(),
            ));
        }
        Ok(GenerationSubmission::Pending {
            provider_job_id: response.id,
        })
    }

    async fn post<T: DeserializeOwned>(
        &self,
        path: &str,
        request_id: String,
        body: &impl Serialize,
    ) -> ProductResult<T> {
        let response = self
            .client
            .post(format!("{}/{path}", self.config.base_url))
            .bearer_auth(&self.config.api_key)
            .header("X-Client-Request-Id", request_id)
            .json(body)
            .send()
            .await
            .map_err(network_error)?;
        decode(response).await
    }

    async fn get<T: DeserializeOwned>(&self, path: &str) -> ProductResult<T> {
        let response = self
            .client
            .get(format!("{}/{path}", self.config.base_url))
            .bearer_auth(&self.config.api_key)
            .send()
            .await
            .map_err(network_error)?;
        decode(response).await
    }
}

#[async_trait]
impl GenerationProvider for VolcengineGenerationProvider {
    fn name(&self) -> &str {
        "volcengine-ark"
    }

    async fn submit(&self, request: &GenerationRequest) -> ProductResult<GenerationSubmission> {
        match request.kind {
            MediaKind::Image => self.submit_image(request).await,
            MediaKind::Video => self.submit_video(request).await,
        }
    }

    async fn poll(&self, job: &GenerationJob, kind: MediaKind) -> ProductResult<GenerationPoll> {
        if kind != MediaKind::Video {
            return Err(ProductError::External(
                "only Seedance jobs can require polling".into(),
            ));
        }
        let task_id = job.provider_job_id.as_deref().ok_or_else(|| {
            ProductError::External("running Seedance job has no provider task id".into())
        })?;
        let response: VideoTaskResponse = self
            .get(&format!("contents/generations/tasks/{task_id}"))
            .await?;
        video_poll(response)
    }
}

#[derive(Serialize)]
struct ImageRequest<'a> {
    model: &'a str,
    prompt: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    image: Option<Vec<&'a str>>,
    size: &'a str,
    response_format: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    sequential_image_generation: Option<&'static str>,
    watermark: bool,
}

#[derive(Deserialize)]
struct ImageResponse {
    data: Vec<ImageData>,
}

#[derive(Deserialize)]
struct ImageData {
    url: String,
    size: Option<String>,
    output_format: Option<String>,
}

#[derive(Serialize)]
struct VideoRequest<'a> {
    model: &'a str,
    content: Vec<VideoContent<'a>>,
    resolution: &'a str,
    ratio: &'a str,
    duration: i64,
    generate_audio: bool,
    watermark: bool,
}

#[derive(Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum VideoContent<'a> {
    Text {
        text: &'a str,
    },
    ImageUrl {
        image_url: VideoImageUrl<'a>,
        role: &'static str,
    },
}

#[derive(Serialize)]
struct VideoImageUrl<'a> {
    url: &'a str,
}

#[derive(Deserialize)]
struct VideoCreateResponse {
    id: String,
}

#[derive(Deserialize)]
struct VideoTaskResponse {
    status: String,
    content: Option<VideoOutput>,
    error: Option<ProviderError>,
    resolution: Option<String>,
    ratio: Option<String>,
    duration: Option<i64>,
    output_format: Option<String>,
}

#[derive(Deserialize)]
struct VideoOutput {
    video_url: Option<String>,
}

#[derive(Deserialize)]
struct ProviderError {
    code: Option<String>,
}

fn video_poll(response: VideoTaskResponse) -> ProductResult<GenerationPoll> {
    match response.status.as_str() {
        "queued" | "running" => Ok(GenerationPoll::Pending),
        "failed" | "cancelled" | "expired" => {
            if let Some(code) = response.error.and_then(|error| error.code) {
                eprintln!("Seedance task ended with provider error code {code}");
            }
            Ok(GenerationPoll::Failed)
        }
        "succeeded" => {
            let url = response
                .content
                .and_then(|content| content.video_url)
                .ok_or_else(|| {
                    ProductError::External("Seedance succeeded without a video URL".into())
                })?;
            ensure_https_url(&url)?;
            let dimensions =
                video_dimensions(response.resolution.as_deref(), response.ratio.as_deref());
            Ok(GenerationPoll::Succeeded(GenerationOutput {
                url,
                kind: MediaKind::Video,
                mime_type: match response.output_format.as_deref() {
                    Some("mov") => "video/quicktime",
                    _ => "video/mp4",
                }
                .into(),
                width: dimensions.map(|value| value.0),
                height: dimensions.map(|value| value.1),
                duration_ms: response.duration.map(|seconds| seconds * 1_000),
            }))
        }
        status => Err(ProductError::External(format!(
            "Seedance returned an unknown task status: {status}"
        ))),
    }
}

fn ensure_https_url(url: &str) -> ProductResult<()> {
    if url.starts_with("https://") {
        Ok(())
    } else {
        Err(ProductError::External(
            "generation provider returned a non-HTTPS media URL".into(),
        ))
    }
}

fn image_mime(format: Option<&str>) -> &'static str {
    match format {
        Some("png") => "image/png",
        Some("webp") => "image/webp",
        _ => "image/jpeg",
    }
}

fn supports_sequential_image_generation_field(model: &str) -> bool {
    !matches!(
        model,
        "doubao-seedream-5-0-pro-260628" | "doubao-seedream-5-0-flash-260915"
    )
}

fn parse_dimensions(value: &str) -> Option<(i64, i64)> {
    let (width, height) = value.split_once('x')?;
    Some((width.parse().ok()?, height.parse().ok()?))
}

fn video_dimensions(resolution: Option<&str>, ratio: Option<&str>) -> Option<(i64, i64)> {
    let height = resolution?.strip_suffix('p')?.parse::<i64>().ok()?;
    let (ratio_width, ratio_height) = ratio?.split_once(':')?;
    let ratio_width = ratio_width.parse::<i64>().ok()?;
    let ratio_height = ratio_height.parse::<i64>().ok()?;
    Some((height * ratio_width / ratio_height, height))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn request_shapes_match_ark_contract() {
        let image = serde_json::to_value(ImageRequest {
            model: "doubao-seedream-5-0-pro-260628",
            prompt: "雨夜港口",
            image: Some(vec!["https://example.com/reference.png"]),
            size: "2K",
            response_format: "url",
            sequential_image_generation: None,
            watermark: false,
        })
        .unwrap();
        assert_eq!(image["response_format"], "url");
        assert!(image.get("sequential_image_generation").is_none());

        let economical_image = serde_json::to_value(ImageRequest {
            model: "doubao-seedream-4-0-250828",
            prompt: "雨夜港口",
            image: None,
            size: "2K",
            response_format: "url",
            sequential_image_generation: Some("disabled"),
            watermark: false,
        })
        .unwrap();
        assert_eq!(economical_image["sequential_image_generation"], "disabled");

        let video = serde_json::to_value(VideoRequest {
            model: "doubao-seedance-2-5-260628",
            content: vec![
                VideoContent::Text {
                    text: "镜头前推"
                },
                VideoContent::ImageUrl {
                    image_url: VideoImageUrl {
                        url: "https://example.com/first.png",
                    },
                    role: "first_frame",
                },
            ],
            resolution: "720p",
            ratio: "adaptive",
            duration: 5,
            generate_audio: false,
            watermark: false,
        })
        .unwrap();
        assert_eq!(video["content"][0]["type"], "text");
        assert_eq!(video["content"][0]["text"], "镜头前推");
        assert_eq!(video["content"][1]["role"], "first_frame");
    }

    #[test]
    fn provider_dimensions_are_normalized() {
        assert_eq!(parse_dimensions("2048x1152"), Some((2048, 1152)));
        assert_eq!(
            video_dimensions(Some("720p"), Some("16:9")),
            Some((1280, 720))
        );
        assert_eq!(video_dimensions(Some("720p"), Some("adaptive")), None);
    }
}
