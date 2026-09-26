import type {
  NavigatorGroup,
  WorkspaceFolderNode,
  WorkspaceObjectNode,
  WorkspaceSelection,
  WorkspaceTreeNode,
} from "./types";

export function createNavigationTree(
  storyboardId: string,
  assetGroups: NavigatorGroup[],
  videoGroups: NavigatorGroup[],
): WorkspaceTreeNode[] {
  return [
    folder(`folder-script-${storyboardId}`, "脚本", [
      {
        kind: "object",
        id: `script-${storyboardId}`,
        name: "该分镜的脚本",
        objectType: "text",
        selection: { kind: "script", storyboardId },
      },
    ]),
    folder(`folder-assets-${storyboardId}`, "资产", assetGroups.map(groupFromNavigator)),
    folder(`folder-video-${storyboardId}`, "视频", videoGroups.map(groupFromNavigator)),
  ];
}

export function appendTreeNode(
  nodes: WorkspaceTreeNode[],
  parentId: string | null,
  node: WorkspaceTreeNode,
): WorkspaceTreeNode[] {
  if (parentId === null) return [...nodes, node];
  let inserted = false;
  const next = nodes.map((candidate): WorkspaceTreeNode => {
    if (candidate.kind !== "folder") return candidate;
    if (candidate.id === parentId) {
      inserted = true;
      return { ...candidate, children: [...candidate.children, node] };
    }
    const children = appendIntoDescendants(candidate.children, parentId, node, () => { inserted = true; });
    return children === candidate.children ? candidate : { ...candidate, children };
  });
  if (!inserted) throw new Error("目标文件夹不存在，无法创建内容。");
  return next;
}

export function findFolder(nodes: WorkspaceTreeNode[], folderId: string | null): WorkspaceFolderNode | null {
  if (folderId === null) return null;
  for (const node of nodes) {
    if (node.kind !== "folder") continue;
    if (node.id === folderId) return node;
    const nested = findFolder(node.children, folderId);
    if (nested) return nested;
  }
  return null;
}

export function findObject(nodes: WorkspaceTreeNode[], objectId: string): WorkspaceObjectNode | null {
  for (const node of nodes) {
    if (node.kind === "object" && node.id === objectId) return node;
    if (node.kind === "folder") {
      const nested = findObject(node.children, objectId);
      if (nested) return nested;
    }
  }
  return null;
}

export function folderPath(nodes: WorkspaceTreeNode[], folderId: string | null): string[] {
  if (folderId === null) return [];
  for (const node of nodes) {
    if (node.kind !== "folder") continue;
    if (node.id === folderId) return [node.name];
    const nested = folderPath(node.children, folderId);
    if (nested.length > 0) return [node.name, ...nested];
  }
  return [];
}

export function selectionMatches(left: WorkspaceSelection, right: WorkspaceSelection) {
  if (left.kind !== right.kind) return false;
  if (left.kind === "script" && right.kind === "script") return left.storyboardId === right.storyboardId;
  if (left.kind === "item" && right.kind === "item") return left.itemId === right.itemId;
  return left.kind === "emptyObject" && right.kind === "emptyObject" && left.objectId === right.objectId;
}

function folder(id: string, name: string, children: WorkspaceTreeNode[]): WorkspaceFolderNode {
  return { kind: "folder", id, name, children };
}

function groupFromNavigator(group: NavigatorGroup): WorkspaceFolderNode {
  if (group.kind === "character") {
    const subjects = new Map<string, { name: string; items: typeof group.items }>();
    for (const item of group.items) {
      const id = item.subject?.id ?? "unassigned";
      const subject = subjects.get(id) ?? { name: item.subject?.name ?? "未分组角色", items: [] };
      subject.items.push(item);
      subjects.set(id, subject);
    }
    return folder(`folder-${group.id}`, group.name, [...subjects].map(([id, subject]) =>
      folder(`folder-${group.id}-${id}`, subject.name, subject.items.map(objectFromNavigator)),
    ));
  }
  return folder(`folder-${group.id}`, group.name, group.items.map(objectFromNavigator));
}

function objectFromNavigator(item: NavigatorGroup["items"][number]): WorkspaceObjectNode {
  return {
    kind: "object",
    id: item.id,
    name: item.navigationName ?? item.name,
    objectType: item.media.kind,
    selection: { kind: "item", itemId: item.id },
  };
}

function appendIntoDescendants(
  nodes: WorkspaceTreeNode[],
  parentId: string,
  node: WorkspaceTreeNode,
  markInserted: () => void,
): WorkspaceTreeNode[] {
  let changed = false;
  const next = nodes.map((candidate): WorkspaceTreeNode => {
    if (candidate.kind !== "folder") return candidate;
    if (candidate.id === parentId) {
      changed = true;
      markInserted();
      return { ...candidate, children: [...candidate.children, node] };
    }
    const children = appendIntoDescendants(candidate.children, parentId, node, markInserted);
    if (children === candidate.children) return candidate;
    changed = true;
    return { ...candidate, children };
  });
  return changed ? next : nodes;
}
