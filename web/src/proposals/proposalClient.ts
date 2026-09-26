import type {
  ApplyProposalResponse,
  ChangeProposal,
  GenerationModel,
  GenerationJob,
  ProposalStatus,
  ResolveProposalRequest,
} from "../productApi/generated";

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
    apply: (projectId, proposalId, body, idempotencyKey, signal) =>
      request<ApplyProposalResponse>(
        `${baseUrl}/projects/${segment(projectId)}/proposals/${segment(proposalId)}/apply`,
        command(body, idempotencyKey, signal),
      ),
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
    body: JSON.stringify(body),
    signal,
  };
}

function segment(value: string) {
  return encodeURIComponent(value);
}

async function request<T>(url: string, init: RequestInit): Promise<T> {
  const response = await fetch(url, init);
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
