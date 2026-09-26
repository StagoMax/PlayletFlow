use super::*;
use crate::product::application::storyboards::StoryboardService;
use std::path::PathBuf;
use std::sync::Arc;
use uuid::Uuid;

struct TestDatabase {
    path: PathBuf,
    database: ProductDatabase,
}

impl TestDatabase {
    fn new() -> Self {
        let path =
            std::env::temp_dir().join(format!("videoflow-storyboards-{}.sqlite", Uuid::new_v4()));
        let database = ProductDatabase::open(&path).expect("open test product database");
        Self { path, database }
    }

    fn service(&self) -> StoryboardService {
        StoryboardService::new(Arc::new(SqliteStoryboardRepository::new(
            self.database.clone(),
        )))
    }
}

impl Drop for TestDatabase {
    fn drop(&mut self) {
        for path in [
            self.path.clone(),
            self.path.with_extension("sqlite-wal"),
            self.path.with_extension("sqlite-shm"),
        ] {
            let _ = std::fs::remove_file(path);
        }
    }
}

#[tokio::test]
async fn stale_storyboard_and_script_revisions_are_rejected() {
    let database = TestDatabase::new();
    let service = database.service();
    let project = service
        .create_project("Film".to_owned(), "create-project".to_owned())
        .await
        .unwrap();
    let renamed_project = service
        .rename_project(project.id, "Film 2".to_owned(), 1)
        .await
        .unwrap();
    assert_eq!(renamed_project.revision, 2);
    assert!(matches!(
        service
            .rename_project(project.id, "Stale project".to_owned(), 1)
            .await,
        Err(ProductError::RevisionConflict {
            expected: 1,
            actual: 2
        })
    ));
    let first = service
        .list_storyboard_window(project.id, None, None, 0, 10)
        .await
        .unwrap()
        .items
        .remove(0)
        .storyboard;
    let renamed = service
        .rename_storyboard(project.id, first.id, "Opening".to_owned(), 1)
        .await
        .unwrap();
    assert_eq!(renamed.entry.storyboard.revision, 2);
    assert!(matches!(
        service
            .rename_storyboard(project.id, first.id, "Stale".to_owned(), 1)
            .await,
        Err(ProductError::RevisionConflict {
            expected: 1,
            actual: 2
        })
    ));

    let script = service
        .update_script(project.id, first.id, "New script".to_owned(), 1)
        .await
        .unwrap();
    assert_eq!(script.revision, 2);
    assert!(matches!(
        service
            .update_script(project.id, first.id, "Stale script".to_owned(), 1)
            .await,
        Err(ProductError::RevisionConflict {
            expected: 1,
            actual: 2
        })
    ));
}

#[tokio::test]
async fn idempotent_create_does_not_duplicate_projects() {
    let database = TestDatabase::new();
    let service = database.service();
    let first = service
        .create_project("Film".to_owned(), "same-key".to_owned())
        .await
        .unwrap();
    let replay = service
        .create_project("Film".to_owned(), "same-key".to_owned())
        .await
        .unwrap();
    assert_eq!(first.id, replay.id);
    assert_eq!(service.list_projects().await.unwrap().len(), 1);
    assert!(matches!(
        service
            .create_project("Different".to_owned(), "same-key".to_owned())
            .await,
        Err(ProductError::Conflict {
            code: "IDEMPOTENCY_KEY_REUSED",
            ..
        })
    ));
}

#[tokio::test]
async fn anchored_window_returns_global_index_and_neighbors() {
    let database = TestDatabase::new();
    let service = database.service();
    let project = service
        .create_project("Film".to_owned(), "project-window".to_owned())
        .await
        .unwrap();
    let mut previous = service
        .list_storyboard_window(project.id, None, None, 0, 1)
        .await
        .unwrap()
        .items[0]
        .storyboard
        .id;
    let mut target = previous;
    for index in 2..=200 {
        let snapshot = service
            .create_storyboard(
                project.id,
                format!("Storyboard {index}"),
                Some(previous),
                format!("storyboard-key-{index}"),
            )
            .await
            .unwrap();
        previous = snapshot.entry.storyboard.id;
        if index == 197 {
            target = previous;
        }
    }
    let window = service
        .list_storyboard_window(project.id, Some(target), None, 2, 2)
        .await
        .unwrap();
    assert_eq!(window.anchor_index, Some(196));
    assert_eq!(window.items.len(), 5);
    assert_eq!(window.items[2].storyboard.id, target);
    assert!(window.has_before);
    assert!(window.has_after);
}

#[tokio::test]
async fn last_storyboard_cannot_be_deleted() {
    let database = TestDatabase::new();
    let service = database.service();
    let project = service
        .create_project("Film".to_owned(), "project-delete".to_owned())
        .await
        .unwrap();
    let storyboard = service
        .list_storyboard_window(project.id, None, None, 0, 1)
        .await
        .unwrap()
        .items[0]
        .storyboard
        .clone();
    assert!(matches!(
        service
            .delete_storyboard(project.id, storyboard.id, storyboard.revision)
            .await,
        Err(ProductError::Conflict {
            code: "LAST_STORYBOARD",
            ..
        })
    ));
}

#[tokio::test]
async fn reorder_delete_and_restore_preserve_catalog_invariants() {
    let database = TestDatabase::new();
    let service = database.service();
    let project = service
        .create_project("Film".to_owned(), "project-ordering".to_owned())
        .await
        .unwrap();
    let first = service
        .list_storyboard_window(project.id, None, None, 0, 1)
        .await
        .unwrap()
        .items[0]
        .storyboard
        .clone();
    let second = service
        .create_storyboard(
            project.id,
            "Second".to_owned(),
            Some(first.id),
            "create-second".to_owned(),
        )
        .await
        .unwrap()
        .entry
        .storyboard;
    let third = service
        .create_storyboard(
            project.id,
            "Third".to_owned(),
            Some(second.id),
            "create-third".to_owned(),
        )
        .await
        .unwrap()
        .entry
        .storyboard;

    let reordered = service
        .reorder_storyboard(
            ReorderStoryboard {
                project_id: project.id,
                storyboard_id: third.id,
                before_id: Some(first.id),
                after_id: None,
                expected_revision: third.revision,
            },
            "reorder-third".to_owned(),
        )
        .await
        .unwrap();
    assert_eq!(reordered.entry.storyboard.revision, 2);
    let ordered = service
        .list_storyboard_window(project.id, None, None, 0, 10)
        .await
        .unwrap();
    assert_eq!(ordered.items[0].storyboard.id, third.id);
    assert_eq!(ordered.items[1].storyboard.id, first.id);

    service
        .delete_storyboard(project.id, second.id, second.revision)
        .await
        .unwrap();
    assert_eq!(
        service
            .list_storyboard_window(project.id, None, None, 0, 10)
            .await
            .unwrap()
            .total,
        2
    );
    let restored = service
        .restore_storyboard(project.id, second.id, "restore-second".to_owned())
        .await
        .unwrap();
    assert_eq!(restored.entry.storyboard.revision, 3);
    assert_eq!(
        service
            .list_storyboard_window(project.id, None, None, 0, 10)
            .await
            .unwrap()
            .items[2]
            .storyboard
            .id,
        second.id
    );
}
