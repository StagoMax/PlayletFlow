import type {
  GenerationModel,
  GenerationOptions,
  MediaItem,
  MediaKind,
  RequestMediaGeneration,
} from "../productApi/generated";
import type { WorkspaceGenerationJob } from "../workspace/workspaceClient";
import type { GenerationImageFile } from "./generationOptions";
import { blobBase64, fitGenerationImageBlob, prepareImageBlob } from "./imageInput";

export type InputPayload = {
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
    imageFiles?: readonly GenerationImageFile[],
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
      imageFiles = [],
    ) {
      const inputs = await inputPayloads(request.generation, availableMedia, imageFiles, signal);
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

export async function inputPayloads(
  generation: GenerationOptions | null | undefined,
  availableMedia: readonly MediaItem[],
  imageFiles: readonly GenerationImageFile[],
  signal?: AbortSignal,
): Promise<InputPayload[]> {
  const ids = selectedInputIds(generation);
  const byteBudget = Math.min(8 * 1024 * 1024, Math.floor(18 * 1024 * 1024 / Math.max(1, ids.length)));
  const byId = new Map(availableMedia.map((media) => [media.id, media]));
  const filesById = new Map(imageFiles.map((item) => [item.id, item.file]));
  return Promise.all(ids.map(async (mediaId) => {
    const file = filesById.get(mediaId);
    if (file) return encodedInput(mediaId, await fitGenerationImageBlob(await prepareImageBlob(file, signal), byteBudget, signal));
    const media = byId.get(mediaId);
    if (!media || media.kind !== "image" || media.status !== "ready") {
      throw new Error("所选首尾帧或关键帧当前不可用。");
    }
    const url = media.preview?.url ?? media.thumbnail?.url;
    if (!url) throw new Error("所选参考图片没有可读取的预览地址。");
    return encodedInput(mediaId, await fitGenerationImageBlob(await supportedImageBlob(url, media.mimeType, signal), byteBudget, signal));
  }));
}

async function encodedInput(mediaId: string, blob: Blob): Promise<InputPayload> {
  if (blob.size > 8 * 1024 * 1024) throw new Error("单张参考图片不能超过 8 MB。");
  return { mediaId, mimeType: blob.type, dataBase64: await blobBase64(blob) };
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
  return prepareImageBlob(await response.blob(), signal, declaredType);
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
