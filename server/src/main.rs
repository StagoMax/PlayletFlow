mod api;
mod conversation;
mod history;
mod runtime;

use anyhow::Result;
use opentopia_core::model::AgentEventPayload;
use opentopia_core::provider::{MockProvider, ModelProvider};
use opentopia_core::store::SqliteSessionStore;
use std::sync::Arc;
use uuid::Uuid;

#[tokio::main]
async fn main() -> Result<()> {
    let args = std::env::args().collect::<Vec<_>>();
    if args.iter().any(|arg| arg == "--smoke") {
        return smoke().await;
    }
    let database = std::env::var("VIDEOFLOW_DB")
        .unwrap_or_else(|_| ".videoflow/conversations.sqlite".to_owned());
    let store = Arc::new(SqliteSessionStore::open(database)?);
    let provider: Arc<dyn ModelProvider> = if args.iter().any(|arg| arg == "--fixture") {
        println!("Using the local fixture provider; responses are not from a remote model");
        Arc::new(MockProvider)
    } else {
        runtime::configured_provider().await?
    };
    let service = conversation::ConversationService::new(
        store,
        provider,
        runtime::default_registry(),
        std::env::current_dir()?,
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:8788").await?;
    println!("Videoflow runtime API listening on http://127.0.0.1:8788");
    axum::serve(listener, api::router(service)).await?;
    Ok(())
}

async fn smoke() -> Result<()> {
    let workspace = std::env::current_dir()?;
    let provider = runtime::configured_provider().await?;
    let result = runtime::run_once(
        provider,
        runtime::default_registry(),
        workspace,
        Uuid::new_v4(),
        Uuid::new_v4(),
        Uuid::new_v4(),
        "Say hello in one short sentence.".to_string(),
        Vec::new(),
        None,
    )
    .await?;
    for event in result.events {
        if let AgentEventPayload::AssistantMessage { message } = event {
            println!("{}", serde_json::to_string_pretty(&message)?);
        }
    }
    Ok(())
}
