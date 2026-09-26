use crate::product::domain::ProductError;
use axum::extract::rejection::{JsonRejection, QueryRejection};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde::Serialize;
use serde_json::{json, Value};
use uuid::Uuid;

#[derive(Debug)]
pub struct ProductApiError {
    status: StatusCode,
    code: String,
    message: String,
    details: Value,
}

impl ProductApiError {
    pub fn invalid_request(message: impl Into<String>) -> Self {
        Self {
            status: StatusCode::BAD_REQUEST,
            code: "INVALID_REQUEST".to_owned(),
            message: message.into(),
            details: json!({}),
        }
    }

    pub fn from_json_rejection(rejection: JsonRejection) -> Self {
        Self::invalid_request(rejection.body_text())
    }

    pub fn from_query_rejection(rejection: QueryRejection) -> Self {
        Self::invalid_request(rejection.body_text())
    }
}

impl From<ProductError> for ProductApiError {
    fn from(error: ProductError) -> Self {
        match error {
            ProductError::NotFound => Self {
                status: StatusCode::NOT_FOUND,
                code: "RESOURCE_NOT_FOUND".to_owned(),
                message: "resource not found".to_owned(),
                details: json!({}),
            },
            ProductError::RevisionConflict { expected, actual } => Self {
                status: StatusCode::CONFLICT,
                code: "REVISION_CONFLICT".to_owned(),
                message: "target content has changed; refresh and retry".to_owned(),
                details: json!({
                    "expectedRevision": expected,
                    "actualRevision": actual,
                }),
            },
            ProductError::Conflict { code, message } => Self {
                status: StatusCode::CONFLICT,
                code: code.to_owned(),
                message,
                details: json!({}),
            },
            ProductError::Validation(message) => Self {
                status: StatusCode::UNPROCESSABLE_ENTITY,
                code: "VALIDATION_FAILED".to_owned(),
                message,
                details: json!({}),
            },
            ProductError::DependencyUnavailable(message) => Self {
                status: StatusCode::NOT_IMPLEMENTED,
                code: "DEPENDENCY_UNAVAILABLE".to_owned(),
                message,
                details: json!({}),
            },
            ProductError::Storage(_) => Self {
                status: StatusCode::INTERNAL_SERVER_ERROR,
                code: "INTERNAL_ERROR".to_owned(),
                message: "an internal storage error occurred".to_owned(),
                details: json!({}),
            },
            ProductError::External(_) => Self {
                status: StatusCode::BAD_GATEWAY,
                code: "EXTERNAL_SERVICE_ERROR".to_owned(),
                message: "an external service failed".to_owned(),
                details: json!({}),
            },
        }
    }
}

impl IntoResponse for ProductApiError {
    fn into_response(self) -> Response {
        let envelope = ErrorEnvelope {
            error: ErrorBody {
                code: self.code,
                message: self.message,
                request_id: format!("req_{}", Uuid::new_v4().simple()),
                details: self.details,
            },
        };
        (self.status, Json(envelope)).into_response()
    }
}

#[derive(Serialize)]
struct ErrorEnvelope {
    error: ErrorBody,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ErrorBody {
    code: String,
    message: String,
    request_id: String,
    details: Value,
}
