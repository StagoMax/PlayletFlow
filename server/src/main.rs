use anyhow::Result;

#[tokio::main]
async fn main() -> Result<()> {
    videoflow_runtime_server::application::run(std::env::args().collect()).await
}
