export async function prepareImageBlob(source: Blob, signal?: AbortSignal, declaredType = source.type): Promise<Blob> {
  const mimeType = source.type || declaredType;
  if (["image/jpeg", "image/png", "image/webp"].includes(mimeType)) {
    return source.type ? source : source.slice(0, source.size, mimeType);
  }
  if (mimeType !== "image/svg+xml") {
    throw new Error("参考图片必须是 JPEG、PNG 或 WebP 格式。");
  }
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
    return new Promise<Blob>((resolve, reject) => {
      canvas.toBlob(
        (blob) => blob ? resolve(blob) : reject(new Error("浏览器无法转换参考图片。")),
        "image/png",
      );
    });
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

export async function fitGenerationImageBlob(source: Blob, byteBudget: number, signal?: AbortSignal): Promise<Blob> {
  if (source.size <= byteBudget) return source;
  if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
  const bitmap = await createImageBitmap(source);
  try {
    let scale = Math.min(1, 2048 / Math.max(bitmap.width, bitmap.height));
    for (let sizeAttempt = 0; sizeAttempt < 4; sizeAttempt++) {
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(bitmap.width * scale));
      canvas.height = Math.max(1, Math.round(bitmap.height * scale));
      const context = canvas.getContext("2d");
      if (!context) throw new Error("浏览器无法压缩参考图片。");
      context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      for (const quality of [0.88, 0.76, 0.64]) {
        if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
        const result = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", quality));
        if (result && result.size <= byteBudget) return result;
      }
      scale *= 0.75;
    }
    throw new Error("参考图片无法压缩到生成服务允许的大小。");
  } finally {
    bitmap.close();
  }
}

export function blobBase64(blob: Blob): Promise<string> {
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
