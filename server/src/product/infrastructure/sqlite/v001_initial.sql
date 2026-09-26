CREATE TABLE projects (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL CHECK (length(trim(name)) > 0),
    revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE TABLE storyboards (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    name TEXT NOT NULL CHECK (length(trim(name)) > 0),
    position TEXT NOT NULL CHECK (length(position) > 0),
    revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    deleted_at TEXT,
    FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
    UNIQUE (id, project_id)
);

CREATE UNIQUE INDEX storyboards_active_order
    ON storyboards(project_id, position)
    WHERE deleted_at IS NULL;

CREATE TABLE storyboard_scripts (
    storyboard_id TEXT PRIMARY KEY,
    text TEXT NOT NULL DEFAULT '',
    revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
    updated_at TEXT NOT NULL,
    FOREIGN KEY (storyboard_id) REFERENCES storyboards(id) ON DELETE CASCADE
);

CREATE TABLE assets (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('character', 'scene', 'prop', 'custom')),
    name TEXT NOT NULL CHECK (length(trim(name)) > 0),
    description TEXT,
    canonical_prompt TEXT,
    revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    deleted_at TEXT,
    FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
    UNIQUE (id, project_id)
);

CREATE INDEX assets_project_type
    ON assets(project_id, kind, name)
    WHERE deleted_at IS NULL;

CREATE TABLE asset_sections (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    storyboard_id TEXT NOT NULL,
    parent_id TEXT,
    name TEXT NOT NULL CHECK (length(trim(name)) > 0),
    kind TEXT NOT NULL CHECK (kind IN ('character', 'scene', 'prop', 'custom')),
    position TEXT NOT NULL CHECK (length(position) > 0),
    revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY (storyboard_id, project_id)
        REFERENCES storyboards(id, project_id) ON DELETE CASCADE,
    FOREIGN KEY (parent_id, storyboard_id, project_id)
        REFERENCES asset_sections(id, storyboard_id, project_id) ON DELETE CASCADE,
    UNIQUE (id, storyboard_id, project_id),
    UNIQUE (storyboard_id, position)
);

CREATE TRIGGER asset_sections_max_depth_insert
BEFORE INSERT ON asset_sections
WHEN NEW.parent_id IS NOT NULL
BEGIN
    SELECT CASE WHEN EXISTS (
        SELECT 1
        FROM asset_sections parent
        WHERE parent.id = NEW.parent_id
          AND parent.storyboard_id = NEW.storyboard_id
          AND parent.parent_id IS NOT NULL
    ) THEN RAISE(ABORT, 'asset section depth exceeds two levels') END;
END;

CREATE TRIGGER asset_sections_max_depth_update
BEFORE UPDATE OF parent_id ON asset_sections
WHEN NEW.parent_id IS NOT NULL
BEGIN
    SELECT CASE WHEN NEW.parent_id = NEW.id OR EXISTS (
            SELECT 1
            FROM asset_sections parent
            WHERE parent.id = NEW.parent_id
              AND parent.storyboard_id = NEW.storyboard_id
              AND parent.parent_id IS NOT NULL
        ) OR EXISTS (
            SELECT 1
            FROM asset_sections child
            WHERE child.parent_id = NEW.id
              AND child.storyboard_id = NEW.storyboard_id
        )
        THEN RAISE(ABORT, 'asset section depth exceeds two levels') END;
END;

CREATE TABLE media_items (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    asset_id TEXT,
    storyboard_id TEXT,
    kind TEXT NOT NULL CHECK (kind IN ('image', 'video')),
    role TEXT NOT NULL CHECK (
        role IN ('assetView', 'firstFrame', 'lastFrame', 'keyframe', 'generatedVideo', 'custom')
    ),
    name TEXT NOT NULL CHECK (length(trim(name)) > 0),
    prompt TEXT,
    mime_type TEXT NOT NULL,
    source_object_key TEXT,
    thumbnail_object_key TEXT,
    width INTEGER CHECK (width IS NULL OR width > 0),
    height INTEGER CHECK (height IS NULL OR height > 0),
    duration_ms INTEGER CHECK (duration_ms IS NULL OR duration_ms >= 0),
    status TEXT NOT NULL CHECK (status IN ('placeholder', 'ready', 'processing', 'failed')),
    revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    deleted_at TEXT,
    CHECK ((asset_id IS NOT NULL) <> (storyboard_id IS NOT NULL)),
    FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
    FOREIGN KEY (asset_id, project_id) REFERENCES assets(id, project_id) ON DELETE CASCADE,
    FOREIGN KEY (storyboard_id, project_id)
        REFERENCES storyboards(id, project_id) ON DELETE CASCADE,
    UNIQUE (id, project_id)
);

