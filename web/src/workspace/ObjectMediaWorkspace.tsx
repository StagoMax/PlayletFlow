import { useEffect, useRef, useState, type DragEvent, type ReactNode } from "react";
import type { GenerationJob } from "../productApi/generated";
import { MediaPromptComposer, type MediaSubmissionState } from "../preview/MediaPromptComposer";
import { MediaPromptDock } from "../preview/MediaPromptDock";
import { createCloudGenerationClient } from "../generation/cloudGenerationClient";
import { cloudGenerationMedia } from "../generation/cloudGenerationResult";
import { uploadLocalGenerationInputs } from "../generation/localGenerationInputs";
import { workspaceComposerAssets } from "../composer/workspaceAssets";
import { ObjectMediaStage } from "./ObjectMediaStage";
import { useWorkspace } from "./WorkspaceContext";
import { workspaceObjectMediaClient } from "./workspaceObjectMediaClient";
import type { WorkspaceObjectNode } from "./types";

const cloud = createCloudGenerationClient();
const supportedTypes = new Set(["image/jpeg", "image/png", "image/webp", "video/mp4", "video/quicktime"]);
const maxUploadBytes = 100 * 1024 * 1024;

export function ObjectMediaWorkspace({ object, proposals }: { object: WorkspaceObjectNode; proposals?: ReactNode }) {
  const { data, current, objectMedia, publishObjectMedia, loadGenerationModels } = useWorkspace();
  const projectId = data.project.id;
  const storyboardId = current.storyboard.id;
  const kind = object.objectType === "video" ? "video" : "image";
  const label = kind === "video" ? "视频" : "图片";
  const picker = useRef<HTMLInputElement>(null);
  const media = objectMedia[object.id] ?? null;
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [error, setError] = useState("");
  const [submission, setSubmission] = useState<MediaSubmissionState>({ status: "idle" });
  const [promptCollapsed, setPromptCollapsed] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError("");
    void workspaceObjectMediaClient.ensure(projectId, storyboardId, object.id, controller.signal)
      .then(async (loaded) => {
        const job = await workspaceObjectMediaClient.getLatestGenerationJob(projectId, loaded.id, controller.signal);
        if (controller.signal.aborted) return;
        if (!job || job.targetRevision !== loaded.revision) {
          publishObjectMedia(object.id, loaded);
          return;
        }
        if (job.status === "succeeded") {
          if (import.meta.env.PROD && "result" in job && job.result) {
            publishObjectMedia(object.id, cloudGenerationMedia(loaded, job));
            return;
          }
          const refreshed = await workspaceObjectMediaClient.get(projectId, loaded.id, controller.signal);
          if (!controller.signal.aborted) publishObjectMedia(object.id, refreshed);
          return;
        }
        publishObjectMedia(object.id, {
          ...loaded,
          status: job.status === "failed" || job.status === "cancelled" ? "failed" : "processing",
          generation: { jobId: job.id, provider: job.provider, model: job.spec.model, error: job.error },
        });
      })
      .catch((cause: unknown) => {
        if (!controller.signal.aborted) setError(messageOf(cause));
      })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [object.id, projectId, publishObjectMedia, storyboardId]);

  async function upload(file: File) {
    setSubmission({ status: "idle" });
    if (!supportedTypes.has(file.type) || !file.type.startsWith(`${kind}/`)) {
      setError(`请选择${kind === "image" ? "JPEG、PNG 或 WebP 图片" : "MP4 或 MOV 视频"}。`);
      return;
    }
    if (!file.size || file.size > maxUploadBytes) {
      setError("文件大小需在 100 MB 以内。");
      return;
    }
    setUploading(true);
    setError("");
    try {
      const metadata = await readMediaMetadata(file, kind);
      const uploaded = await workspaceObjectMediaClient.upload(projectId, storyboardId, object.id, file, metadata);
      publishObjectMedia(object.id, uploaded);
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setUploading(false);
    }
  }

  function onDrop(event: DragEvent<HTMLElement>) {
    event.preventDefault();
    setDragging(false);
    const file = event.dataTransfer.files[0];
    if (file) void upload(file);
  }

  const allItems = [...current.assetGroups, ...current.videoGroups].flatMap((group) => group.items);
  const composerAssets = workspaceComposerAssets(current, objectMedia);
  const referenceMedia = composerAssets.flatMap((asset) =>
    asset.kind === "image" && asset.mediaId && asset.previewMedia?.status === "ready"
      ? [{ id: asset.mediaId, name: asset.name }]
      : []);
  const currentMediaIds = new Set(composerAssets.flatMap((asset) => asset.mediaId ? [asset.mediaId] : []));
  const availableMedia = [
    ...allItems.map((item) => item.media),
    ...Object.values(objectMedia).filter((item) => currentMediaIds.has(item.id)),
  ];

  return (
    <div className="canvas-body media-canvas-body">
      <section className="media-preview-workspace object-media-workspace" aria-label={`${label}工作区`}>
        <input ref={picker} type="file" hidden accept={kind === "image" ? "image/jpeg,image/png,image/webp" : "video/mp4,video/quicktime,.mov"}
          aria-label={`选择${label}文件`} onChange={(event) => {
            const file = event.currentTarget.files?.[0];
            event.currentTarget.value = "";
            if (file) void upload(file);
          }} />
        <ObjectMediaStage kind={kind} name={object.name} media={media} submission={submission}
          loading={loading} uploading={uploading} dragging={dragging} error={error}
          onUploadClick={() => picker.current?.click()}
          onPreviewClick={kind === "video" ? () => setPromptCollapsed(true) : undefined}
          onDragOver={(event) => { event.preventDefault(); setDragging(true); }}
          onDragLeave={() => setDragging(false)} onDrop={onDrop} />
        {proposals}
        <MediaPromptDock collapsible={kind === "video"} collapsed={promptCollapsed}
          onToggle={() => setPromptCollapsed((value) => !value)}>
          {media ? <MediaPromptComposer key={media.id} initialPrompt={media.prompt ?? ""} kind={kind}
            draftKey={`${projectId}:${media.id}`}
            media={referenceMedia} assets={composerAssets} loadModels={loadGenerationModels}
            onSubmissionChange={setSubmission}
            onUndoPrompt={async () => {
              const restored = await workspaceObjectMediaClient.undoPrompt(
                projectId, storyboardId, object.id, media.revision,
              );
              publishObjectMedia(object.id, {
                ...media,
                prompt: restored.prompt,
                revision: restored.revision,
              });
            }}
            onGenerate={async (prompt, generation, idempotencyKey, imageFiles) => {
              const request = { prompt, expectedRevision: media.revision, generation };
              if (!import.meta.env.PROD) {
                await uploadLocalGenerationInputs(projectId, storyboardId, imageFiles);
              }
              const job = import.meta.env.PROD
                ? await cloud.create(projectId, storyboardId, media.id, kind, request,
                    idempotencyKey, availableMedia, undefined, imageFiles)
                : await mediaRequest<GenerationJob>(
                    `/api/v1/projects/${encodeURIComponent(projectId)}/storyboards/${encodeURIComponent(storyboardId)}/media/${encodeURIComponent(media.id)}/generations`,
                    { method: "POST", headers: { "Content-Type": "application/json", "Idempotency-Key": idempotencyKey },
                      body: JSON.stringify(request) },
                  );
              const completed = job.status === "succeeded"
                ? await workspaceObjectMediaClient.get(projectId, media.id).catch(() => null)
                : null;
              publishObjectMedia(object.id, import.meta.env.PROD
                ? cloudGenerationMedia({ ...media, prompt }, job)
                : completed?.status === "ready" ? completed : {
                ...media, prompt, revision: job.targetRevision,
                status: job.status === "failed" || job.status === "cancelled" ? "failed" : "processing",
                generation: { jobId: job.id, provider: job.provider, model: job.spec.model, error: job.error },
              });
              return job;
            }} /> : null}
        </MediaPromptDock>
      </section>
    </div>
  );
}

