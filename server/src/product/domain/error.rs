use std::fmt::{Display, Formatter};

pub type ProductResult<T> = Result<T, ProductError>;

#[derive(Debug)]
pub enum ProductError {
    NotFound,
    RevisionConflict {
        expected: i64,
        actual: i64,
    },
    Conflict {
        code: &'static str,
        message: String,
    },
    Validation(String),
    DependencyUnavailable(String),
    Storage(String),
    External(String),
    ProviderRejected {
        status: u16,
        code: Option<String>,
        message: Option<String>,
        request_id: Option<String>,
    },
}

impl Display for ProductError {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::NotFound => formatter.write_str("resource not found"),
            Self::RevisionConflict { expected, actual } => write!(
                formatter,
                "revision conflict: expected {expected}, actual {actual}"
            ),
            Self::Conflict { message, .. } => formatter.write_str(message),
            Self::Validation(message) => formatter.write_str(message),
            Self::DependencyUnavailable(message) => formatter.write_str(message),
            Self::Storage(message) => formatter.write_str(message),
            Self::External(message) => formatter.write_str(message),
            Self::ProviderRejected {
                status,
                code,
                message,
                request_id,
            } => {
                write!(formatter, "火山方舟拒绝生成请求（HTTP {status}")?;
                if let Some(code) = code {
                    write!(formatter, "，{code}")?;
                }
                formatter.write_str("）")?;
                if let Some(message) = message {
                    write!(formatter, "：{message}")?;
                }
                if let Some(request_id) = request_id {
                    write!(formatter, "（Request ID: {request_id}）")?;
                }
                Ok(())
            }
        }
    }
}

impl std::error::Error for ProductError {}

impl From<rusqlite::Error> for ProductError {
    fn from(error: rusqlite::Error) -> Self {
        Self::Storage(error.to_string())
    }
}
