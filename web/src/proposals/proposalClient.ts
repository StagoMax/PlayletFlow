import type {
  ApplyProposalResponse,
  ChangeProposal,
  GenerationModel,
  GenerationJob,
  ProposalStatus,
  ResolveProposalRequest,
} from "../productApi/generated";
import { cloudWorkspaceKey, flushCloudWorkspace, readCloudWorkspace } from "../workspace/cloudWorkspaceSync";
import { hydrateBrowserWorkspaceMedia, saveBrowserWorkspace } from "../workspace/browserWorkspaceStorage";
import type { WorkspaceSnapshot } from "../workspace/types";
import { generationRequestBody, inputPayloads } from "../generation/cloudGenerationClient";

export interface ProposalClient {
  listGenerationModels(signal?: AbortSignal): Promise<GenerationModel[]>;
  list(
    projectId: string,
    storyboardId: string,
    statuses: ProposalStatus[],
    signal?: AbortSignal,
  ): Promise<ChangeProposal[]>;
  get(projectId: string, proposalId: string, signal?: AbortSignal): Promise<ChangeProposal>;
  getGeneration(projectId: string, jobId: string, signal?: AbortSignal): Promise<GenerationJob>;
  apply(
    projectId: string,
    proposalId: string,
    body: ResolveProposalRequest,
    idempotencyKey: string,
    signal?: AbortSignal,
  ): Promise<ApplyProposalResponse>;
  reject(
    projectId: string,
    proposalId: string,
    body: ResolveProposalRequest,
    idempotencyKey: string,
    signal?: AbortSignal,
  ): Promise<ChangeProposal>;
}

export class ProposalApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
    readonly requestId?: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "ProposalApiError";
  }
}

export function createProposalClient(baseUrl = "/api/v1"): ProposalClient {
  return {
    listGenerationModels: (signal) => request<GenerationModel[]>(`${baseUrl}/generation-models`, { signal }),
    list(projectId, storyboardId, statuses, signal) {
      const query = new URLSearchParams();
      if (statuses.length > 0) query.set("status", statuses.join(","));
      const suffix = query.size > 0 ? `?${query}` : "";
      return request<ChangeProposal[]>(
        `${baseUrl}/projects/${segment(projectId)}/storyboards/${segment(storyboardId)}/proposals${suffix}`,
        { signal },
      );
    },
    get: (projectId, proposalId, signal) =>
      request<ChangeProposal>(`${baseUrl}/projects/${segment(projectId)}/proposals/${segment(proposalId)}`, { signal }),
    getGeneration: (projectId, jobId, signal) =>
      request<GenerationJob>(
        `${baseUrl}/projects/${segment(projectId)}/generation-jobs/${segment(jobId)}`,
        { signal },
      ),
    apply: async (projectId, proposalId, body, idempotencyKey, signal) => {
      if (import.meta.env.PROD) await flushCloudWorkspace();
      let commandBody: ResolveProposalRequest & { inputs?: Awaited<ReturnType<typeof inputPayloads>> } = body;
      if (import.meta.env.PROD) {
        const proposal = await request<ChangeProposal>(
          `${baseUrl}/projects/${segment(projectId)}/proposals/${segment(proposalId)}`, { signal },
        );
        if (proposal.target.type !== "script") {
          const snapshot = await hydrateBrowserWorkspaceMedia(
            (await readCloudWorkspace()) as WorkspaceSnapshot,
          );
          const availableMedia = [
            ...Object.values(snapshot.objectMedia ?? {}),
            ...Object.values(snapshot.workspaces).flatMap((workspace) =>
              [...workspace.assetGroups, ...workspace.videoGroups].flatMap((group) => group.items.map((item) => item.media))),
          ];
          const input = proposal.proposedInput ?? { type: "textOnly" as const };
          commandBody = { ...body, inputs: await inputPayloads({ ...body.generation, input }, availableMedia, [], signal) };
        }
      }
      const result = await request<ApplyProposalResponse>(
        `${baseUrl}/projects/${segment(projectId)}/proposals/${segment(proposalId)}/apply`,
        command(commandBody, idempotencyKey, signal),
      );
      if (import.meta.env.PROD) {
        const snapshot = await readCloudWorkspace();
        if (snapshot) {
          const hydrated = await hydrateBrowserWorkspaceMedia(snapshot);
          saveBrowserWorkspace(hydrated, false);
          window.dispatchEvent(new CustomEvent<WorkspaceSnapshot>("videoflow:cloud-workspace-updated", { detail: hydrated }));
        }
      }
      return result;
    },
    reject: (projectId, proposalId, body, idempotencyKey, signal) =>
      request<ChangeProposal>(
        `${baseUrl}/projects/${segment(projectId)}/proposals/${segment(proposalId)}/reject`,
        command(body, idempotencyKey, signal),
      ),
  };
}

function command(body: ResolveProposalRequest, idempotencyKey: string, signal?: AbortSignal): RequestInit {
  return {
    method: "POST",
    headers: { "Content-Type": "application/json", "Idempotency-Key": idempotencyKey },
    body: generationRequestBody(body),
    signal,
  };
}

function segment(value: string) {
  return encodeURIComponent(value);
}

async function request<T>(url: string, init: RequestInit): Promise<T> {
  const response = await fetch(url, {
    ...init,
    headers: { ...(init.headers as Record<string, string> | undefined),
      ...(import.meta.env.PROD ? { "X-Videoflow-Workspace-Key": cloudWorkspaceKey() } : {}) },
  });
  if (response.ok) return response.json() as Promise<T>;

  let message = `${response.status} ${response.statusText}`;
  let code: string | undefined;
  let requestId: string | undefined;
  let details: Record<string, unknown> | undefined;
  try {
    const body = (await response.json()) as {
      error?: {
        code?: string;
        message?: string;
        requestId?: string;
        details?: Record<string, unknown>;
      } | string;
    };
    if (typeof body.error === "string") message = body.error;
    else if (body.error) {
      message = body.error.message ?? message;
      code = body.error.code;
      requestId = body.error.requestId;
      details = body.error.details;
    }
  } catch {
    // Keep the HTTP status fallback when the response is not JSON.
  }
  throw new ProposalApiError(message, response.status, code, requestId, details);
}
