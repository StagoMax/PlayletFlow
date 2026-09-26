use crate::{
    api, cloud, cloud_generation, conversation, conversation_references, product, rate_limit,
    runtime,
};
use anyhow::Result;
use opentopia_core::model::AgentEventPayload;
use opentopia_core::provider::{MockProvider, ModelProvider};
use opentopia_core::store::SqliteSessionStore;
use std::sync::Arc;
use tower_http::services::ServeDir;
use uuid::Uuid;

#[derive(Clone)]
struct RuntimeThreadAdapter(conversation::ConversationService);

#[async_trait::async_trait]
impl product::application::workspace_threads::RuntimeThreadGateway for RuntimeThreadAdapter {
    async fn create_thread(&self, title: String) -> product::domain::ProductResult<Uuid> {
        self.0
            .create_thread(Some(title))
            .map(|thread| thread.id)
            .map_err(|error| product::domain::ProductError::External(error.to_string()))
    }
}

#[derive(Clone)]
struct WorkspaceContextAdapter(product::application::workspace_threads::WorkspaceThreadService);

#[async_trait::async_trait]
impl conversation::ConversationContextProvider for WorkspaceContextAdapter {
    async fn context_for_thread(&self, thread_id: Uuid) -> Result<Option<String>> {
        self.0.model_context(thread_id).await.map_err(Into::into)
    }

    async fn resolve_references(
        &self,
        thread_id: Uuid,
        reference_ids: &[String],
    ) -> Result<Vec<conversation_references::WorkspaceReference>> {
        self.0
            .resolve_references(thread_id, reference_ids)
            .await
            .map_err(Into::into)
    }
}

pub async fn run(args: Vec<String>) -> Result<()> {
    if args.iter().any(|arg| arg == "--smoke") {
        return smoke().await;
    }
    if args.iter().any(|arg| arg == "--bootstrap-tos") {
        cloud_generation::bootstrap_tos().await?;
        println!("Videoflow TOS bucket is ready");
        return Ok(());
    }
    let fixture = args.iter().any(|arg| arg == "--fixture");
    let seed_demo_workspace = args.iter().any(|arg| arg == "--seed-demo-workspace");
    if std::env::var("VIDEOFLOW_CLOUD").as_deref() == Ok("1") {
        let state = cloud::CloudState {
            provider: Arc::new(tokio::sync::OnceCell::new()),
            fixture,
            tools: runtime::default_registry(),
            workspace: std::env::current_dir()?,
            rate_limit: Arc::new(rate_limit::RateLimiter::default()),
        };
        let port = std::env::var("PORT")
            .ok()
            .and_then(|port| port.parse::<u16>().ok())
            .unwrap_or(80);
        let listener =
            tokio::net::TcpListener::bind((std::net::Ipv4Addr::UNSPECIFIED, port)).await?;
        println!("Videoflow cloud API listening on port {port}");
        axum::serve(listener, cloud::router(state)).await?;
    } else {
        run_local(fixture, seed_demo_workspace).await?;
    }
    Ok(())
}

