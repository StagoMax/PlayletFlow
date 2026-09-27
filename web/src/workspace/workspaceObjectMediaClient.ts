import type { MediaItem } from "../productApi/generated";
import { cloudMode } from "../api";
import { browserObjectMediaClient } from "./browserObjectMediaClient";
import type { WorkspaceGenerationJob } from "./workspaceClient";

export type SavedWorkspaceObjectPrompt = {
  objectId: string;
  mediaId: string;
  objectType: "image" | "video";
  prompt: string;
  revision: number;
};

function segment(value: string) {
  return encodeURIComponent(value);
}

function objectUrl(projectId: string, storyboardId: string, objectId: string) {
  return `/api/v1/projects/${segment(projectId)}/storyboards/${segment(storyboardId)}/workspace-nodes/${segment(objectId)}/media`;
}

function promptUndoUrl(projectId: string, storyboardId: string, objectId: string) {
  return `/api/v1/projects/${segment(projectId)}/storyboards/${segment(storyboardId)}/workspace-nodes/${segment(objectId)}/prompt/undo`;
}

export const workspaceObjectMediaClient = {
  getLatestGenerationJob(projectId: string, mediaId: string, signal?: AbortSignal) {
    if (cloudMode) return browserObjectMediaClient.getLatestGenerationJob(projectId, mediaId, signal);
    return request<WorkspaceGenerationJob | null>(`/api/v1/projects/${segment(projectId)}/media/${segment(mediaId)}/generation-jobs/latest`, { signal });
  },
  getGenerationJob(projectId: string, jobId: string, signal?: AbortSignal) {
    if (cloudMode) return browserObjectMediaClient.getGenerationJob(projectId, jobId, signal);
    return request<WorkspaceGenerationJob>(`/api/v1/projects/${segment(projectId)}/generation-jobs/${segment(jobId)}`, { signal });
  },
  get(projectId: string, mediaId: string, signal?: AbortSignal) {
    if (cloudMode) return browserObjectMediaClient.get(projectId, mediaId);
    return request<MediaItem>(`/api/v1/projects/${segment(projectId)}/media/${segment(mediaId)}`, { signal });
  },
  ensure(projectId: string, storyboardId: string, objectId: string, signal?: AbortSignal) {
    if (cloudMode) return browserObjectMediaClient.ensure(projectId, storyboardId, objectId);
    return request<MediaItem>(objectUrl(projectId, storyboardId, objectId), { method: "POST", signal });
  },
  undoPrompt(projectId: string, storyboardId: string, objectId: string, expectedRevision: number) {
    if (cloudMode) return browserObjectMediaClient.undoPrompt(projectId, storyboardId, objectId, expectedRevision);
    return request<SavedWorkspaceObjectPrompt>(promptUndoUrl(projectId, storyboardId, objectId), {
      method: "POST",
      headers: { "Content-Type": "application/json", "Idempotency-Key": crypto.randomUUID() },
      body: JSON.stringify({ expectedRevision }),
    });
  },
  upload(projectId: string, storyboardId: string, objectId: string, file: File,
    metadata: { width: number; height: number; durationMs: number | null }) {
    if (cloudMode) return browserObjectMediaClient.upload(projectId, storyboardId, objectId, file, metadata);
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
