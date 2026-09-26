import type {
  CreateWorkspaceNodeRequest,
  WorkspaceNode,
} from "../productApi/generated";
import { fetchWithTimeout } from "../http/fetchWithTimeout";
import type { WorkspaceSelection, WorkspaceTreeNode } from "./types";

export interface WorkspaceNodeClient {
  list(projectId: string, storyboardId: string, signal?: AbortSignal): Promise<WorkspaceNode[]>;
  create(
    projectId: string,
    storyboardId: string,
    request: CreateWorkspaceNodeRequest,
    signal?: AbortSignal,
  ): Promise<WorkspaceNode>;
}

export function createWorkspaceNodeClient(baseUrl = "/api/v1"): WorkspaceNodeClient {
  const collectionUrl = (projectId: string, storyboardId: string) =>
    `${baseUrl}/projects/${segment(projectId)}/storyboards/${segment(storyboardId)}/workspace-nodes`;
  return {
    list: (projectId, storyboardId, signal) =>
      request<WorkspaceNode[]>(collectionUrl(projectId, storyboardId), { signal }),
    create: (projectId, storyboardId, body, signal) =>
      request<WorkspaceNode>(collectionUrl(projectId, storyboardId), {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": `workspace-${crypto.randomUUID()}`,
        },
        body: JSON.stringify(body),
        signal,
      }),
  };
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
  if (response.ok) return response.json() as Promise<T>;
  let message = `${response.status} ${response.statusText}`;
  try {
    const body = (await response.json()) as { error?: { message?: string } | string };
    message = typeof body.error === "string" ? body.error : body.error?.message ?? message;
  } catch {
    // Keep the HTTP fallback if a proxy or server returned a non-JSON body.
  }
  throw new Error(message);
}