async function readMediaMetadata(file: File, kind: "image" | "video") {
  const url = URL.createObjectURL(file);
  try {
    if (kind === "image") {
      const image = new Image();
      image.src = url;
      await image.decode();
      return { width: image.naturalWidth, height: image.naturalHeight, durationMs: null };
    }
    const video = document.createElement("video");
    video.preload = "metadata";
    video.src = url;
    await new Promise<void>((resolve, reject) => {
      video.onloadedmetadata = () => resolve();
      video.onerror = () => reject(new Error("无法读取视频信息，请选择有效的视频文件。"));
    });
    return {
      width: video.videoWidth,
      height: video.videoHeight,
      durationMs: Number.isFinite(video.duration) ? Math.round(video.duration * 1000) : null,
    };
  } finally {
    URL.revokeObjectURL(url);
  }
}

async function mediaRequest<T>(url: string, init: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  if (response.ok) return response.json() as Promise<T>;
  let message = `${response.status} ${response.statusText}`;
  try {
    const body = await response.json() as { error?: { message?: string } | string };
    message = typeof body.error === "string" ? body.error : body.error?.message ?? message;
  } catch { /* retain HTTP status */ }
  throw new Error(message);
}

function messageOf(cause: unknown) {
  return cause instanceof Error ? cause.message : "操作失败，请重试。";
}
