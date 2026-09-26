ALTER TABLE generation_jobs RENAME TO generation_jobs_v002;

CREATE TABLE generation_jobs (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    storyboard_id TEXT NOT NULL,
    proposal_id TEXT,
    target_type TEXT NOT NULL CHECK (target_type IN ('mediaPrompt', 'assetBindingPrompt')),
    target_id TEXT NOT NULL,
    target_revision INTEGER NOT NULL CHECK (target_revision >= 1),
    generation_spec_json TEXT NOT NULL,
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

INSERT INTO generation_jobs (
    id, project_id, storyboard_id, proposal_id, target_type, target_id, target_revision,
    generation_spec_json, status, attempt, provider, provider_job_id, result_media_id, error,
    created_at, updated_at
)
SELECT
    id, project_id, storyboard_id, proposal_id, target_type, target_id, target_revision,
    generation_spec_json, status, attempt, provider, provider_job_id, result_media_id, error,
    created_at, updated_at
FROM generation_jobs_v002;

DROP TABLE generation_jobs_v002;

CREATE INDEX generation_jobs_runnable
    ON generation_jobs(status, created_at)
    WHERE status IN ('queued', 'waitingForProvider');
