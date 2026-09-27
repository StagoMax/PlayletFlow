import type { GenerationImageFile } from "./generationOptions";
import { prepareImageBlob } from "./imageInput";

export async function uploadLocalGenerationInputs(
  projectId: string,
  storyboardId: string,
  files: readonly GenerationImageFile[],
) {
  for (const { id, file } of files) {
    const blob = await prepareImageBlob(file);
    if (blob.size === 0 || blob.size > 8 * 1024 * 1024) {
      throw new Error("单张参考图片不能超过 8 MB。");
    }
    const { width, height } = await imageDimensions(blob);
    const query = new URLSearchParams({ name: file.name, width: String(width), height: String(height) });
    const response = await fetch(
      `/api/v1/projects/${encodeURIComponent(projectId)}/storyboards/${encodeURIComponent(storyboardId)}/generation-inputs/${encodeURIComponent(id)}?${query}`,
      { method: "PUT", headers: { "Content-Type": blob.type }, body: blob },
    );
    if (!response.ok) {
      let message = `参考图片上传失败：${response.status}`;
      try {
        const body = await response.json() as { error?: { message?: string } | string };
        message = typeof body.error === "string" ? body.error : body.error?.message ?? message;
      } catch { /* retain the HTTP status */ }
      throw new Error(message);
    }
  }
}

async function imageDimensions(blob: Blob): Promise<{ width: number; height: number }> {
  const url = URL.createObjectURL(blob);
  try {
    const image = new Image();
    image.src = url;
    await image.decode();
    return { width: image.naturalWidth, height: image.naturalHeight };
  } finally {
    URL.revokeObjectURL(url);
  }
}