async fn run_local(fixture: bool, seed_demo_workspace: bool) -> Result<()> {
    let provider: Arc<dyn ModelProvider> = if fixture {
        println!("Using the local fixture provider; responses are not from a remote model");
        Arc::new(MockProvider)
    } else {
        runtime::configured_provider().await?
    };
    let database = std::env::var("VIDEOFLOW_DB")
        .unwrap_or_else(|_| ".videoflow/conversations.sqlite".to_owned());
    let store = Arc::new(SqliteSessionStore::open(&database)?);
    let migrated_references =
        conversation_references::migrate_legacy_message_references(&database)?;
    if migrated_references > 0 {
        println!("Converted {migrated_references} legacy conversation reference messages");
    }
    let product_database = std::env::var("VIDEOFLOW_PRODUCT_DB")
        .unwrap_or_else(|_| ".videoflow/product.sqlite".to_owned());
    let product_database = product::ProductDatabase::open(product_database)?;
    product::infrastructure::sqlite::ensure_workspace_project(&product_database)?;
    if seed_demo_workspace {
        product::infrastructure::sqlite::seed_demo_workspace(&product_database)?;
    }
    println!(
        "Videoflow product database ready at {}",
        product_database.path().display()
    );
    let media_root =
        std::env::var("VIDEOFLOW_MEDIA_DIR").unwrap_or_else(|_| ".videoflow/media".to_owned());
    let media_store = Arc::new(product::infrastructure::LocalMediaStore::new(&media_root)?);
    if let Some(config) = product::infrastructure::VolcengineGenerationConfig::from_env()? {
        let provider = Arc::new(product::infrastructure::VolcengineGenerationProvider::new(
            config,
        )?);
        spawn_generation_runtime(product_database.clone(), provider, media_store.clone());
        println!("Videoflow media generation enabled through Volcengine Ark");
    } else {
        println!("Videoflow media generation is waiting for ARK_API_KEY");
    }
    let workspace_store = Arc::new(
        product::infrastructure::sqlite::SqliteWorkspaceThreadStore::new(product_database.clone()),
    );
    let proposal_service = product::application::proposals::ProposalService::new(Arc::new(
        product::infrastructure::sqlite::SqliteProposalRepository::new(product_database.clone()),
    ));
    let mut tools = runtime::default_registry();
    product::tools::register_product_tools(
        &mut tools,
        proposal_service,
        product::tools::WorkspaceThreadScopeResolver::new(workspace_store.clone()),
    );
    let base_service =
        conversation::ConversationService::new(store, provider, tools, std::env::current_dir()?);
    let workspace_threads = product::application::workspace_threads::WorkspaceThreadService::new(
        workspace_store,
        Arc::new(RuntimeThreadAdapter(base_service.clone())),
    );
    let service = base_service
        .with_context_provider(Arc::new(WorkspaceContextAdapter(workspace_threads.clone())));
    let port = std::env::var("VIDEOFLOW_PORT")
        .ok()
        .and_then(|port| port.parse::<u16>().ok())
        .unwrap_or(8788);
    let listener = tokio::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, port)).await?;
    println!("Videoflow runtime API listening on http://127.0.0.1:{port}");
    let product_router = product::api::router_with_workspace_and_local_media(
        product_database,
        workspace_threads,
        media_store,
    );
    let app = api::router(service)
        .merge(product_router)
        .nest_service("/api/v1/media-files", ServeDir::new(media_root));
    axum::serve(listener, app).await?;
    Ok(())
}

fn spawn_generation_runtime(
    database: product::ProductDatabase,
    provider: Arc<dyn product::application::generation::GenerationProvider>,
    media_store: Arc<product::infrastructure::LocalMediaStore>,
) {
    use product::application::generation::{
        GenerationMonitor, GenerationWorker, GenerationWorkerOutcome,
    };
    let media_repository = Arc::new(product::infrastructure::sqlite::SqliteMediaRepository::new(
        database.clone(),
    ));
    let repository =
        Arc::new(product::infrastructure::sqlite::SqliteGenerationRepository::new(database));
    let input_resolver = Arc::new(
        product::application::generation::MediaGenerationInputResolver::new(
            media_repository,
            media_store.clone(),
        ),
    );
    let worker = GenerationWorker::new(repository.clone(), provider.clone())
        .with_media_store(media_store.clone())
        .with_input_resolver(input_resolver);
    let monitor = GenerationMonitor::new(repository, provider, media_store);
    tokio::spawn(async move {
        let mut interval = tokio::time::interval(std::time::Duration::from_secs(3));
        interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        loop {
            interval.tick().await;
            for _ in 0..32 {
                match worker.run_once().await {
                    Ok(GenerationWorkerOutcome::Idle) => break,
                    Ok(GenerationWorkerOutcome::WaitingForProvider { .. }) => break,
                    Ok(_) => {}
                    Err(error) => {
                        eprintln!("generation submission worker failed: {error}");
                        break;
                    }
                }
            }
            if let Err(error) = monitor.run_once().await {
                eprintln!("generation monitor failed: {error}");
            }
        }
    });
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
