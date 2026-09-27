use crate::product::domain::{ProductError, ProductResult};
use reqwest::{Response, StatusCode};
use serde::{de::DeserializeOwned, Deserialize};

#[derive(Deserialize)]
struct ArkErrorEnvelope {
    error: ArkError,
}

#[derive(Deserialize)]
struct ArkError {
    code: Option<String>,
    message: Option<String>,
}

pub(super) async fn decode<T: DeserializeOwned>(response: Response) -> ProductResult<T> {
    let status = response.status();
    if !status.is_success() {
        let request_id = response
            .headers()
            .get("x-request-id")
            .and_then(|value| value.to_str().ok())
            .and_then(|value| bounded_field(value, 128));
        let body = response.text().await.unwrap_or_default();
        return Err(provider_error(status, request_id, &body));
    }
    response
        .json::<T>()
        .await
        .map_err(|error| ProductError::External(format!("invalid Ark response: {error}")))
}

fn provider_error(status: StatusCode, request_id: Option<String>, body: &str) -> ProductError {
    let parsed = serde_json::from_str::<ArkErrorEnvelope>(body).ok();
    let rejection = ProductError::ProviderRejected {
        status: status.as_u16(),
        code: parsed
            .as_ref()
            .and_then(|value| value.error.code.as_deref())
            .and_then(|value| bounded_field(value, 128)),
        message: parsed
            .as_ref()
            .and_then(|value| value.error.message.as_deref())
            .and_then(|value| bounded_field(value, 512)),
        request_id,
    };
    if status == StatusCode::TOO_MANY_REQUESTS || status.is_server_error() {
        ProductError::DependencyUnavailable(rejection.to_string())
    } else {
        rejection
    }
}

fn bounded_field(value: &str, max_chars: usize) -> Option<String> {
    let value = value
        .chars()
        .filter(|character| !character.is_control())
        .take(max_chars)
        .collect::<String>();
    let value = value.trim();
    (!value.is_empty()).then(|| value.to_owned())
}

pub(super) fn network_error(error: reqwest::Error) -> ProductError {
    ProductError::DependencyUnavailable(format!("Volcengine Ark request failed: {error}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn preserves_structured_provider_rejection() {
        let error = provider_error(
            StatusCode::BAD_REQUEST,
            Some("ark-request-123".into()),
            r#"{"error":{"code":"InvalidParameter","message":"unsupported duration"}}"#,
        );
        assert!(matches!(error, ProductError::ProviderRejected { .. }));
        let message = error.to_string();
        assert!(message.contains("InvalidParameter"));
        assert!(message.contains("unsupported duration"));
        assert!(message.contains("ark-request-123"));
    }

    #[test]
    fn malformed_body_keeps_http_status_and_request_id() {
        let error = provider_error(
            StatusCode::BAD_REQUEST,
            Some("ark-request-456".into()),
            "not json",
        );
        assert_eq!(
            error.to_string(),
            "火山方舟拒绝生成请求（HTTP 400）（Request ID: ark-request-456）"
        );
    }

    #[test]
    fn retryable_status_stays_retryable() {
        let error = provider_error(
            StatusCode::TOO_MANY_REQUESTS,
            None,
            r#"{"error":{"code":"RateLimitExceeded","message":"try later"}}"#,
        );
        assert!(matches!(error, ProductError::DependencyUnavailable(_)));
    }
}
