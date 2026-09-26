-- Older storyboards used client-only default folders. Materialize them once so
-- resource actions have stable node IDs and remain authoritative after reload.
INSERT INTO workspace_nodes
    (id, project_id, storyboard_id, parent_id, kind, name, position, revision, created_at, updated_at)
SELECT 'folder-script-' || s.id, s.project_id, s.id, NULL, 'folder', '脚本',
       printf('%020d', COALESCE((SELECT MAX(CAST(position AS INTEGER)) FROM workspace_nodes WHERE storyboard_id = s.id), 0) + 1024),
       1, s.created_at, s.created_at
FROM storyboards s
WHERE NOT EXISTS (SELECT 1 FROM workspace_nodes n WHERE n.storyboard_id = s.id AND n.parent_id IS NULL AND n.kind = 'folder' AND n.name = '脚本');

INSERT INTO workspace_nodes
    (id, project_id, storyboard_id, parent_id, kind, name, position, revision, created_at, updated_at)
SELECT 'folder-assets-' || s.id, s.project_id, s.id, NULL, 'folder', '资产',
       printf('%020d', COALESCE((SELECT MAX(CAST(position AS INTEGER)) FROM workspace_nodes WHERE storyboard_id = s.id), 0) + 1024),
       1, s.created_at, s.created_at
FROM storyboards s
WHERE NOT EXISTS (SELECT 1 FROM workspace_nodes n WHERE n.storyboard_id = s.id AND n.parent_id IS NULL AND n.kind = 'folder' AND n.name = '资产');

INSERT INTO workspace_nodes
    (id, project_id, storyboard_id, parent_id, kind, name, position, revision, created_at, updated_at)
SELECT 'folder-video-' || s.id, s.project_id, s.id, NULL, 'folder', '视频',
       printf('%020d', COALESCE((SELECT MAX(CAST(position AS INTEGER)) FROM workspace_nodes WHERE storyboard_id = s.id), 0) + 1024),
       1, s.created_at, s.created_at
FROM storyboards s
WHERE NOT EXISTS (SELECT 1 FROM workspace_nodes n WHERE n.storyboard_id = s.id AND n.parent_id IS NULL AND n.kind = 'folder' AND n.name = '视频');

INSERT INTO workspace_nodes
    (id, project_id, storyboard_id, parent_id, kind, name, object_type, target_type, target_id,
     position, revision, created_at, updated_at)
SELECT 'script-' || s.id, s.project_id, s.id,
       (SELECT id FROM workspace_nodes WHERE storyboard_id = s.id AND parent_id IS NULL
        AND kind = 'folder' AND name = '脚本' ORDER BY position LIMIT 1),
       'object', '该片段的脚本', 'text', 'script', s.id,
       printf('%020d', COALESCE((SELECT MAX(CAST(position AS INTEGER)) FROM workspace_nodes WHERE storyboard_id = s.id), 0) + 1024),
       1, s.created_at, s.created_at
FROM storyboards s
WHERE NOT EXISTS (SELECT 1 FROM workspace_nodes n WHERE n.storyboard_id = s.id AND n.target_type = 'script');
