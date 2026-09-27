import type { GenerationInputSelection, GenerationOptions, MediaKind } from "../productApi/generated";

export type GenerationImageFile = { id: string; file: File };

export function imageGenerationInput(
  referencedMediaIds: readonly string[],
  files: readonly GenerationImageFile[],
): GenerationInputSelection {
  const mediaIds = [...new Set([...referencedMediaIds, ...files.map((item) => item.id)])];
  if (mediaIds.length > 14) throw new Error("参考图片最多 14 张。");
  return mediaIds.length > 0 ? { type: "referenceImages", mediaIds } : { type: "textOnly" };
}

export function createDefaultGenerationOptions(kind: MediaKind): GenerationOptions {
  return {
    model: null,
    input: { type: "textOnly" },
    imageSize: kind === "image" ? "2K" : null,
    videoResolution: kind === "video" ? "480p" : null,
    videoRatio: kind === "video" ? "16:9" : null,
    durationSeconds: kind === "video" ? 4 : null,
    generateAudio: kind === "video" ? false : null,
  };
}
