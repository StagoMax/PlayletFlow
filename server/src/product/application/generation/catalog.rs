use crate::product::domain::{
    GenerationInputSelection, GenerationOptions, GenerationSpec, MediaKind, ProductError,
    ProductResult,
};
use serde::Serialize;
use std::collections::HashSet;

pub const DEFAULT_IMAGE_MODEL: &str = "doubao-seedream-5-0-260128";
pub const DEFAULT_VIDEO_MODEL: &str = "doubao-seedance-2-0-mini-260615";

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GenerationModel {
    pub id: &'static str,
    pub label: &'static str,
    pub kind: MediaKind,
    pub supports_first_last_frames: bool,
    pub max_reference_images: usize,
    pub min_duration_seconds: Option<i64>,
    pub max_duration_seconds: Option<i64>,
}

const MODELS: &[GenerationModel] = &[
    GenerationModel {
        id: DEFAULT_IMAGE_MODEL,
        label: "Seedream 5.0 Lite",
        kind: MediaKind::Image,
        supports_first_last_frames: false,
        max_reference_images: 14,
        min_duration_seconds: None,
        max_duration_seconds: None,
    },
    GenerationModel {
        id: DEFAULT_VIDEO_MODEL,
        label: "Seedance 2.0 Mini",
        kind: MediaKind::Video,
        supports_first_last_frames: true,
        max_reference_images: 9,
        min_duration_seconds: Some(4),
        max_duration_seconds: Some(15),
    },
];

pub fn generation_models() -> &'static [GenerationModel] {
    MODELS
}

pub fn resolve_generation_spec(
    kind: MediaKind,
    options: Option<GenerationOptions>,
) -> ProductResult<GenerationSpec> {
    let options = options.unwrap_or_default();
    let default_model = match kind {
        MediaKind::Image => DEFAULT_IMAGE_MODEL,
        MediaKind::Video => DEFAULT_VIDEO_MODEL,
    };
    let model_id = options
        .model
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or(default_model)
        .to_owned();
    let model = MODELS
        .iter()
        .find(|candidate| candidate.id == model_id && candidate.kind == kind)
        .ok_or_else(|| ProductError::Validation("unsupported generation model".into()))?;

    validate_inputs(model, &options.input)?;
    match kind {
        MediaKind::Image => resolve_image(&model_id, options),
        MediaKind::Video => resolve_video(model, options),
    }
}

fn resolve_image(model: &str, options: GenerationOptions) -> ProductResult<GenerationSpec> {
    if options.video_resolution.is_some()
        || options.video_ratio.is_some()
        || options.duration_seconds.is_some()
        || options.generate_audio.is_some()
    {
        return Err(ProductError::Validation(
            "video parameters cannot be used for image generation".into(),
        ));
    }
    let image_size = options.image_size.unwrap_or_else(|| "2K".into());
    validate_image_size(&image_size)?;
    let spec = GenerationSpec {
        model: model.into(),
        input: options.input,
        image_size: Some(image_size),
        video_resolution: None,
        video_ratio: None,
        duration_seconds: None,
        generate_audio: None,
    };
    spec.validate_for_kind(MediaKind::Image)?;
    Ok(spec)
}

fn resolve_video(
    model: &GenerationModel,
    options: GenerationOptions,
) -> ProductResult<GenerationSpec> {
    if options.image_size.is_some() {
        return Err(ProductError::Validation(
            "imageSize cannot be used for video generation".into(),
        ));
    }
    let resolution = options.video_resolution.unwrap_or_else(|| "480p".into());
    if !matches!(resolution.as_str(), "480p" | "720p") {
        return Err(ProductError::Validation(
            "Seedance 2.0 Mini videoResolution must be 480p or 720p".into(),
        ));
    }
    let first_last = matches!(
        options.input,
        GenerationInputSelection::FirstLastFrames { .. }
    );
    let ratio = if first_last {
        "adaptive".to_owned()
    } else {
        options.video_ratio.unwrap_or_else(|| "16:9".into())
    };
    if !matches!(
        ratio.as_str(),
        "adaptive" | "16:9" | "9:16" | "1:1" | "4:3" | "3:4" | "21:9"
    ) {
        return Err(ProductError::Validation("unsupported videoRatio".into()));
    }
    let duration = options.duration_seconds.unwrap_or(4);
    if duration < model.min_duration_seconds.unwrap_or(duration)
        || duration > model.max_duration_seconds.unwrap_or(duration)
    {
        return Err(ProductError::Validation(format!(
            "durationSeconds is outside the supported range for {}",
            model.label
        )));
    }
    let spec = GenerationSpec {
        model: model.id.into(),
        input: options.input,
        image_size: None,
        video_resolution: Some(resolution),
        video_ratio: Some(ratio),
        duration_seconds: Some(duration),
        generate_audio: Some(options.generate_audio.unwrap_or(false)),
    };
    spec.validate_for_kind(MediaKind::Video)?;
    Ok(spec)
}

fn validate_inputs(model: &GenerationModel, input: &GenerationInputSelection) -> ProductResult<()> {
    if let GenerationInputSelection::ReferenceImages { media_ids } = input {
        if media_ids.len() != media_ids.iter().copied().collect::<HashSet<_>>().len() {
            return Err(ProductError::Validation(
                "reference image media IDs must be unique".into(),
            ));
        }
    }
    match input {
        GenerationInputSelection::TextOnly => Ok(()),
        GenerationInputSelection::FirstLastFrames { .. } if model.supports_first_last_frames => {
            Ok(())
        }
        GenerationInputSelection::FirstLastFrames { .. } => Err(ProductError::Validation(
            "selected model does not support first/last frames".into(),
        )),
        GenerationInputSelection::ReferenceImages { media_ids }
            if !media_ids.is_empty() && media_ids.len() <= model.max_reference_images =>
        {
            Ok(())
        }
        GenerationInputSelection::ReferenceImages { .. } => Err(ProductError::Validation(
            "selected model does not support this number of reference images".into(),
        )),
    }
}

fn validate_image_size(value: &str) -> ProductResult<()> {
    if matches!(value, "2K" | "4K") {
        return Ok(());
    }
    let valid = value.split_once('x').is_some_and(|(width, height)| {
        width.parse::<u32>().is_ok_and(|value| value > 0)
            && height.parse::<u32>().is_ok_and(|value| value > 0)
    });
    if valid {
        Ok(())
    } else {
        Err(ProductError::Validation(
            "imageSize must be 2K, 4K, or WIDTHxHEIGHT".into(),
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::product::domain::MediaId;

    #[test]
    fn first_last_forces_adaptive_ratio() {
        let spec = resolve_generation_spec(
            MediaKind::Video,
            Some(GenerationOptions {
                model: None,
                input: GenerationInputSelection::FirstLastFrames {
                    first_frame_media_id: MediaId::new(),
                    last_frame_media_id: Some(MediaId::new()),
                },
                video_ratio: Some("9:16".into()),
                ..GenerationOptions::default()
            }),
        )
        .unwrap();
        assert_eq!(spec.video_ratio.as_deref(), Some("adaptive"));
    }

    #[test]
    fn non_fixed_model_is_rejected() {
        let result = resolve_generation_spec(
            MediaKind::Video,
            Some(GenerationOptions {
                model: Some("doubao-seedance-1-0-pro-250528".into()),
                ..GenerationOptions::default()
            }),
        );
        assert!(result.is_err());
    }
}
