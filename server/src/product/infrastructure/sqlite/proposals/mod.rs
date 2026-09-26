mod mapping;
mod mutations;
pub(crate) mod target;

#[cfg(test)]
mod tests;

use super::ProductDatabase;
use crate::product::application::proposals::{
    ApplyProposalResult, CreateProposal, ProposalListQuery, ProposalRepository, ResolveProposal,
};
use crate::product::domain::{ChangeProposal, ProductError, ProductResult, ProjectId, ProposalId};
use async_trait::async_trait;
use rusqlite::Connection;

#[derive(Clone, Debug)]
pub struct SqliteProposalRepository {
    database: ProductDatabase,
}

impl SqliteProposalRepository {
    pub fn new(database: ProductDatabase) -> Self {
        Self { database }
    }

    async fn run<T, F>(&self, operation: F) -> ProductResult<T>
    where
        T: Send + 'static,
        F: FnOnce(&mut Connection) -> ProductResult<T> + Send + 'static,
    {
        let database = self.database.clone();
        tokio::task::spawn_blocking(move || {
            let mut connection = database.connect()?;
            operation(&mut connection)
        })
        .await
        .map_err(|error| ProductError::Storage(error.to_string()))?
    }
}

#[async_trait]
impl ProposalRepository for SqliteProposalRepository {
    async fn create(&self, command: CreateProposal) -> ProductResult<ChangeProposal> {
        self.run(move |connection| mutations::create(connection, command))
            .await
    }

    async fn list(&self, query: ProposalListQuery) -> ProductResult<Vec<ChangeProposal>> {
        self.run(move |connection| mutations::list(connection, query))
            .await
    }

    async fn find(
        &self,
        project_id: ProjectId,
        proposal_id: ProposalId,
    ) -> ProductResult<Option<ChangeProposal>> {
        self.run(move |connection| mutations::find(connection, project_id, proposal_id))
            .await
    }

    async fn apply(&self, command: ResolveProposal) -> ProductResult<ApplyProposalResult> {
        self.run(move |connection| mutations::apply(connection, command))
            .await
    }

    async fn reject(&self, command: ResolveProposal) -> ProductResult<ChangeProposal> {
        self.run(move |connection| mutations::reject(connection, command))
            .await
    }
}
