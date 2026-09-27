import type { MediaItem } from "../productApi/generated";
import { createWelcomeWorkspace } from "./welcomeWorkspace";
import type { WorkspaceSnapshot } from "./types";
import { browserMediaFileUrl } from "./browserMediaFiles";
import { queueCloudWorkspaceSave } from "./cloudWorkspaceSync";

const key = "videoflow:browser-workspace:v1";
const browserMediaPrefix = "browser-media:";

export function loadBrowserWorkspace(): WorkspaceSnapshot {
  try {
    const saved = window.localStorage.getItem(key);
    if (saved) {
      const parsed = JSON.parse(saved) as WorkspaceSnapshot;
      if (parsed.project?.id && Array.isArray(parsed.storyboards) && parsed.workspaces) return parsed;
    }
  } catch {
    // Storage may be disabled or contain an incomplete older draft.
  }
  return createWelcomeWorkspace();
}

export function saveBrowserWorkspace(snapshot: WorkspaceSnapshot, sync = true) {
  try {
    const objectMedia = Object.fromEntries(Object.entries(snapshot.objectMedia ?? {}).map(([objectId, media]) => [
      objectId,
      storedMedia(media),
    ]));
    const stored = { ...snapshot, objectMedia };
    window.localStorage.setItem(key, JSON.stringify(stored));
    if (sync && import.meta.env.PROD) queueCloudWorkspaceSave(stored);
  } catch (error) {
    console.warn("无法保存浏览器工作区", error);
  }
}

export async function hydrateBrowserWorkspaceMedia(snapshot: WorkspaceSnapshot): Promise<WorkspaceSnapshot> {
  const entries = await Promise.all(Object.entries(snapshot.objectMedia ?? {}).map(async ([objectId, media]) => {
    const storedUrl = media.preview?.url ?? media.thumbnail?.url;
    if (!storedUrl?.startsWith(browserMediaPrefix)) return [objectId, media] as const;
    const url = await browserMediaFileUrl(media.id);
    if (!url) return [objectId, { ...media, status: "failed" as const }] as const;
    return [objectId, {
      ...media,
      preview: media.preview ? { ...media.preview, url } : null,
      thumbnail: media.thumbnail ? { ...media.thumbnail, url } : null,
    }] as const;
  }));
  return { ...snapshot, objectMedia: Object.fromEntries(entries) };
}

export function saveBrowserObjectMedia(objectId: string, media: MediaItem) {
  const snapshot = loadBrowserWorkspace();
  saveBrowserWorkspace({
    ...snapshot,
    objectMedia: { ...snapshot.objectMedia, [objectId]: media },
  });
}

function storedMedia(media: MediaItem): MediaItem {
  const storedUrl = `${browserMediaPrefix}${media.id}`;
  return {
    ...media,
    preview: media.preview?.url.startsWith("blob:") ? { ...media.preview, url: storedUrl } : media.preview,
    thumbnail: media.thumbnail?.url.startsWith("blob:") ? { ...media.thumbnail, url: storedUrl } : media.thumbnail,
  };
}
