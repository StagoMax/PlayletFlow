import type {
  GenerationModel,
  GenerationOptions,
  MediaItem,
  MediaKind,
  RequestMediaGeneration,
} from "../productApi/generated";
import type { WorkspaceGenerationJob } from "../workspace/workspaceClient";

type InputPayload = {
  mediaId: string;
  mimeType: string;
  dataBase64: string;
};

export type CloudGenerationClient = {
  listModels(signal?: AbortSignal): Promise<GenerationModel[]>;
  create(
    projectId: string,
    storyboardId: string,
    mediaId: string,
    kind: MediaKind,
    request: RequestMediaGeneration,
    idempotencyKey: string,
    availableMedia: readonly MediaItem[],
    signal?: AbortSignal,
  ): Promise<WorkspaceGenerationJob>;
  get(projectId: string, jobId: string, signal?: AbortSignal): Promise<WorkspaceGenerationJob>;
};

export function createCloudGenerationClient(baseUrl = "/api/v1"): CloudGenerationClient {
  return {
    listModels: (signal) => http<GenerationModel[]>(`${baseUrl}/generation-models`, { signal }),
    async create(
      projectId,
      storyboardId,
      mediaId,
      kind,
      request,
      idempotencyKey,
      availableMedia,
      signal,
    ) {
      const inputs = await inputPayloads(request.generation, availableMedia, signal);
      return http<WorkspaceGenerationJob>(
        `${baseUrl}/projects/${segment(projectId)}/storyboards/${segment(storyboardId)}/media/${segment(mediaId)}/generations`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Idempotency-Key": idempotencyKey,
          },
          body: JSON.stringify({ ...request, kind, inputs }),
          signal,
        },
      );
    },
    get: (projectId, jobId, signal) => http<WorkspaceGenerationJob>(
      `${baseUrl}/projects/${segment(projectId)}/generation-jobs/${segment(jobId)}`,
      { signal },
    ),
  };
}

async function inputPayloads(
  generation: GenerationOptions | null | undefined,
  availableMedia: readonly MediaItem[],
  signal?: AbortSignal,
): Promise<InputPayload[]> {
  const ids = selectedInputIds(generation);
  const byId = new Map(availableMedia.map((media) => [media.id, media]));
  return Promise.all(ids.map(async (mediaId) => {
    const media = byId.get(mediaId);
    if (!media || media.kind !== "image" || media.status !== "ready") {
      throw new Error("所选首尾帧或关键帧当前不可用。");
    }
    const url = media.preview?.url ?? media.thumbnail?.url;
    if (!url) throw new Error("所选参考图片没有可读取的预览地址。");
    const blob = await supportedImageBlob(url, media.mimeType, signal);
    if (blob.size > 8 * 1024 * 1024) {
      throw new Error("单张参考图片不能超过 8 MB。");
    }
    return {
      mediaId,
      mimeType: blob.type,
      dataBase64: await blobBase64(blob),
    };
  }));
}

function selectedInputIds(generation: GenerationOptions | null | undefined) {
  const input = generation?.input;
  if (!input || input.type === "textOnly") return [];
  if (input.type === "referenceImages") return input.mediaIds;
  return [input.firstFrameMediaId, input.lastFrameMediaId].filter(
    (value): value is string => Boolean(value),
  );
}

async function supportedImageBlob(url: string, declaredType: string, signal?: AbortSignal) {
  const response = await fetch(url, { signal });
  if (!response.ok) throw new Error("读取参考图片失败，请刷新后重试。");
  const source = await response.blob();
  const mimeType = source.type || declaredType;
  if (["image/jpeg", "image/png", "image/webp"].includes(mimeType)) {
    return source.type ? source : source.slice(0, source.size, mimeType);
  }
  if (mimeType !== "image/svg+xml") {
    throw new Error("参考图片必须是 JPEG、PNG 或 WebP 格式。");
  }
  return rasterize(source, signal);
}

async function rasterize(source: Blob, signal?: AbortSignal): Promise<Blob> {
  if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
  const objectUrl = URL.createObjectURL(source);
  try {
    const image = new Image();
    image.decoding = "async";
    image.src = objectUrl;
    await image.decode();
    if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
    const canvas = document.createElement("canvas");
    canvas.width = image.naturalWidth;
    canvas.height = image.naturalHeight;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("浏览器无法转换参考图片。");
    context.drawImage(image, 0, 0);
    return await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob(
        (blob) => blob ? resolve(blob) : reject(new Error("浏览器无法转换参考图片。")),
        "image/png",
      );
    });
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

function blobBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error("读取参考图片失败。"));
    reader.onload = () => {
      const value = String(reader.result ?? "");
      const separator = value.indexOf(",");
      if (separator < 0) reject(new Error("参考图片编码失败。"));
      else resolve(value.slice(separator + 1));
    };
    reader.readAsDataURL(blob);
  });
}

async function http<T>(url: string, init: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  if (response.ok) return response.json() as Promise<T>;
  let message = `${response.status} ${response.statusText}`;
  try {
    const body = await response.json() as { error?: string };
    if (body.error) message = body.error;
  } catch {
    // Retain the HTTP status when the body is not JSON.
  }
  throw new Error(message);
}

function segment(value: string) {
  return encodeURIComponent(value);
}
