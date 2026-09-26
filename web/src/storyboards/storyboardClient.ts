import type {
  CreateStoryboardRequest,
  CreateStoryboardResponse,
  ReorderRequest,
  StoryboardDetail,
  StoryboardSummary,
  StoryboardWindow,
  StoryboardScript,
  UpdateScriptRequest,
  UpdateStoryboardRequest,
} from "../productApi/generated";
import { fetchWithTimeout } from "../http/fetchWithTimeout";

export interface StoryboardClient {
  create(
    projectId: string,
    request: CreateStoryboardRequest,
    idempotencyKey: string,
    signal?: AbortSignal,
  ): Promise<CreateStoryboardResponse>;
  listAll(projectId: string, signal?: AbortSignal): Promise<StoryboardSummary[]>;
  get(projectId: string, storyboardId: string, signal?: AbortSignal): Promise<StoryboardDetail>;
  update(projectId: string, storyboardId: string, request: UpdateStoryboardRequest, signal?: AbortSignal): Promise<StoryboardDetail>;
  delete(projectId: string, storyboardId: string, expectedRevision: number, signal?: AbortSignal): Promise<void>;
  duplicate(projectId: string, storyboardId: string, idempotencyKey: string, signal?: AbortSignal): Promise<StoryboardDetail>;
  reorder(projectId: string, storyboardId: string, request: ReorderRequest, idempotencyKey: string, signal?: AbortSignal): Promise<StoryboardDetail>;
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
    async listAll(projectId, signal) {
      const items: StoryboardSummary[] = [];
      let cursor: string | null = "0";
      while (cursor !== null) {
        const page: StoryboardWindow = await request<StoryboardWindow>(
          `${baseUrl}/projects/${encodeURIComponent(projectId)}/storyboards?cursor=${cursor}&before=0&after=100`,
          { signal },
        );
        items.push(...page.items);
        cursor = page.page.nextCursor;
      }
      return items;
    },
    get: (projectId, storyboardId, signal) => request<StoryboardDetail>(
      `${baseUrl}/projects/${encodeURIComponent(projectId)}/storyboards/${encodeURIComponent(storyboardId)}`,
      { signal },
    ),
    update: (projectId, storyboardId, body, signal) => request<StoryboardDetail>(
      `${baseUrl}/projects/${encodeURIComponent(projectId)}/storyboards/${encodeURIComponent(storyboardId)}`,
      { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal },
    ),
    delete: (projectId, storyboardId, expectedRevision, signal) => request<void>(
      `${baseUrl}/projects/${encodeURIComponent(projectId)}/storyboards/${encodeURIComponent(storyboardId)}?expectedRevision=${expectedRevision}`,
      { method: "DELETE", signal },
    ),
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
    duplicate: (projectId, storyboardId, idempotencyKey, signal) => request<StoryboardDetail>(
      `${baseUrl}/projects/${encodeURIComponent(projectId)}/storyboards/${encodeURIComponent(storyboardId)}/duplicate`,
      { method: "POST", headers: { "Idempotency-Key": idempotencyKey }, signal },
    ),
    reorder: (projectId, storyboardId, body, idempotencyKey, signal) => request<StoryboardDetail>(
      `${baseUrl}/projects/${encodeURIComponent(projectId)}/storyboards/${encodeURIComponent(storyboardId)}/reorder`,
      { method: "POST", headers: { "Content-Type": "application/json", "Idempotency-Key": idempotencyKey },
        body: JSON.stringify(body), signal },
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
  if (response.ok) return response.status === 204 ? undefined as T : response.json() as Promise<T>;
  let message = `${response.status} ${response.statusText}`;
  try {
    const body = (await response.json()) as { error?: { message?: string } | string };
    message = typeof body.error === "string" ? body.error : body.error?.message ?? message;
  } catch {
    // Preserve the HTTP fallback for non-JSON proxy errors.
  }
  throw new Error(message);
}
