use super::{ProductDatabase, SqliteMediaRepository};
use crate::product::application::media::{MediaListQuery, MediaRepository, UpdateMediaMetadata};
use crate::product::domain::{
    AssetId, MediaId, MediaItem, MediaKind, MediaOwner, MediaRole, MediaStatus, ProductError,
    ProjectId, StoryboardId,
};
use chrono::{DateTime, Utc};
use rusqlite::params;
use std::path::PathBuf;
use uuid::Uuid;

struct MediaDatabaseFixture {
    database: ProductDatabase,
    path: PathBuf,
    project_id: ProjectId,
    other_project_id: ProjectId,
    storyboard_id: StoryboardId,
    other_storyboard_id: StoryboardId,
    asset_id: AssetId,
}

impl MediaDatabaseFixture {
    fn new() -> Self {
        let path = std::env::temp_dir().join(format!("videoflow-media-{}.sqlite", Uuid::new_v4()));
        let database = ProductDatabase::open(&path).expect("open media fixture database");
        let fixture = Self {
            database,
            path,
            project_id: ProjectId::new(),
            other_project_id: ProjectId::new(),
            storyboard_id: StoryboardId::new(),
            other_storyboard_id: StoryboardId::new(),
            asset_id: AssetId::new(),
        };
        fixture.seed();
        fixture
    }

    fn repository(&self) -> SqliteMediaRepository {
        SqliteMediaRepository::new(self.database.clone())
    }

    fn seed(&self) {
        let connection = self.database.connect().expect("connect fixture database");
        let now = "2026-09-26T00:00:00Z";
        for (project_id, name) in [
            (self.project_id, "Media project"),
            (self.other_project_id, "Other project"),
        ] {
            connection
                .execute(
                    "INSERT INTO projects (id, name, revision, created_at, updated_at) \
                     VALUES (?1, ?2, 1, ?3, ?3)",
                    params![project_id.to_string(), name, now],
                )
                .unwrap();
        }
        for (storyboard_id, project_id, position) in [
            (self.storyboard_id, self.project_id, "a"),
            (self.other_storyboard_id, self.other_project_id, "a"),
        ] {
            connection
                .execute(
                    "INSERT INTO storyboards \
                     (id, project_id, name, position, revision, created_at, updated_at) \
                     VALUES (?1, ?2, 'Storyboard', ?3, 1, ?4, ?4)",
                    params![
                        storyboard_id.to_string(),
                        project_id.to_string(),
                        position,
                        now
                    ],
                )
                .unwrap();
        }
        connection
            .execute(
                "INSERT INTO assets \
                 (id, project_id, kind, name, revision, created_at, updated_at) \
                 VALUES (?1, ?2, 'character', 'Hero', 1, ?3, ?3)",
                params![self.asset_id.to_string(), self.project_id.to_string(), now],
            )
            .unwrap();
    }

    fn media(&self, owner: MediaOwner, role: MediaRole, name: &str, created_at: &str) -> MediaItem {
        let created_at = DateTime::parse_from_rfc3339(created_at)
            .unwrap()
            .with_timezone(&Utc);
        MediaItem {
            id: MediaId::new(),
            project_id: self.project_id,
            owner,
            kind: if role == MediaRole::GeneratedVideo {
                MediaKind::Video
            } else {
                MediaKind::Image
            },
            role,
            name: name.into(),
            prompt: Some(format!("prompt for {name}")),
            mime_type: if role == MediaRole::GeneratedVideo {
                "video/mp4".into()
            } else {
                "image/webp".into()
            },
            source_object_key: Some(format!("private/{name}")),
            thumbnail_object_key: Some(format!("private/{name}-thumb")),
            width: Some(1920),
            height: Some(1080),
            duration_ms: (role == MediaRole::GeneratedVideo).then_some(4_000),
            status: MediaStatus::Ready,
            revision: 1,
            created_at,
            updated_at: created_at,
            deleted_at: None,
        }
    }
}

impl Drop for MediaDatabaseFixture {
    fn drop(&mut self) {
        for path in [
            self.path.clone(),
            PathBuf::from(format!("{}-wal", self.path.display())),
            PathBuf::from(format!("{}-shm", self.path.display())),
        ] {
            let _ = std::fs::remove_file(path);
        }
    }
}

