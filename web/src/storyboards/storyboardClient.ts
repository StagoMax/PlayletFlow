import type {
  CreateStoryboardRequest,
  CreateStoryboardResponse,
  StoryboardScript,
  UpdateScriptRequest,
} from "../productApi/generated";
import { fetchWithTimeout } from "../http/fetchWithTimeout";

export interface StoryboardClient {
  create(
    projectId: string,
    request: CreateStoryboardRequest,
    idempotencyKey: string,
    signal?: AbortSignal,
  ): Promise<CreateStoryboardResponse>;
  getScript(projectId: string, storyboardId: string, signal?: AbortSignal): Promise<StoryboardScript>;
  updateScript(
    projectId: string,
    storyboardId: string,
    request: UpdateScriptRequest,
    signal?: AbortSignal,
  ): Promise<StoryboardScript>;
}

export function createStoryboardClient(baseUrl = "/api/v1"): StoryboardClient {
  const scriptUrl = (projectId: string, storyboardId: string) =>
    `${baseUrl}/projects/${encodeURIComponent(projectId)}/storyboards/${encodeURIComponent(storyboardId)}/script`;
  return {
    create: (projectId, body, idempotencyKey, signal) => request<CreateStoryboardResponse>(
      `${baseUrl}/projects/${encodeURIComponent(projectId)}/storyboards`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": idempotencyKey,
        },
        body: JSON.stringify(body),
        signal,
      },
    ),
    getScript: (projectId, storyboardId, signal) => request<StoryboardScript>(
      scriptUrl(projectId, storyboardId),
      { signal },
    ),
    updateScript: (projectId, storyboardId, body, signal) => request<StoryboardScript>(
      scriptUrl(projectId, storyboardId),
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal,
      },
    ),
  };
}

async function request<T>(url: string, init: RequestInit): Promise<T> {
  const response = await fetchWithTimeout(url, init);
  if (response.ok) return response.json() as Promise<T>;
  let message = `${response.status} ${response.statusText}`;
  try {
    const body = (await response.json()) as { error?: { message?: string } | string };
    message = typeof body.error === "string" ? body.error : body.error?.message ?? message;
  } catch {
    // Preserve the HTTP fallback for non-JSON proxy errors.
  }
  throw new Error(message);
}
