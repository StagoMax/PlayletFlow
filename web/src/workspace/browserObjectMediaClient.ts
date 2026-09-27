import type { MediaItem } from "../productApi/generated";
import { createCloudGenerationClient } from "../generation/cloudGenerationClient";
import { cloudGenerationMedia } from "../generation/cloudGenerationResult";
import { findObject } from "./resourceTree";
import { browserMediaFileUrl, saveBrowserMediaFile } from "./browserMediaFiles";
import { hydrateBrowserWorkspaceMedia, loadBrowserWorkspace, saveBrowserObjectMedia } from "./browserWorkspaceStorage";
import type { SavedWorkspaceObjectPrompt } from "./workspaceObjectMediaClient";
import type { WorkspaceGenerationJob } from "./workspaceClient";

const cloud = createCloudGenerationClient();

async function mediaFor(objectId: string): Promise<MediaItem | null> {
  const snapshot = await hydrateBrowserWorkspaceMedia(loadBrowserWorkspace());
  return snapshot.objectMedia?.[objectId] ?? null;
}

async function requireMedia(projectId: string, mediaId: string) {
  const snapshot = await hydrateBrowserWorkspaceMedia(loadBrowserWorkspace());
  if (snapshot.project.id !== projectId) throw new Error("项目不存在。");
  const media = Object.values(snapshot.objectMedia ?? {}).find((item) => item.id === mediaId);
  if (!media) throw new Error("媒体不存在。");
  return refreshSignedMedia(projectId, media);
}

async function refreshSignedMedia(projectId: string, media: MediaItem): Promise<MediaItem> {
  const expiresAt = media.preview?.expiresAt;
  if (!media.generation?.jobId || !expiresAt || Date.parse(expiresAt) > Date.now() + 5 * 60_000) {
    return media;
  }
  const job = await cloud.get(projectId, media.generation.jobId);
  if (job.status !== "succeeded" || !job.result) return media;
  const refreshed = cloudGenerationMedia(media, job);
  const snapshot = loadBrowserWorkspace();
  const objectId = Object.entries(snapshot.objectMedia ?? {}).find(([, candidate]) => candidate.id === media.id)?.[0];
  if (objectId) saveBrowserObjectMedia(objectId, refreshed);
  return refreshed;
}

export const browserObjectMediaClient = {
  async getLatestGenerationJob(projectId: string, mediaId: string, signal?: AbortSignal): Promise<WorkspaceGenerationJob | null> {
    const media = await requireMedia(projectId, mediaId);
    return media.generation?.jobId
      ? cloud.get(projectId, media.generation.jobId, signal)
      : null;
  },
  getGenerationJob(projectId: string, jobId: string, signal?: AbortSignal) {
    return cloud.get(projectId, jobId, signal);
  },
  get(projectId: string, mediaId: string) {
    return requireMedia(projectId, mediaId);
  },
  async ensure(projectId: string, storyboardId: string, objectId: string): Promise<MediaItem> {
    const existing = await mediaFor(objectId);
    if (existing) return refreshSignedMedia(projectId, existing);
    const snapshot = loadBrowserWorkspace();
    if (snapshot.project.id !== projectId) throw new Error("项目不存在。");
    const workspace = snapshot.workspaces[storyboardId];
    const object = workspace && findObject(workspace.navigationTree, objectId);
    if (!object || object.objectType === "text") throw new Error("图片或视频对象不存在。");
    const now = new Date().toISOString();
    const media: MediaItem = {
      id: objectId,
      projectId,
      owner: { type: "storyboard", storyboardId },
      kind: object.objectType,
      role: "custom",
      name: object.name,
      prompt: "",
      mimeType: object.objectType === "video" ? "video/mp4" : "image/png",
      width: null,
      height: null,
      durationMs: null,
      status: "placeholder",
      revision: 1,
      thumbnail: null,
      preview: null,
      generation: null,
      createdAt: now,
      updatedAt: now,
    };
    saveBrowserObjectMedia(objectId, media);
    return media;
  },
  async undoPrompt(_projectId: string, _storyboardId: string, _objectId: string, _expectedRevision: number): Promise<SavedWorkspaceObjectPrompt> {
    throw new Error("当前没有可撤销的提示词版本。");
  },
  async upload(projectId: string, storyboardId: string, objectId: string, file: File,
    metadata: { width: number; height: number; durationMs: number | null }): Promise<MediaItem> {
    const existing = await browserObjectMediaClient.ensure(projectId, storyboardId, objectId);
    if (existing.kind !== (file.type.startsWith("video/") ? "video" : "image")) {
      throw new Error("文件类型与对象类型不匹配。");
    }
    await saveBrowserMediaFile(existing.id, file);
    const url = await browserMediaFileUrl(existing.id);
    if (!url) throw new Error("无法保存上传的媒体文件。");
    const now = new Date().toISOString();
    const next: MediaItem = {
      ...existing,
      name: existing.name,
      mimeType: file.type,
      width: metadata.width,
      height: metadata.height,
      durationMs: metadata.durationMs,
      status: "ready",
      revision: existing.revision + 1,
      preview: { url, expiresAt: null, width: metadata.width, height: metadata.height, mimeType: file.type },
      thumbnail: existing.kind === "image"
        ? { url, expiresAt: null, width: metadata.width, height: metadata.height }
        : null,
      generation: null,
      updatedAt: now,
    };
    saveBrowserObjectMedia(objectId, next);
    return next;
  },
};
