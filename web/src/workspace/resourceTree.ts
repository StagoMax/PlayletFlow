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
        name: "该片段的脚本",
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

export function folderChain(nodes: WorkspaceTreeNode[], folderId: string): WorkspaceFolderNode[] | null {
  for (const node of nodes) {
    if (node.kind !== "folder") continue;
    if (node.id === folderId) return [node];
    const nested = folderChain(node.children, folderId);
    if (nested) return [node, ...nested];
  }
  return null;
}

export function mergeWorkspaceTrees(
  base: WorkspaceTreeNode[],
  persisted: WorkspaceTreeNode[],
): WorkspaceTreeNode[] {
  return mergeNodes(base, persisted, true);
}

function mergeNodes(base: WorkspaceTreeNode[], persisted: WorkspaceTreeNode[], isRoot: boolean): WorkspaceTreeNode[] {
  // A seeded or copied storyboard has a complete canonical media tree.
  if (isRoot && containsMediaTarget(base) && containsMediaTarget(persisted)) {
    return persisted;
  }
  const persistedById = new Map(persisted.map((node) => [node.id, node]));
  const merged = base.map((node): WorkspaceTreeNode => {
    let saved = persistedById.get(node.id);
    if (!saved) {
      const matches = [...persistedById.values()].filter((candidate) => node.kind === "folder"
        ? candidate.kind === "folder" && candidate.name === node.name
        : candidate.kind === "object" && selectionMatches(candidate.selection, node.selection));
      if (matches.length === 1) saved = matches[0];
    }
    if (!saved) return node;
    persistedById.delete(saved.id);
    if (node.kind !== "folder" || saved.kind !== "folder") return saved;
    return { ...saved, children: mergeNodes(node.children, saved.children, false) };
  });
  return [...merged, ...persistedById.values()];
}

function containsMediaTarget(nodes: WorkspaceTreeNode[]): boolean {
  return nodes.some((node) => node.kind === "folder"
    ? containsMediaTarget(node.children)
    : node.selection.kind === "item");
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

export function findTreeNode(nodes: WorkspaceTreeNode[], id: string): WorkspaceTreeNode | null {
  for (const node of nodes) {
    if (node.id === id) return node;
    if (node.kind === "folder") {
      const found = findTreeNode(node.children, id);
      if (found) return found;
    }
  }
  return null;
}

export function renameTreeNode(nodes: WorkspaceTreeNode[], id: string, name: string): WorkspaceTreeNode[] {
  return nodes.map((node) => node.id === id
    ? { ...node, name }
    : node.kind === "folder" ? { ...node, children: renameTreeNode(node.children, id, name) } : node);
}

export function removeTreeNode(nodes: WorkspaceTreeNode[], id: string): WorkspaceTreeNode[] {
  return nodes.filter((node) => node.id !== id).map((node) => node.kind === "folder"
    ? { ...node, children: removeTreeNode(node.children, id) } : node);
}

export function nodeContainsSelection(node: WorkspaceTreeNode, selection: WorkspaceSelection): boolean {
  return node.kind === "folder"
    ? node.children.some((child) => nodeContainsSelection(child, selection))
    : selection.nodeId ? node.id === selection.nodeId : selectionMatches(node.selection, selection);
}

export function mediaBackedObjectIds(nodes: WorkspaceTreeNode[]): string[] {
  return nodes.flatMap((node) => node.kind === "folder"
    ? mediaBackedObjectIds(node.children)
    : node.mediaId ? [node.id] : []);
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
