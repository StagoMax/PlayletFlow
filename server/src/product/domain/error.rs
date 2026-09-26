use std::fmt::{Display, Formatter};

pub type ProductResult<T> = Result<T, ProductError>;

#[derive(Debug)]
pub enum ProductError {
    NotFound,
    RevisionConflict { expected: i64, actual: i64 },
    Conflict { code: &'static str, message: String },
    Validation(String),
    DependencyUnavailable(String),
    Storage(String),
    External(String),
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
        }
    }
}

impl std::error::Error for ProductError {}

impl From<rusqlite::Error> for ProductError {
    fn from(error: rusqlite::Error) -> Self {
        Self::Storage(error.to_string())
    }
}
