import type { WorkspaceThreadBinding } from "../productApi/generated";
import type { Thread } from "../types";
import { fetchWithTimeout } from "../http/fetchWithTimeout";

export type { WorkspaceThreadBinding } from "../productApi/generated";

export type WorkspaceThreadScope = {
  projectId: string;
  storyboardId: string;
  storyboardName: string;
};

export interface WorkspaceThreadClient {
  list(scope: WorkspaceThreadScope, signal: AbortSignal): Promise<WorkspaceThreadBinding[]>;
  create(
    scope: WorkspaceThreadScope,
    idempotencyKey: string,
    signal: AbortSignal,
  ): Promise<WorkspaceThreadBinding>;
}

type RuntimeThreadCreator = {
  createThread(title?: string): Promise<Thread>;
};

function pathFor(scope: WorkspaceThreadScope) {
  return `/api/v1/projects/${encodeURIComponent(scope.projectId)}/storyboards/${encodeURIComponent(scope.storyboardId)}/ai-thread`;
}

function listPathFor(scope: WorkspaceThreadScope) {
  return `/api/v1/projects/${encodeURIComponent(scope.projectId)}/storyboards/${encodeURIComponent(scope.storyboardId)}/ai-threads`;
}

async function errorMessage(response: Response) {
  try {
    const body = await response.json() as { error?: string | { message?: string } };
    if (typeof body.error === "string") return body.error;
    if (body.error?.message) return body.error.message;
  } catch {
    // The HTTP status below is still actionable.
  }
  return `${response.status} ${response.statusText}`;
}

export function createHttpWorkspaceThreadClient(): WorkspaceThreadClient {
  return {
    async list(scope, signal) {
      const response = await fetchWithTimeout(listPathFor(scope), { signal });
      if (!response.ok) throw new Error(await errorMessage(response));
      return response.json() as Promise<WorkspaceThreadBinding[]>;
    },
    async create(scope, idempotencyKey, signal) {
      const response = await fetchWithTimeout(pathFor(scope), {
        method: "POST",
        headers: { "Idempotency-Key": idempotencyKey },
        signal,
      });
      if (!response.ok) throw new Error(await errorMessage(response));
      return response.json() as Promise<WorkspaceThreadBinding>;
    },
  };
}

export function createFixtureWorkspaceThreadClient(runtime: RuntimeThreadCreator): WorkspaceThreadClient {
  const bindings = new Map<string, WorkspaceThreadBinding[]>();
  const keyFor = (scope: WorkspaceThreadScope) =>
    `videoflow:workspace-thread:v1:${scope.projectId}:${scope.storyboardId}`;
  const readBindings = (scope: WorkspaceThreadScope) => {
    const key = keyFor(scope);
    const cached = bindings.get(key);
    if (cached) return cached;
    try {
      const stored = localStorage.getItem(key);
      if (!stored) return [];
      const parsed = JSON.parse(stored) as WorkspaceThreadBinding | WorkspaceThreadBinding[];
      const candidates = Array.isArray(parsed) ? parsed : [parsed];
      const valid = candidates.filter((binding) =>
        binding.projectId === scope.projectId && binding.storyboardId === scope.storyboardId &&
        typeof binding.threadId === "string" && binding.threadId,
      ).sort((left, right) => right.createdAt.localeCompare(left.createdAt));
      bindings.set(key, valid);
      return valid;
    } catch {
      return [];
    }
  };
  return {
    async list(scope) {
      return readBindings(scope);
    },
    async create(scope) {
      const thread = await runtime.createThread(`分镜 · ${scope.storyboardName}`);
      const binding = {
        projectId: scope.projectId,
        storyboardId: scope.storyboardId,
        threadId: thread.id,
        createdAt: thread.createdAt,
      };
      const key = keyFor(scope);
      const next = [binding, ...readBindings(scope).filter((item) => item.threadId !== binding.threadId)];
      bindings.set(key, next);
      localStorage.setItem(key, JSON.stringify(next));
      return binding;
    },
  };
}
