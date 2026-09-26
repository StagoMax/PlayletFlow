-- Repair older resource trees whose script entry was missing while the script
-- text remained in storyboard_scripts. Do not touch unrelated folders or media.
INSERT INTO workspace_nodes
    (id, project_id, storyboard_id, parent_id, kind, name, position, revision, created_at, updated_at)
SELECT 'folder-script-' || s.id, s.project_id, s.id, NULL, 'folder', '脚本',
       printf('%020d', COALESCE((SELECT MAX(CAST(position AS INTEGER)) FROM workspace_nodes WHERE storyboard_id = s.id), 0) + 1024),
       1, s.created_at, s.created_at
FROM storyboards s
WHERE s.deleted_at IS NULL
  AND NOT EXISTS (SELECT 1 FROM workspace_nodes n WHERE n.storyboard_id = s.id AND n.target_type = 'script')
  AND NOT EXISTS (SELECT 1 FROM workspace_nodes n WHERE n.storyboard_id = s.id AND n.parent_id IS NULL AND n.kind = 'folder' AND n.name = '脚本');

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
WHERE s.deleted_at IS NULL
  AND NOT EXISTS (SELECT 1 FROM workspace_nodes n WHERE n.storyboard_id = s.id AND n.target_type = 'script');
