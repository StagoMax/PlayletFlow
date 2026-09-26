import type {
  Asset,
  AssetBinding,
  AssetKind,
  AssetList,
  AssetSection,
  CopyAssetBindingsRequest,
  CopyAssetBindingsResponse,
  CreateAssetBindingsRequest,
} from "../productApi/generated";
import { fetchWithTimeout } from "../http/fetchWithTimeout";

export type AssetSearch = {
  type?: AssetKind;
  query?: string;
  cursor?: string;
  limit?: number;
};

export interface AssetWorkspaceClient {
  listSections(projectId: string, storyboardId: string, signal?: AbortSignal): Promise<AssetSection[]>;
  listBindings(projectId: string, storyboardId: string, signal?: AbortSignal): Promise<AssetBinding[]>;
  listAssets(projectId: string, search: AssetSearch, signal?: AbortSignal): Promise<AssetList>;
  createBindings(
    projectId: string,
    storyboardId: string,
    request: CreateAssetBindingsRequest,
    idempotencyKey: string,
    signal?: AbortSignal,
  ): Promise<AssetBinding[]>;
  copyBindings(
    projectId: string,
    sourceStoryboardId: string,
    request: CopyAssetBindingsRequest,
    idempotencyKey: string,
    signal?: AbortSignal,
  ): Promise<CopyAssetBindingsResponse>;
}

export class ProductApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
  ) {
    super(message);
  }
}

export function createAssetWorkspaceClient(baseUrl = "/api/v1"): AssetWorkspaceClient {
  return {
    listSections: (projectId, storyboardId, signal) =>
      request<AssetSection[]>(`${baseUrl}/projects/${segment(projectId)}/storyboards/${segment(storyboardId)}/asset-sections`, { signal }),
    listBindings: (projectId, storyboardId, signal) =>
      request<AssetBinding[]>(`${baseUrl}/projects/${segment(projectId)}/storyboards/${segment(storyboardId)}/asset-bindings`, { signal }),
    listAssets(projectId, search, signal) {
      const query = new URLSearchParams();
      if (search.type) query.set("type", search.type);
      if (search.query) query.set("query", search.query);
      if (search.cursor) query.set("cursor", search.cursor);
      query.set("limit", String(search.limit ?? 50));
      return request<AssetList>(`${baseUrl}/projects/${segment(projectId)}/assets?${query}`, { signal });
    },
    createBindings: (projectId, storyboardId, body, idempotencyKey, signal) =>
      request<AssetBinding[]>(`${baseUrl}/projects/${segment(projectId)}/storyboards/${segment(storyboardId)}/asset-bindings`, {
        method: "POST",
        headers: commandHeaders(idempotencyKey),
        body: JSON.stringify(body),
        signal,
      }),
    copyBindings: (projectId, sourceStoryboardId, body, idempotencyKey, signal) =>
      request<CopyAssetBindingsResponse>(`${baseUrl}/projects/${segment(projectId)}/storyboards/${segment(sourceStoryboardId)}/asset-bindings:copy`, {
        method: "POST",
        headers: commandHeaders(idempotencyKey),
        body: JSON.stringify(body),
        signal,
      }),
  };
}

export function assetKindLabel(kind: AssetKind) {
  return ({ character: "角色", scene: "场景", prop: "道具", custom: "自定义" } as const)[kind];
}

export function primaryRepresentation(asset: Asset) {
  return asset.representations.find((item) => item.mediaId !== null) ?? asset.representations[0] ?? null;
}

function commandHeaders(idempotencyKey: string) {
  return { "Content-Type": "application/json", "Idempotency-Key": idempotencyKey };
}

function segment(value: string) {
  return encodeURIComponent(value);
}

async function request<T>(url: string, init: RequestInit): Promise<T> {
  const response = await fetchWithTimeout(url, init);
  if (response.ok) return response.json() as Promise<T>;
  let message = `${response.status} ${response.statusText}`;
  let code: string | undefined;
  try {
    const body = (await response.json()) as { error?: { code?: string; message?: string } | string };
    if (typeof body.error === "string") message = body.error;
    else {
      message = body.error?.message ?? message;
      code = body.error?.code;
    }
  } catch {
    // Preserve the status fallback when the server did not return JSON.
  }
  throw new ProductApiError(message, response.status, code);
}
