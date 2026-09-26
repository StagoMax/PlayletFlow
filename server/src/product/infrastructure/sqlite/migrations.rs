use crate::product::domain::ProductResult;
use rusqlite::{params, Connection, TransactionBehavior};

struct Migration {
    version: i64,
    name: &'static str,
    up: &'static str,
    #[cfg(test)]
    down: &'static str,
}

const MIGRATIONS: &[Migration] = &[
    Migration {
        version: 1,
        name: "initial_product_schema",
        up: include_str!("v001_initial.sql"),
        #[cfg(test)]
        down: include_str!("v001_initial_down.sql"),
    },
    Migration {
        version: 2,
        name: "generation_request_specs",
        up: include_str!("v002_generation_specs.sql"),
        #[cfg(test)]
        down: include_str!("v002_generation_specs_down.sql"),
    },
    Migration {
        version: 3,
        name: "direct_generation_requests",
        up: include_str!("v003_direct_generation_requests.sql"),
        #[cfg(test)]
        down: include_str!("v003_direct_generation_requests_down.sql"),
    },
    Migration {
        version: 4,
        name: "workspace_nodes",
        up: include_str!("v004_workspace_nodes.sql"),
        #[cfg(test)]
        down: include_str!("v004_workspace_nodes_down.sql"),
    },
    Migration {
        version: 5,
        name: "proposal_generation_inputs",
        up: include_str!("v005_proposal_generation_inputs.sql"),
        #[cfg(test)]
        down: include_str!("v005_proposal_generation_inputs_down.sql"),
    },
    Migration {
        version: 6,
        name: "default_workspace_nodes",
        up: include_str!("v006_default_workspace_nodes.sql"),
        #[cfg(test)]
        down: include_str!("v006_default_workspace_nodes_down.sql"),
    },
    Migration {
        version: 7,
        name: "restore_storyboard_script_nodes",
        up: include_str!("v007_restore_storyboard_script_nodes.sql"),
        #[cfg(test)]
        down: include_str!("v007_restore_storyboard_script_nodes_down.sql"),
    },
];

pub fn apply_all(connection: &mut Connection) -> ProductResult<()> {
    connection.execute_batch(
        "CREATE TABLE IF NOT EXISTS product_schema_migrations (\n\
            version INTEGER PRIMARY KEY,\n\
            name TEXT NOT NULL,\n\
            applied_at TEXT NOT NULL\n\
        );",
    )?;
    for migration in MIGRATIONS {
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let applied = transaction.query_row(
            "SELECT EXISTS(SELECT 1 FROM product_schema_migrations WHERE version = ?1)",
            [migration.version],
            |row| row.get::<_, bool>(0),
        )?;
        if applied {
            transaction.commit()?;
            continue;
        }
        transaction.execute_batch(migration.up)?;
        transaction.execute(
            "INSERT INTO product_schema_migrations (version, name, applied_at) VALUES (?1, ?2, ?3)",
            params![
                migration.version,
                migration.name,
                chrono::Utc::now().to_rfc3339()
            ],
        )?;
        transaction.commit()?;
    }
    Ok(())
}

