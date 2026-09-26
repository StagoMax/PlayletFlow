import type { MediaItem } from "../productApi/generated";

function segment(value: string) {
  return encodeURIComponent(value);
}

function objectUrl(projectId: string, storyboardId: string, objectId: string) {
  return `/api/v1/projects/${segment(projectId)}/storyboards/${segment(storyboardId)}/workspace-nodes/${segment(objectId)}/media`;
}

export const workspaceObjectMediaClient = {
  get(projectId: string, mediaId: string, signal?: AbortSignal) {
    return request<MediaItem>(`/api/v1/projects/${segment(projectId)}/media/${segment(mediaId)}`, { signal });
  },
  ensure(projectId: string, storyboardId: string, objectId: string, signal?: AbortSignal) {
    return request<MediaItem>(objectUrl(projectId, storyboardId, objectId), { method: "POST", signal });
  },
  upload(projectId: string, storyboardId: string, objectId: string, file: File,
    metadata: { width: number; height: number; durationMs: number | null }) {
    const query = new URLSearchParams({ width: String(metadata.width), height: String(metadata.height) });
    if (metadata.durationMs !== null) query.set("durationMs", String(metadata.durationMs));
    return request<MediaItem>(`${objectUrl(projectId, storyboardId, objectId)}?${query}`, {
      method: "PUT",
      headers: { "Content-Type": file.type },
      body: file,
    });
  },
};

async function request<T>(url: string, init: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  if (response.ok) return response.json() as Promise<T>;
  let message = `${response.status} ${response.statusText}`;
  try {
    const body = await response.json() as { error?: { message?: string } | string };
    message = typeof body.error === "string" ? body.error : body.error?.message ?? message;
  } catch { /* retain HTTP status */ }
  throw new Error(message);
}
