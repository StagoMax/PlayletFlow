DROP TRIGGER IF EXISTS workspace_nodes_prevent_cycle;
DROP TRIGGER IF EXISTS workspace_nodes_parent_must_be_folder_update;
DROP TRIGGER IF EXISTS workspace_nodes_parent_must_be_folder_insert;
DROP INDEX IF EXISTS workspace_nodes_sibling_order;
DROP INDEX IF EXISTS workspace_nodes_storyboard_parent;
DROP TABLE IF EXISTS workspace_nodes;
