import type {
  CreateWorkspaceNodeRequest,
  UpdateWorkspaceNodeRequest,
  WorkspaceNode,
} from "../productApi/generated";
import { fetchWithTimeout } from "../http/fetchWithTimeout";
import { folderChain } from "./resourceTree";
import type { WorkspaceSelection, WorkspaceTreeNode } from "./types";

export interface WorkspaceNodeClient {
  list(projectId: string, storyboardId: string, signal?: AbortSignal): Promise<WorkspaceNode[]>;
  create(
    projectId: string,
    storyboardId: string,
    request: CreateWorkspaceNodeRequest,
    signal?: AbortSignal,
    idempotencyKey?: string,
  ): Promise<WorkspaceNode>;
  update(projectId: string, storyboardId: string, nodeId: string, body: UpdateWorkspaceNodeRequest): Promise<WorkspaceNode>;
  delete(projectId: string, storyboardId: string, nodeId: string, expectedRevision: number): Promise<void>;
  copy(projectId: string, storyboardId: string, nodeId: string): Promise<WorkspaceNode>;
}

export function createWorkspaceNodeClient(baseUrl = "/api/v1"): WorkspaceNodeClient {
  const collectionUrl = (projectId: string, storyboardId: string) =>
    `${baseUrl}/projects/${segment(projectId)}/storyboards/${segment(storyboardId)}/workspace-nodes`;
  const nodeUrl = (projectId: string, storyboardId: string, nodeId: string) =>
    `${collectionUrl(projectId, storyboardId)}/${segment(nodeId)}`;
  return {
    list: (projectId, storyboardId, signal) =>
      request<WorkspaceNode[]>(collectionUrl(projectId, storyboardId), { signal }),
    create: (projectId, storyboardId, body, signal, idempotencyKey) =>
      request<WorkspaceNode>(collectionUrl(projectId, storyboardId), {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": idempotencyKey ?? `workspace-${crypto.randomUUID()}`,
        },
        body: JSON.stringify(body),
        signal,
      }),
    update: (projectId, storyboardId, nodeId, body) =>
      request<WorkspaceNode>(nodeUrl(projectId, storyboardId, nodeId), {
        method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
      }),
    delete: async (projectId, storyboardId, nodeId, expectedRevision) => {
      await request<void>(`${nodeUrl(projectId, storyboardId, nodeId)}?expectedRevision=${expectedRevision}`, { method: "DELETE" });
    },
    copy: (projectId, storyboardId, nodeId) =>
      request<WorkspaceNode>(`${nodeUrl(projectId, storyboardId, nodeId)}/copies`, {
        method: "POST", headers: { "Idempotency-Key": `workspace-${crypto.randomUUID()}` },
      }),
  };
}

export async function ensurePersistedFolderPath(
  client: WorkspaceNodeClient,
  projectId: string,
  storyboardId: string,
  tree: WorkspaceTreeNode[],
  parentId: string | null,
  signal?: AbortSignal,
): Promise<string | null> {
  if (parentId === null) return null;
  const chain = folderChain(tree, parentId);
  if (!chain) throw new Error("目标文件夹不存在，无法创建内容。");
  const nodes = await client.list(projectId, storyboardId, signal);
  const persisted = new Map(nodes.map((node) => [node.id, node]));
  let previousId: string | null = null;
  for (const folder of chain) {
    let saved = persisted.get(folder.id);
    if (!saved) {
      const matches = nodes.filter((node) => node.kind === "folder"
        && node.parentId === previousId && node.name === folder.name);
      if (matches.length > 1) {
        throw new Error("目标文件夹有多个同名目录，请刷新后重试。");
      }
      saved = matches[0];
    }
    if (saved) {
      if (saved.kind !== "folder" || saved.parentId !== previousId) {
        throw new Error("目标文件夹的持久化结构与当前资源树不一致，请刷新后重试。");
      }
    } else {
      const created = await client.create(projectId, storyboardId, {
        parentId: previousId,
        kind: "folder",
        name: folder.name,
        objectType: null,
      }, signal, `workspace-folder-${folder.id}`);
      persisted.set(folder.id, created);
      nodes.push(created);
      saved = created;
    }
    previousId = saved.id;
  }
  return previousId;
}

export function workspaceTreeFromNodes(nodes: WorkspaceNode[]): WorkspaceTreeNode[] {
  const roots: WorkspaceTreeNode[] = [];
  const folders = new Map<string, Extract<WorkspaceTreeNode, { kind: "folder" }>>();
  const entries = nodes.map((node) => {
    const entry = workspaceTreeNodeFromNode(node);
    if (entry.kind === "folder") folders.set(entry.id, entry);
    return { node, entry };
  });
  for (const { node, entry } of entries) {
    const parent = node.parentId === null ? null : folders.get(node.parentId);
    if (parent) parent.children.push(entry);
    else roots.push(entry);
  }
  return roots;
}

export function workspaceTreeNodeFromNode(node: WorkspaceNode): WorkspaceTreeNode {
  if (node.kind === "folder") {
    return { kind: "folder", id: node.id, name: node.name, children: [] };
  }
  const objectType = node.objectType ?? "text";
  return {
    kind: "object",
    id: node.id,
    name: node.name,
    objectType,
    mediaId: node.targetType === "media" && node.targetId === node.id ? node.targetId : undefined,
    selection: selectionFromNode(node, objectType),
  };
}

function selectionFromNode(
  node: WorkspaceNode,
  objectType: "text" | "image" | "video",
): WorkspaceSelection {
  if (node.targetType === "script") {
    return { kind: "script", storyboardId: node.targetId ?? node.storyboardId };
  }
  // Newly created objects use their node UUID as the media UUID, so they keep
  // the object workspace (upload + prompt) when the tree is reloaded.
  if (node.targetType === "media" && node.targetId === node.id) {
    return { kind: "emptyObject", objectId: node.id, objectType };
  }
  if (node.targetType === "media" && node.targetId) {
    return { kind: "item", itemId: node.targetId };
  }
  return { kind: "emptyObject", objectId: node.id, objectType };
}

function segment(value: string) {
  return encodeURIComponent(value);
}

async function request<T>(url: string, init: RequestInit): Promise<T> {
  // Workspace nodes enrich the local fixture shell during startup. Keep this
  // budget short so an unavailable backend cannot hold the whole UI hostage.
  const response = await fetchWithTimeout(url, init, 2_000);
  if (response.ok) return response.status === 204 ? undefined as T : response.json() as Promise<T>;
  let message = `${response.status} ${response.statusText}`;
  try {
    const body = (await response.json()) as { error?: { message?: string } | string };
    message = typeof body.error === "string" ? body.error : body.error?.message ?? message;
  } catch {
    // Keep the HTTP fallback if a proxy or server returned a non-JSON body.
  }
  throw new Error(message);
}
