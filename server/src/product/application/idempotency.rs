use crate::product::domain::{ProductError, ProductResult};
use serde::Serialize;
use sha2::{Digest, Sha256};

#[derive(Clone, Debug)]
pub struct IdempotencyContext {
    pub actor_scope: String,
    pub operation: &'static str,
    pub key: String,
    pub request_hash: String,
    pub success_status: u16,
}

impl IdempotencyContext {
    pub fn new<T: Serialize>(
        operation: &'static str,
        key: String,
        request: &T,
        success_status: u16,
    ) -> ProductResult<Self> {
        let key = validate_idempotency_key(key)?;
        let encoded = serde_json::to_vec(request)
            .map_err(|error| ProductError::Validation(error.to_string()))?;
        let request_hash = format!("{:x}", Sha256::digest(encoded));
        Ok(Self {
            actor_scope: "local-user".to_owned(),
            operation,
            key,
            request_hash,
            success_status,
        })
    }
}

pub fn validate_idempotency_key(key: String) -> ProductResult<String> {
    let key = key.trim().to_owned();
    if !(8..=200).contains(&key.chars().count()) {
        return Err(ProductError::Validation(
            "idempotency key must contain between 8 and 200 characters".to_owned(),
        ));
    }
    Ok(key)
}
