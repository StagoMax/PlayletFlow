import {
  generationInputByteBudget,
  generationRequestBody,
  MAX_GENERATION_REQUEST_BYTES,
} from "./cloudGenerationClient";

type TestResult = { ok: boolean; message: string };

function sampleRequest(imageCount: number) {
  const imageBytes = generationInputByteBudget(imageCount);
  const encodedImage = "A".repeat(4 * Math.ceil(imageBytes / 3));
  return {
    prompt: "参考图片".repeat(2_000),
    kind: "image",
    generation: { input: { type: "referenceImages", mediaIds: Array.from({ length: imageCount }, (_, index) => `image-${index}`) } },
    inputs: Array.from({ length: imageCount }, (_, index) => ({
      mediaId: `image-${index}`,
      mimeType: "image/jpeg",
      dataBase64: encodedImage,
    })),
  };
}

export const generationTestCases: Record<string, () => TestResult> = {
  "image requests fit the Vercel body limit with one or fourteen references"() {
    for (const count of [1, 6, 14]) {
      const body = generationRequestBody(sampleRequest(count));
      if (new TextEncoder().encode(body).byteLength > MAX_GENERATION_REQUEST_BYTES) {
        return { ok: false, message: `${count} references exceeded the request budget` };
      }
    }
    return { ok: true, message: "image request budgets include base64 expansion" };
  },
  "oversized generation requests fail before fetch"() {
    try {
      generationRequestBody({ prompt: "A".repeat(MAX_GENERATION_REQUEST_BYTES + 1) });
      return { ok: false, message: "oversized request was accepted" };
    } catch (error) {
      return {
        ok: error instanceof Error && error.message.includes("生成请求过大"),
        message: "oversized request reports an actionable error",
      };
    }
  },
};