#[tokio::test]
async fn lists_storyboard_media_with_stable_cursor_and_role_filter() {
    let fixture = MediaDatabaseFixture::new();
    let repository = fixture.repository();
    for media in [
        fixture.media(
            MediaOwner::Storyboard {
                storyboard_id: fixture.storyboard_id,
            },
            MediaRole::Keyframe,
            "early",
            "2026-09-26T00:00:01Z",
        ),
        fixture.media(
            MediaOwner::Storyboard {
                storyboard_id: fixture.storyboard_id,
            },
            MediaRole::GeneratedVideo,
            "middle",
            "2026-09-26T00:00:02Z",
        ),
        fixture.media(
            MediaOwner::Storyboard {
                storyboard_id: fixture.storyboard_id,
            },
            MediaRole::Keyframe,
            "latest",
            "2026-09-26T00:00:03Z",
        ),
    ] {
        repository.insert_media(&media).await.unwrap();
    }

    let mut query = MediaListQuery {
        project_id: fixture.project_id,
        storyboard_id: fixture.storyboard_id,
        roles: vec![],
        cursor: None,
        limit: 2,
    };
    let first = repository.list_storyboard_media(&query).await.unwrap();
    assert_eq!(first.total, 3);
    assert_eq!(
        first
            .items
            .iter()
            .map(|item| item.name.as_str())
            .collect::<Vec<_>>(),
        ["latest", "middle"]
    );
    query.cursor = first
        .next_cursor
        .as_deref()
        .map(crate::product::application::media::MediaCursor::decode)
        .transpose()
        .unwrap();
    let second = repository.list_storyboard_media(&query).await.unwrap();
    assert_eq!(second.items.len(), 1);
    assert_eq!(second.items[0].name, "early");
    assert!(second.next_cursor.is_none());

    query.cursor = None;
    query.roles = vec![MediaRole::Keyframe];
    let keyframes = repository.list_storyboard_media(&query).await.unwrap();
    assert_eq!(keyframes.total, 2);
    assert!(keyframes
        .items
        .iter()
        .all(|item| item.role == MediaRole::Keyframe));
}

#[tokio::test]
async fn updates_metadata_with_project_scope_and_optimistic_concurrency() {
    let fixture = MediaDatabaseFixture::new();
    let repository = fixture.repository();
    let media = fixture.media(
        MediaOwner::Storyboard {
            storyboard_id: fixture.storyboard_id,
        },
        MediaRole::FirstFrame,
        "first",
        "2026-09-26T00:00:01Z",
    );
    repository.insert_media(&media).await.unwrap();

    let update = UpdateMediaMetadata {
        project_id: fixture.project_id,
        media_id: media.id,
        name: "renamed".into(),
        prompt: None,
        expected_revision: 1,
    };
    let updated = repository.update_media_metadata(&update).await.unwrap();
    assert_eq!((updated.name.as_str(), updated.revision), ("renamed", 2));
    assert!(repository
        .find_media(fixture.other_project_id, media.id)
        .await
        .unwrap()
        .is_none());

    let error = repository
        .update_media_metadata(&update)
        .await
        .expect_err("stale update must fail");
    assert!(matches!(
        error,
        ProductError::RevisionConflict {
            expected: 1,
            actual: 2
        }
    ));
}

#[tokio::test]
async fn soft_delete_only_allows_unreferenced_storyboard_media() {
    let fixture = MediaDatabaseFixture::new();
    let repository = fixture.repository();
    let asset_media = fixture.media(
        MediaOwner::Asset {
            asset_id: fixture.asset_id,
        },
        MediaRole::AssetView,
        "shared",
        "2026-09-26T00:00:01Z",
    );
    repository.insert_media(&asset_media).await.unwrap();
    let error = repository
        .soft_delete_storyboard_media(fixture.project_id, asset_media.id, 1)
        .await
        .expect_err("shared asset media cannot be deleted here");
    assert!(matches!(
        error,
        ProductError::Conflict {
            code: "MEDIA_NOT_STORYBOARD_OWNED",
            ..
        }
    ));

    let storyboard_media = fixture.media(
        MediaOwner::Storyboard {
            storyboard_id: fixture.storyboard_id,
        },
        MediaRole::Keyframe,
        "private",
        "2026-09-26T00:00:02Z",
    );
    repository.insert_media(&storyboard_media).await.unwrap();
    repository
        .soft_delete_storyboard_media(fixture.project_id, storyboard_media.id, 1)
        .await
        .unwrap();
    assert!(repository
        .find_media(fixture.project_id, storyboard_media.id)
        .await
        .unwrap()
        .is_none());

    let bound_media = fixture.media(
        MediaOwner::Storyboard {
            storyboard_id: fixture.storyboard_id,
        },
        MediaRole::Keyframe,
        "bound",
        "2026-09-26T00:00:03Z",
    );
    repository.insert_media(&bound_media).await.unwrap();
    let connection = fixture.database.connect().unwrap();
    let section_id = Uuid::new_v4().to_string();
    let now = "2026-09-26T00:00:00Z";
    connection
        .execute(
            "INSERT INTO asset_sections \
             (id, project_id, storyboard_id, name, kind, position, revision, created_at, updated_at) \
             VALUES (?1, ?2, ?3, 'People', 'character', 'a', 1, ?4, ?4)",
            params![
                section_id,
                fixture.project_id.to_string(),
                fixture.storyboard_id.to_string(),
                now
            ],
        )
        .unwrap();
    connection
        .execute(
            "INSERT INTO asset_bindings \
             (id, project_id, storyboard_id, section_id, asset_id, position, derived_media_id, \
              revision, created_at, updated_at) \
             VALUES (?1, ?2, ?3, ?4, ?5, 'a', ?6, 1, ?7, ?7)",
            params![
                Uuid::new_v4().to_string(),
                fixture.project_id.to_string(),
                fixture.storyboard_id.to_string(),
                section_id,
                fixture.asset_id.to_string(),
                bound_media.id.to_string(),
                now
            ],
        )
        .unwrap();
    drop(connection);
    let error = repository
        .soft_delete_storyboard_media(fixture.project_id, bound_media.id, 1)
        .await
        .expect_err("bound media must remain available");
    assert!(matches!(
        error,
        ProductError::Conflict {
            code: "MEDIA_IN_USE",
            ..
        }
    ));
}
