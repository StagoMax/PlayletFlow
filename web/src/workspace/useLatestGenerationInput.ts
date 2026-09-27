import { useEffect, useState } from "react";
import { cloudMode } from "../api";
import type { GenerationInputSelection } from "../productApi/generated";
import { useWorkspace } from "./WorkspaceContext";

// The job is the durable source of truth for inputs on prompts saved before
// reference IDs were included in the prompt itself.
export function useLatestGenerationInput(projectId: string, mediaId: string, revision: number, jobId?: string | null) {
  const { loadGenerationJob } = useWorkspace();
  const key = `${projectId}:${mediaId}:${revision}:${jobId ?? ""}`;
  const [latest, setLatest] = useState<{ key: string; input: GenerationInputSelection | null } | null>(null);
  useEffect(() => {
    // Fixture media uses display IDs; generation jobs belong only to persisted UUID media.
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(mediaId)) return;
    const controller = new AbortController();
    void loadGenerationJob(mediaId, jobId, controller.signal)
      .then((job) => {
        if (!controller.signal.aborted) {
          const matchesRevision = job && ((Boolean(jobId) && job.targetType === "assetBindingPrompt")
            || job.targetRevision === revision
            || (!cloudMode && job.status === "succeeded" && job.targetRevision + 1 === revision));
          setLatest({ key, input: matchesRevision ? job.spec.input : null });
        }
      })
      .catch(() => {
        if (!controller.signal.aborted) setLatest({ key, input: null });
      });
    return () => controller.abort();
  }, [jobId, key, loadGenerationJob, mediaId, projectId, revision]);
  return latest?.key === key ? latest.input : null;
}
