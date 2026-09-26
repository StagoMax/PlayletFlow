mod assets;
mod demo_fixture;
mod generation;
mod media;
mod migrations;
mod proposals;
mod storyboard_creation;
mod storyboard_duplication;
mod storyboard_order;
mod storyboard_storage;
mod storyboards;
mod support;
mod workspace_nodes;
mod workspace_media;
mod workspace_threads;

#[cfg(test)]
mod media_tests;

pub use assets::SqliteAssetRepository;
pub use demo_fixture::{
    demo_storyboard_id, ensure_workspace_project, seed_demo_workspace, DEMO_PROJECT_ID,
    DEMO_STORYBOARD_COUNT,
};
pub use generation::SqliteGenerationRepository;
pub use media::SqliteMediaRepository;
pub use proposals::SqliteProposalRepository;
pub use storyboards::SqliteStoryboardRepository;
pub use workspace_nodes::SqliteWorkspaceNodeRepository;
pub use workspace_media::SqliteWorkspaceMediaRepository;
pub use workspace_threads::SqliteWorkspaceThreadStore;

use crate::product::domain::ProductResult;
use rusqlite::{Connection, OpenFlags};
use std::path::{Path, PathBuf};

#[derive(Clone, Debug)]
pub struct ProductDatabase {
    path: PathBuf,
}

impl ProductDatabase {
    pub fn open(path: impl AsRef<Path>) -> ProductResult<Self> {
        let path = path.as_ref().to_path_buf();
        if let Some(parent) = path
            .parent()
            .filter(|parent| !parent.as_os_str().is_empty())
        {
            std::fs::create_dir_all(parent).map_err(|error| {
                crate::product::domain::ProductError::Storage(error.to_string())
            })?;
        }
        let mut connection = open_connection(&path)?;
        migrations::apply_all(&mut connection)?;
        Ok(Self { path })
    }

    pub fn connect(&self) -> ProductResult<Connection> {
        open_connection(&self.path)
    }

    pub fn path(&self) -> &Path {
        &self.path
    }
}

fn open_connection(path: &Path) -> ProductResult<Connection> {
    let connection = Connection::open_with_flags(
        path,
        OpenFlags::SQLITE_OPEN_READ_WRITE
            | OpenFlags::SQLITE_OPEN_CREATE
            | OpenFlags::SQLITE_OPEN_FULL_MUTEX,
    )?;
    configure(&connection)?;
    Ok(connection)
}

fn configure(connection: &Connection) -> ProductResult<()> {
    connection.execute_batch(
        "PRAGMA foreign_keys = ON;\n\
         PRAGMA journal_mode = WAL;\n\
         PRAGMA busy_timeout = 5000;",
    )?;
    Ok(())
}