CREATE INDEX media_items_storyboard_role
    ON media_items(storyboard_id, role, created_at)
    WHERE deleted_at IS NULL;

CREATE INDEX media_items_asset_role
    ON media_items(asset_id, role, created_at)
    WHERE deleted_at IS NULL;

CREATE TABLE asset_representations (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    asset_id TEXT NOT NULL,
    label TEXT NOT NULL CHECK (length(trim(label)) > 0),
    view_kind TEXT NOT NULL CHECK (view_kind IN ('front', 'back', 'side', 'top', 'threeView', 'custom')),
    media_id TEXT,
    position TEXT NOT NULL CHECK (length(position) > 0),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY (asset_id, project_id) REFERENCES assets(id, project_id) ON DELETE CASCADE,
    FOREIGN KEY (media_id) REFERENCES media_items(id) ON DELETE SET NULL,
    UNIQUE (asset_id, position)
);

CREATE TRIGGER asset_representation_media_owner_insert
BEFORE INSERT ON asset_representations
WHEN NEW.media_id IS NOT NULL
BEGIN
    SELECT CASE WHEN NOT EXISTS (
        SELECT 1 FROM media_items media
        WHERE media.id = NEW.media_id
          AND media.project_id = NEW.project_id
          AND media.asset_id = NEW.asset_id
    ) THEN RAISE(ABORT, 'asset representation media must belong to the same asset') END;
END;

CREATE TRIGGER asset_representation_media_owner_update
BEFORE UPDATE OF media_id, asset_id, project_id ON asset_representations
WHEN NEW.media_id IS NOT NULL
BEGIN
    SELECT CASE WHEN NOT EXISTS (
        SELECT 1 FROM media_items media
        WHERE media.id = NEW.media_id
          AND media.project_id = NEW.project_id
          AND media.asset_id = NEW.asset_id
    ) THEN RAISE(ABORT, 'asset representation media must belong to the same asset') END;
END;

CREATE TABLE asset_bindings (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    storyboard_id TEXT NOT NULL,
    section_id TEXT NOT NULL,
    asset_id TEXT NOT NULL,
    position TEXT NOT NULL CHECK (length(position) > 0),
    prompt_override TEXT,
    derived_media_id TEXT,
    revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY (storyboard_id, project_id)
        REFERENCES storyboards(id, project_id) ON DELETE CASCADE,
    FOREIGN KEY (section_id, storyboard_id, project_id)
        REFERENCES asset_sections(id, storyboard_id, project_id) ON DELETE CASCADE,
    FOREIGN KEY (asset_id, project_id)
        REFERENCES assets(id, project_id) ON DELETE RESTRICT,
    FOREIGN KEY (derived_media_id) REFERENCES media_items(id) ON DELETE SET NULL,
    UNIQUE (storyboard_id, asset_id),
    UNIQUE (storyboard_id, position)
);

CREATE TRIGGER asset_binding_derived_media_owner_insert
BEFORE INSERT ON asset_bindings
WHEN NEW.derived_media_id IS NOT NULL
BEGIN
    SELECT CASE WHEN NOT EXISTS (
        SELECT 1 FROM media_items media
        WHERE media.id = NEW.derived_media_id
          AND media.project_id = NEW.project_id
          AND media.storyboard_id = NEW.storyboard_id
    ) THEN RAISE(ABORT, 'derived media must belong to the same storyboard') END;
END;

CREATE TRIGGER asset_binding_derived_media_owner_update
BEFORE UPDATE OF derived_media_id, storyboard_id, project_id ON asset_bindings
WHEN NEW.derived_media_id IS NOT NULL
BEGIN
    SELECT CASE WHEN NOT EXISTS (
        SELECT 1 FROM media_items media
        WHERE media.id = NEW.derived_media_id
          AND media.project_id = NEW.project_id
          AND media.storyboard_id = NEW.storyboard_id
    ) THEN RAISE(ABORT, 'derived media must belong to the same storyboard') END;
