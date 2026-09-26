use anyhow::Result;

#[tokio::main]
async fn main() -> Result<()> {
    videoflow_runtime_server::application::run(vec![
        "videoflow-runtime-fixture".to_owned(),
        "--fixture".to_owned(),
        "--seed-demo-workspace".to_owned(),
    ])
    .await
}
