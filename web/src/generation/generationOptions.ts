import type { GenerationOptions, MediaKind } from "../productApi/generated";

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
