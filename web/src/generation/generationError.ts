type ErrorBody = {
  error?: string | { message?: string; code?: string; requestId?: string };
  message?: string;
};

export async function generationErrorMessage(response: Response): Promise<string> {
  let detail: string | undefined;
  let code: string | undefined;
  let requestId: string | undefined;
  try {
    const body = await response.json() as ErrorBody;
    if (typeof body.error === "string") detail = body.error;
    else if (body.error && typeof body.error === "object") {
      if (typeof body.error.message === "string") detail = body.error.message;
      if (typeof body.error.code === "string") code = body.error.code;
      if (typeof body.error.requestId === "string") requestId = body.error.requestId;
    }
    if (!detail && typeof body.message === "string") detail = body.message;
  } catch {
    // Proxies can return plain text or HTML; the HTTP status still explains the failure.
  }

  const providerDetail = [detail?.trim(), code && !detail?.includes(code) ? `错误代码：${code}` : undefined,
    requestId ? `请求 ID：${requestId}` : undefined].filter(Boolean).join("；");
  if (response.status === 413) {
    const reason = "生成请求内容过大（HTTP 413）。请减少参考图片数量，或压缩图片后重试。";
    return providerDetail ? `${reason} 服务返回：${providerDetail}` : reason;
  }
  if (providerDetail) return providerDetail;

  const reason: Record<number, string> = {
    400: "生成请求参数有误，请检查提示词和生成设置。",
    401: "生成服务认证失败，请检查服务配置。",
    403: "生成服务拒绝了请求，请检查账号权限或生成内容。",
    404: "生成任务或模型不存在，请重新选择模型后重试。",
    408: "生成请求超时，请稍后重试。",
    409: "生成内容已发生变化，请刷新后重试。",
    415: "参考图片格式不受支持，请使用 JPEG、PNG 或 WebP。",
    422: "生成请求参数不符合模型要求，请检查生成设置。",
    429: "生成请求过于频繁，请稍后重试。",
    500: "生成服务暂时出错，请稍后重试。",
    502: "上游生成服务暂时出错，请稍后重试。",
    503: "生成服务暂时不可用，请稍后重试。",
    504: "生成服务响应超时，请稍后重试。",
  };
  return `${reason[response.status] ?? "生成请求失败，请稍后重试。"}（HTTP ${response.status}）`;
}
