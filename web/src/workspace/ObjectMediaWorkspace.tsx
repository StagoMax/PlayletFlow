import { useEffect, useRef, useState, type DragEvent } from "react";
import type { GenerationJob } from "../productApi/generated";
import { MediaPromptComposer } from "../preview/MediaPromptComposer";
import { MediaViewer } from "../preview/MediaViewer";
import { createCloudGenerationClient } from "../generation/cloudGenerationClient";
import { workspaceComposerAssets } from "../composer/workspaceAssets";
import { Icon } from "./Icons";
import { useWorkspace } from "./WorkspaceContext";
import { workspaceObjectMediaClient } from "./workspaceObjectMediaClient";
import type { WorkspaceObjectNode } from "./types";

const cloud = createCloudGenerationClient();
const supportedTypes = new Set(["image/jpeg", "image/png", "image/webp", "video/mp4", "video/quicktime"]);
const maxUploadBytes = 100 * 1024 * 1024;

export function ObjectMediaWorkspace({ object }: { object: WorkspaceObjectNode }) {
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

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError("");
    void workspaceObjectMediaClient.ensure(projectId, storyboardId, object.id, controller.signal)
      .then((loaded) => publishObjectMedia(object.id, loaded))
      .catch((cause: unknown) => {
        if (!controller.signal.aborted) setError(messageOf(cause));
      })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [object.id, projectId, publishObjectMedia, storyboardId]);

  useEffect(() => {
    if (media?.status !== "processing") return;
    const controller = new AbortController();
    const timer = window.setInterval(() => {
      void workspaceObjectMediaClient.get(projectId, media.id, controller.signal)
        .then((updated) => publishObjectMedia(object.id, updated)).catch((cause: unknown) => {
        if (!controller.signal.aborted) console.warn("媒体状态暂时不可用", cause);
      });
    }, 3_000);
    return () => { controller.abort(); window.clearInterval(timer); };
  }, [media?.id, media?.status, object.id, projectId, publishObjectMedia]);

  async function upload(file: File) {
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
  const referenceMedia = allItems
    .filter((item) => item.media.kind === "image" && item.media.status === "ready")
    .map((item) => ({ id: item.media.id, name: item.name }));

  return (
    <div className="canvas-body media-canvas-body">
      <section className="media-preview-workspace object-media-workspace" aria-label={`${label}工作区`}>
        <input ref={picker} type="file" hidden accept={kind === "image" ? "image/jpeg,image/png,image/webp" : "video/mp4,video/quicktime,.mov"}
          aria-label={`选择${label}文件`} onChange={(event) => {
            const file = event.currentTarget.files?.[0];
            event.currentTarget.value = "";
            if (file) void upload(file);
          }} />
        {media?.status === "ready" || media?.status === "processing" || media?.status === "failed" ? (
          <MediaViewer item={{ id: media.id, name: object.name, description: "", label, accent: "#aeb7ff", media }} />
        ) : (
          <button type="button" className={`object-media-upload-zone${dragging ? " is-dragging" : ""}`}
            disabled={loading || uploading}
            onClick={() => picker.current?.click()}
            onDragOver={(event) => { event.preventDefault(); setDragging(true); }}
            onDragLeave={() => setDragging(false)}
            onDrop={onDrop}>
            <span className="object-media-upload-icon"><Icon name={kind === "image" ? "image" : "film"} /></span>
            <strong>{uploading ? `正在上传${label}…` : loading ? `正在准备${label}…` : `点击上传${label}`}</strong>
            <span>{kind === "image" ? "支持 JPEG、PNG、WebP" : "支持 MP4、MOV"} · 也可拖放文件到这里</span>
          </button>
        )}
        {error ? <p className="object-media-error" role="alert">{error}</p> : null}
        <div className="media-prompt-dock">
          {media ? <MediaPromptComposer key={media.id} initialPrompt={media.prompt ?? ""} kind={kind}
            media={referenceMedia} assets={workspaceComposerAssets(current)} loadModels={loadGenerationModels}
            onGenerate={async (prompt, generation, idempotencyKey) => {
              const request = { prompt, expectedRevision: media.revision, generation };
              const job = import.meta.env.PROD
                ? await cloud.create(projectId, storyboardId, media.id, kind, request,
                    idempotencyKey, [...allItems.map((item) => item.media), media])
                : await mediaRequest<GenerationJob>(
                    `/api/v1/projects/${encodeURIComponent(projectId)}/storyboards/${encodeURIComponent(storyboardId)}/media/${encodeURIComponent(media.id)}/generations`,
                    { method: "POST", headers: { "Content-Type": "application/json", "Idempotency-Key": idempotencyKey },
                      body: JSON.stringify(request) },
                  );
              publishObjectMedia(object.id, {
                ...media, prompt, revision: job.targetRevision, status: "processing",
              });
              return job;
            }} /> : null}
        </div>
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
