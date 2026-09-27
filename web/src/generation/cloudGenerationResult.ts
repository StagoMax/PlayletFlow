import type { MediaItem } from "../productApi/generated";
import type { WorkspaceGenerationJob } from "../workspace/workspaceClient";

export function cloudGenerationMedia(media: MediaItem, job: WorkspaceGenerationJob): MediaItem {
  const generation = {
    jobId: job.id,
    provider: job.provider,
    model: job.spec.model,
    error: job.error,
  };
  if (job.status === "succeeded" && job.result) {
    const result = job.result;
    const width = result.width ?? media.width ?? 1;
    const height = result.height ?? media.height ?? 1;
    return {
      ...media,
      status: "ready",
      revision: job.targetRevision,
      mimeType: result.mimeType,
      width,
      height,
      durationMs: result.durationMs,
      preview: { url: result.url, expiresAt: result.expiresAt, width, height, mimeType: result.mimeType },
      thumbnail: result.kind === "image"
        ? { url: result.url, expiresAt: result.expiresAt, width, height }
        : null,
      generation,
      updatedAt: job.updatedAt,
    };
  }
  return {
    ...media,
    status: job.status === "failed" || job.status === "cancelled" ? "failed" : "processing",
    revision: job.targetRevision,
    generation,
    updatedAt: job.updatedAt,
  };
}
