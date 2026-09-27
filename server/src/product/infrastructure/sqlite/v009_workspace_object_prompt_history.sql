CREATE TABLE workspace_object_prompt_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id TEXT NOT NULL,
    storyboard_id TEXT NOT NULL,
    object_id TEXT NOT NULL,
    media_id TEXT NOT NULL,
    prompt TEXT NOT NULL,
    media_revision INTEGER NOT NULL,
    created_at TEXT NOT NULL,
    undone_at TEXT NULL,
    UNIQUE (media_id, media_revision),
    FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
    FOREIGN KEY (storyboard_id) REFERENCES storyboards(id) ON DELETE CASCADE,
    FOREIGN KEY (object_id) REFERENCES workspace_nodes(id) ON DELETE CASCADE,
    FOREIGN KEY (media_id) REFERENCES media_items(id) ON DELETE CASCADE
);

CREATE INDEX idx_workspace_object_prompt_history_current
ON workspace_object_prompt_history (project_id, storyboard_id, object_id, undone_at, id DESC);
