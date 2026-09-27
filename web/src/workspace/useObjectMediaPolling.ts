import { useEffect } from "react";
import type { MediaItem } from "../productApi/generated";
import { findTreeNode } from "./resourceTree";
import { workspaceObjectMediaClient } from "./workspaceObjectMediaClient";
import type { WorkspaceTreeNode } from "./types";

export function useObjectMediaPolling(
  projectId: string,
  storyboardId: string,
  navigationTree: WorkspaceTreeNode[],
  objectMedia: Readonly<Record<string, MediaItem>>,
  publish: (objectId: string, media: MediaItem) => void,
) {
  const pending = Object.entries(objectMedia)
    .flatMap(([objectId, media]) => media.status === "processing"
      && findTreeNode(navigationTree, objectId)?.kind === "object"
      ? [{ objectId, mediaId: media.id, jobId: media.generation?.jobId ?? null, media }]
      : []);
  const pendingKey = pending.map(({ objectId, mediaId, jobId }) => `${objectId}:${mediaId}:${jobId}`).join("|");

  useEffect(() => {
    if (pending.length === 0) return;
    const controller = new AbortController();
    let polling = false;
    const poll = async () => {
      if (polling) return;
      polling = true;
      try {
        await Promise.all(pending.map(async ({ objectId, mediaId, jobId, media }) => {
          if (!jobId) {
            const refreshed = await workspaceObjectMediaClient.get(projectId, mediaId, controller.signal);
            if (!controller.signal.aborted) publish(objectId, refreshed);
            return;
          }
          const job = await workspaceObjectMediaClient.getGenerationJob(projectId, jobId, controller.signal);
          if (controller.signal.aborted) return;
          if (job.status === "succeeded") {
            const result = await workspaceObjectMediaClient.ensure(projectId, storyboardId, objectId, controller.signal);
            if (!controller.signal.aborted) publish(objectId, result);
          } else if (job.status === "failed" || job.status === "cancelled") {
            publish(objectId, {
              ...media,
              status: "failed",
              generation: {
                jobId: job.id, provider: job.provider, model: job.spec.model,
                error: job.error || (job.status === "cancelled" ? "生成任务已取消。" : "生成服务未能完成任务。"),
              },
            });
          }
        }));
      } catch (error) {
        if (!controller.signal.aborted) console.warn("生成任务状态暂时不可用，将继续重试", error);
      } finally {
        polling = false;
      }
    };
    void poll();
    const timer = window.setInterval(poll, 3_000);
    return () => { controller.abort(); window.clearInterval(timer); };
  }, [pendingKey, projectId, storyboardId, publish]);
}