END;

CREATE INDEX asset_bindings_section_order
    ON asset_bindings(storyboard_id, section_id, position);

CREATE TABLE change_proposals (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    storyboard_id TEXT NOT NULL,
    target_type TEXT NOT NULL CHECK (
        target_type IN ('script', 'mediaPrompt', 'assetBindingPrompt')
    ),
    target_id TEXT NOT NULL,
    base_revision INTEGER NOT NULL CHECK (base_revision >= 1),
    before_value TEXT NOT NULL,
    proposed_value TEXT NOT NULL,
    summary TEXT NOT NULL CHECK (length(trim(summary)) > 0),
    status TEXT NOT NULL CHECK (
        status IN ('pending', 'applying', 'applied', 'rejected', 'conflicted', 'expired', 'failed')
    ),
    source_thread_id TEXT NOT NULL,
    source_turn_id TEXT NOT NULL,
    source_tool_call_id TEXT NOT NULL,
    revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
    created_at TEXT NOT NULL,
    resolved_at TEXT,
    FOREIGN KEY (storyboard_id, project_id)
        REFERENCES storyboards(id, project_id) ON DELETE CASCADE,
    UNIQUE (id, project_id),
    UNIQUE (source_thread_id, source_tool_call_id)
);

CREATE INDEX change_proposals_pending_target
    ON change_proposals(storyboard_id, target_type, target_id, created_at)
    WHERE status IN ('pending', 'conflicted');

CREATE TABLE generation_jobs (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    storyboard_id TEXT NOT NULL,
    proposal_id TEXT NOT NULL,
    target_type TEXT NOT NULL CHECK (target_type IN ('mediaPrompt', 'assetBindingPrompt')),
    target_id TEXT NOT NULL,
    target_revision INTEGER NOT NULL CHECK (target_revision >= 1),
    status TEXT NOT NULL CHECK (
        status IN ('queued', 'waitingForProvider', 'running', 'succeeded', 'failed', 'cancelled')
    ),
    attempt INTEGER NOT NULL DEFAULT 0 CHECK (attempt >= 0),
    provider TEXT,
    provider_job_id TEXT,
    result_media_id TEXT,
    error TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY (storyboard_id, project_id)
        REFERENCES storyboards(id, project_id) ON DELETE CASCADE,
    FOREIGN KEY (proposal_id, project_id)
        REFERENCES change_proposals(id, project_id) ON DELETE CASCADE,
    FOREIGN KEY (result_media_id) REFERENCES media_items(id) ON DELETE SET NULL,
    UNIQUE (proposal_id),
    UNIQUE (provider, provider_job_id)
);

CREATE INDEX generation_jobs_runnable
    ON generation_jobs(status, created_at)
    WHERE status IN ('queued', 'waitingForProvider');

CREATE TABLE workspace_thread_bindings (
    thread_id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    storyboard_id TEXT NOT NULL,
    created_at TEXT NOT NULL,
    FOREIGN KEY (storyboard_id, project_id)
        REFERENCES storyboards(id, project_id) ON DELETE CASCADE
);

CREATE INDEX workspace_thread_bindings_storyboard
    ON workspace_thread_bindings(storyboard_id, created_at DESC);

CREATE TABLE product_outbox_events (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    id TEXT NOT NULL UNIQUE,
    project_id TEXT NOT NULL,
    event_type TEXT NOT NULL CHECK (length(event_type) > 0),
    payload_json TEXT NOT NULL,
    occurred_at TEXT NOT NULL,
    published_at TEXT,
    FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
);

CREATE INDEX product_outbox_unpublished
    ON product_outbox_events(seq)
    WHERE published_at IS NULL;

CREATE TABLE idempotency_records (
    actor_scope TEXT NOT NULL,
    route TEXT NOT NULL,
    idempotency_key TEXT NOT NULL,
    request_hash TEXT NOT NULL,
    status_code INTEGER,
    response_json TEXT,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    PRIMARY KEY (actor_scope, route, idempotency_key)
);

CREATE INDEX idempotency_records_expiry
    ON idempotency_records(expires_at);