#[cfg(test)]
fn rollback_all(connection: &mut Connection) -> ProductResult<()> {
    for migration in MIGRATIONS.iter().rev() {
        let applied = connection.query_row(
            "SELECT EXISTS(SELECT 1 FROM product_schema_migrations WHERE version = ?1)",
            [migration.version],
            |row| row.get::<_, bool>(0),
        )?;
        if !applied {
            continue;
        }
        let transaction = connection.transaction()?;
        transaction.execute_batch(migration.down)?;
        transaction.execute(
            "DELETE FROM product_schema_migrations WHERE version = ?1",
            [migration.version],
        )?;
        transaction.commit()?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn database() -> Connection {
        let connection = Connection::open_in_memory().expect("open in-memory database");
        connection
            .execute_batch("PRAGMA foreign_keys = ON;")
            .expect("enable foreign keys");
        connection
    }

    fn table_exists(connection: &Connection, name: &str) -> bool {
        connection
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?1)",
                [name],
                |row| row.get(0),
            )
            .expect("query table existence")
    }

    #[test]
    fn migrates_an_empty_database_and_rolls_back() {
        let mut connection = database();
        apply_all(&mut connection).expect("apply schema");
        for table in [
            "projects",
            "storyboards",
            "storyboard_scripts",
            "asset_sections",
            "assets",
            "media_items",
            "asset_representations",
            "asset_bindings",
            "change_proposals",
            "generation_jobs",
            "workspace_thread_bindings",
            "workspace_nodes",
            "product_outbox_events",
            "idempotency_records",
        ] {
            assert!(table_exists(&connection, table), "missing table {table}");
        }

        apply_all(&mut connection).expect("migration is idempotent");
        let applied: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM product_schema_migrations",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(applied, 7);

        rollback_all(&mut connection).expect("roll back schema");
        assert!(!table_exists(&connection, "projects"));
        assert!(table_exists(&connection, "product_schema_migrations"));
    }

    #[test]
    fn restores_missing_script_node_without_changing_script_folder() {
        let mut connection = database();
        apply_all(&mut connection).expect("apply schema");
        let now = "2026-09-26T00:00:00Z";
        connection.execute(
            "INSERT INTO projects (id, name, revision, created_at, updated_at) VALUES ('p1', 'P', 1, ?1, ?1)",
            [now],
        ).unwrap();
        connection.execute(
            "INSERT INTO storyboards (id, project_id, name, position, revision, created_at, updated_at)
             VALUES ('s1', 'p1', 'Scene', '00000000001000000000', 1, ?1, ?1)",
            [now],
        ).unwrap();
        connection.execute(
            "INSERT INTO workspace_nodes (id, project_id, storyboard_id, kind, name, position, revision, created_at, updated_at)
             VALUES ('existing-folder', 'p1', 's1', 'folder', '脚本', '00000000001000000000', 1, ?1, ?1)",
            [now],
        ).unwrap();
        connection
            .execute_batch(include_str!("v007_restore_storyboard_script_nodes.sql"))
            .unwrap();
        connection
            .execute_batch(include_str!("v007_restore_storyboard_script_nodes.sql"))
            .unwrap();
        let (parent, count): (String, i64) = connection.query_row(
            "SELECT parent_id, (SELECT COUNT(*) FROM workspace_nodes WHERE storyboard_id = 's1' AND target_type = 'script')
             FROM workspace_nodes WHERE storyboard_id = 's1' AND target_type = 'script'",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        ).unwrap();
        assert_eq!(parent, "existing-folder");
        assert_eq!(count, 1);
    }

    #[test]
    fn asset_copy_is_enforced_as_shared_reference_not_duplicate_asset() {
        let mut connection = database();
        apply_all(&mut connection).expect("apply schema");
        let now = "2026-09-26T00:00:00Z";
        connection
            .execute(
                "INSERT INTO projects (id, name, revision, created_at, updated_at) VALUES ('p1', 'P', 1, ?1, ?1)",
                [now],
            )
            .unwrap();
        for (storyboard, position) in [("s1", "a"), ("s2", "b")] {
            connection
                .execute(
                    "INSERT INTO storyboards (id, project_id, name, position, revision, created_at, updated_at) VALUES (?1, 'p1', ?1, ?2, 1, ?3, ?3)",
                    params![storyboard, position, now],
                )
                .unwrap();
            connection
                .execute(
                    "INSERT INTO asset_sections (id, project_id, storyboard_id, parent_id, name, kind, position, revision, created_at, updated_at) VALUES (?1, 'p1', ?2, NULL, 'People', 'character', 'a', 1, ?3, ?3)",
                    params![format!("section-{storyboard}"), storyboard, now],
                )
                .unwrap();
        }
        connection
            .execute(
                "INSERT INTO assets (id, project_id, kind, name, revision, created_at, updated_at) VALUES ('asset-1', 'p1', 'character', 'Hero', 1, ?1, ?1)",
                [now],
            )
            .unwrap();
        for (binding, storyboard) in [("binding-1", "s1"), ("binding-2", "s2")] {
            connection
                .execute(
                    "INSERT INTO asset_bindings (id, project_id, storyboard_id, section_id, asset_id, position, revision, created_at, updated_at) VALUES (?1, 'p1', ?2, ?3, 'asset-1', 'a', 1, ?4, ?4)",
                    params![binding, storyboard, format!("section-{storyboard}"), now],
                )
                .unwrap();
        }

        let asset_count: i64 = connection
            .query_row("SELECT COUNT(*) FROM assets", [], |row| row.get(0))
            .unwrap();
        let binding_count: i64 = connection
            .query_row("SELECT COUNT(*) FROM asset_bindings", [], |row| row.get(0))
            .unwrap();
        assert_eq!(asset_count, 1);
        assert_eq!(binding_count, 2);

        let duplicate = connection.execute(
            "INSERT INTO asset_bindings (id, project_id, storyboard_id, section_id, asset_id, position, revision, created_at, updated_at) VALUES ('binding-3', 'p1', 's2', 'section-s2', 'asset-1', 'b', 1, ?1, ?1)",
            [now],
        );
        assert!(
            duplicate.is_err(),
            "same asset cannot be bound twice in one storyboard"
        );
        assert!(
            connection
                .execute("DELETE FROM assets WHERE id = 'asset-1'", [])
                .is_err(),
            "referenced shared asset must not be deleted"
        );

        connection
            .execute("DELETE FROM storyboards WHERE id = 's2'", [])
            .unwrap();
        let remaining_assets: i64 = connection
            .query_row("SELECT COUNT(*) FROM assets", [], |row| row.get(0))
            .unwrap();
        let remaining_bindings: i64 = connection
            .query_row("SELECT COUNT(*) FROM asset_bindings", [], |row| row.get(0))
            .unwrap();
        assert_eq!(
            remaining_assets, 1,
            "deleting storyboard keeps shared asset"
        );
        assert_eq!(
            remaining_bindings, 1,
            "only target storyboard binding is removed"
        );
    }

    #[test]
    fn composite_foreign_keys_reject_cross_project_links() {
        let mut connection = database();
        apply_all(&mut connection).expect("apply schema");
        let now = "2026-09-26T00:00:00Z";
        for project in ["p1", "p2"] {
            connection
                .execute(
                    "INSERT INTO projects (id, name, revision, created_at, updated_at) VALUES (?1, ?1, 1, ?2, ?2)",
                    params![project, now],
                )
                .unwrap();
        }
        connection
            .execute(
                "INSERT INTO storyboards (id, project_id, name, position, revision, created_at, updated_at) VALUES ('s1', 'p1', 'S', 'a', 1, ?1, ?1)",
                [now],
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO asset_sections (id, project_id, storyboard_id, parent_id, name, kind, position, revision, created_at, updated_at) VALUES ('section-1', 'p1', 's1', NULL, 'P', 'prop', 'a', 1, ?1, ?1)",
                [now],
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO assets (id, project_id, kind, name, revision, created_at, updated_at) VALUES ('asset-2', 'p2', 'prop', 'Other project', 1, ?1, ?1)",
                [now],
            )
            .unwrap();

        let cross_project = connection.execute(
            "INSERT INTO asset_bindings (id, project_id, storyboard_id, section_id, asset_id, position, revision, created_at, updated_at) VALUES ('binding-x', 'p1', 's1', 'section-1', 'asset-2', 'a', 1, ?1, ?1)",
            [now],
        );
        assert!(cross_project.is_err());
    }

    #[test]
    fn section_hierarchy_is_limited_to_two_levels() {
        let mut connection = database();
        apply_all(&mut connection).expect("apply schema");
        let now = "2026-09-26T00:00:00Z";
        connection
            .execute(
                "INSERT INTO projects (id, name, revision, created_at, updated_at) VALUES ('p1', 'P', 1, ?1, ?1)",
                [now],
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO storyboards (id, project_id, name, position, revision, created_at, updated_at) VALUES ('s1', 'p1', 'S', 'a', 1, ?1, ?1)",
                [now],
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO asset_sections (id, project_id, storyboard_id, parent_id, name, kind, position, revision, created_at, updated_at) VALUES ('root', 'p1', 's1', NULL, 'Root', 'character', 'a', 1, ?1, ?1)",
                [now],
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO asset_sections (id, project_id, storyboard_id, parent_id, name, kind, position, revision, created_at, updated_at) VALUES ('child', 'p1', 's1', 'root', 'Child', 'character', 'b', 1, ?1, ?1)",
                [now],
            )
            .unwrap();

        let grandchild = connection.execute(
            "INSERT INTO asset_sections (id, project_id, storyboard_id, parent_id, name, kind, position, revision, created_at, updated_at) VALUES ('grandchild', 'p1', 's1', 'child', 'Too deep', 'character', 'c', 1, ?1, ?1)",
            [now],
        );
        assert!(grandchild.is_err());
        assert!(connection
            .execute(
                "UPDATE asset_sections SET parent_id = id WHERE id = 'root'",
                []
            )
            .is_err());
        assert!(
            connection
                .execute(
                    "INSERT INTO asset_sections (id, project_id, storyboard_id, parent_id, name, kind, position, revision, created_at, updated_at) VALUES ('other-root', 'p1', 's1', NULL, 'Other', 'custom', 'd', 1, ?1, ?1)",
                    [now],
                )
                .is_ok()
        );
        assert!(
            connection
                .execute(
                    "UPDATE asset_sections SET parent_id = 'other-root' WHERE id = 'root'",
                    [],
                )
                .is_err(),
            "a section with children cannot become a child"
        );
    }
}
