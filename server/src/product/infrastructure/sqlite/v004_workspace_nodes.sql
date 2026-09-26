CREATE TABLE workspace_nodes (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    storyboard_id TEXT NOT NULL,
    parent_id TEXT,
    kind TEXT NOT NULL CHECK (kind IN ('folder', 'object')),
    name TEXT NOT NULL CHECK (length(trim(name)) > 0),
    object_type TEXT CHECK (object_type IN ('text', 'image', 'video')),
    target_type TEXT CHECK (target_type IN ('script', 'media', 'empty')),
    target_id TEXT,
    position TEXT NOT NULL CHECK (length(position) > 0),
    revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    CHECK (
        (kind = 'folder' AND object_type IS NULL AND target_type IS NULL AND target_id IS NULL)
        OR
        (kind = 'object' AND object_type IS NOT NULL AND target_type IS NOT NULL
            AND ((target_type = 'empty' AND target_id IS NULL)
                OR (target_type IN ('script', 'media') AND target_id IS NOT NULL)))
    ),
    FOREIGN KEY (storyboard_id, project_id)
        REFERENCES storyboards(id, project_id) ON DELETE CASCADE,
    FOREIGN KEY (parent_id, project_id, storyboard_id)
        REFERENCES workspace_nodes(id, project_id, storyboard_id) ON DELETE CASCADE,
    UNIQUE (id, project_id, storyboard_id)
);

CREATE INDEX workspace_nodes_storyboard_parent
    ON workspace_nodes(storyboard_id, parent_id, position, id);

CREATE UNIQUE INDEX workspace_nodes_sibling_order
    ON workspace_nodes(storyboard_id, ifnull(parent_id, ''), position);

CREATE TRIGGER workspace_nodes_parent_must_be_folder_insert
BEFORE INSERT ON workspace_nodes
WHEN NEW.parent_id IS NOT NULL
BEGIN
    SELECT CASE
        WHEN (SELECT kind FROM workspace_nodes WHERE id = NEW.parent_id) = 'object'
        THEN RAISE(ABORT, 'workspace node parent must be a folder')
    END;
END;

CREATE TRIGGER workspace_nodes_parent_must_be_folder_update
BEFORE UPDATE OF parent_id ON workspace_nodes
WHEN NEW.parent_id IS NOT NULL
BEGIN
    SELECT CASE
        WHEN (SELECT kind FROM workspace_nodes WHERE id = NEW.parent_id) = 'object'
        THEN RAISE(ABORT, 'workspace node parent must be a folder')
    END;
END;

CREATE TRIGGER workspace_nodes_prevent_cycle
BEFORE UPDATE OF parent_id ON workspace_nodes
WHEN NEW.parent_id IS NOT NULL
BEGIN
    SELECT CASE
        WHEN NEW.parent_id = NEW.id
        THEN RAISE(ABORT, 'workspace node cycle')
    END;

    SELECT CASE
        WHEN EXISTS (
            WITH RECURSIVE descendants(id) AS (
                SELECT id FROM workspace_nodes WHERE parent_id = NEW.id
                UNION ALL
                SELECT child.id
                FROM workspace_nodes child
                JOIN descendants parent ON child.parent_id = parent.id
            )
            SELECT 1 FROM descendants WHERE id = NEW.parent_id
        )
        THEN RAISE(ABORT, 'workspace node cycle')
    END;
END;
