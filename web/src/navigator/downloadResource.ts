import type { MediaAccess, MediaItem } from "../productApi/generated";
import { cloudMode } from "../api";
import { createCloudGenerationClient } from "../generation/cloudGenerationClient";
import { isAccessExpired } from "../preview/formatMedia";
import { workspaceObjectMediaClient } from "../workspace/workspaceObjectMediaClient";
import type { WorkspaceObjectNode } from "../workspace/types";

const extensionByMimeType: Record<string, string> = {
  "image/avif": "avif",
  "image/gif": "gif",
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/svg+xml": "svg",
  "image/webp": "webp",
  "video/mp4": "mp4",
  "video/quicktime": "mov",
  "video/webm": "webm",
};

export async function downloadResource(
  node: WorkspaceObjectNode,
  media: MediaItem | null,
  scriptText: string,
  projectId: string,
): Promise<void> {
  if (node.selection.kind === "script") {
    saveBlob(new Blob([scriptText], { type: "text/plain;charset=utf-8" }), filename(node.name, "txt"));
    return;
  }
  if (!media || media.status !== "ready") throw new Error("该资源还没有可下载的文件。");

  const current = node.selection.kind === "emptyObject"
    ? await workspaceObjectMediaClient.get(projectId, media.id)
    : media;
  const access = await currentAccess(current, projectId);
  const response = await fetch(access.url);
  if (!response.ok) throw new Error(`下载失败（HTTP ${response.status}），请重试。`);
  const blob = await response.blob();
  if (blob.size === 0) throw new Error("资源文件为空，无法下载。");
  const mimeType = access.mimeType.split(";", 1)[0].toLowerCase();
  saveBlob(blob, filename(node.name, extensionByMimeType[mimeType] ?? "bin"));
}

async function currentAccess(media: MediaItem, projectId: string): Promise<MediaAccess> {
  const access = media.preview;
  if (!access?.url) throw new Error("该资源还没有可下载的文件。");
  if (!isAccessExpired(access, Date.now() + 30_000)) return access;

  if (cloudMode && media.generation?.jobId) {
    const job = await createCloudGenerationClient().get(projectId, media.generation.jobId);
    if (job.status === "succeeded" && job.result?.url) {
      return { ...access, url: job.result.url, expiresAt: job.result.expiresAt, mimeType: job.result.mimeType };
    }
  } else if (!cloudMode) {
    const response = await fetch(`/api/v1/projects/${encodeURIComponent(projectId)}/media/${encodeURIComponent(media.id)}/access`, {
      method: "POST",
    });
    if (response.ok) {
      const refreshed = await response.json() as { preview: MediaAccess | null };
      if (refreshed.preview?.url) return refreshed.preview;
    }
  }
  throw new Error("资源访问地址已过期，请稍后重试。");
}

function filename(name: string, extension: string): string {
  const base = name.replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_")
    .replace(/\.(avif|gif|jpe?g|png|svg|webp|mp4|mov|webm|txt)$/i, "")
    .replace(/[. ]+$/g, "").trim() || "资源";
  return `${base}.${extension}`;
}

function saveBlob(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  document.body.append(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
}
