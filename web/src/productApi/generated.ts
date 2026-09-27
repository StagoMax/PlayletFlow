/* eslint-disable */
// This file is generated from docs/openapi.json. Do not edit it by hand.
// Contract SHA-256: 4cf8c4b9a50b51bf3a3a191c799178741653a99f500fc7fe3c1dff53bbb0011d

export type Page = {
  nextCursor: string | null;
  total: number;
};

export type ErrorDetail = Record<string, unknown>;

export type ApiError = {
  code: string;
  message: string;
  requestId: string;
  details: ErrorDetail;
};

export type ErrorEnvelope = {
  error: ApiError;
};

export type Project = {
  id: string;
  name: string;
  revision: number;
  createdAt: string;
  updatedAt: string;
};

export type ProjectList = {
  items: Array<Project>;
  page: Page;
};

export type CreateProjectRequest = {
  name: string;
};

export type UpdateProjectRequest = {
  name: string;
  expectedRevision: number;
};

export type MediaThumbnail = {
  url: string;
  expiresAt: string | null;
  width: number;
  height: number;
};

export type MediaAccess = (MediaThumbnail) & ({
  mimeType: string;
});

export type StoryboardScript = {
  text: string;
  revision: number;
  updatedAt: string;
};

export type StoryboardSummary = {
  id: string;
  projectId: string;
  name: string;
  position: string;
  index: number;
  revision: number;
  pendingProposalCount: number;
  thumbnail: MediaThumbnail | null;
  updatedAt: string;
};

export type StoryboardDetail = (StoryboardSummary) & ({
  script: StoryboardScript;
  counts: {
    assetBindings: number;
    keyframes: number;
    videos: number;
  };
  createdAt: string;
});

export type StoryboardWindowPage = {
  anchorId: string | null;
  anchorIndex: number | null;
  total: number;
  hasBefore: boolean;
  hasAfter: boolean;
  previousCursor: string | null;
  nextCursor: string | null;
};

export type StoryboardWindow = {
  items: Array<StoryboardSummary>;
  page: StoryboardWindowPage;
};

export type ReuseAssetsFrom = {
  storyboardId: string;
  bindingIds: Array<string>;
  includePromptOverrides: boolean;
};

export type CreateStoryboardRequest = {
  name: string;
  insertAfterId: string | null;
  reuseAssetsFrom?: ReuseAssetsFrom | null;
};

export type CopyFailure = {
  bindingId: string;
  reason: string;
};

export type AssetCopySummary = {
  created: number;
  skipped: number;
  failed: Array<CopyFailure>;
};

export type CreateStoryboardResponse = {
  storyboard: StoryboardDetail;
  assetCopy: AssetCopySummary;
};

export type UpdateStoryboardRequest = {
  name: string;
  expectedRevision: number;
};

export type ReorderRequest = {
  beforeId: string | null;
  afterId: string | null;
  expectedRevision: number;
};

export type UpdateScriptRequest = {
  text: string;
  expectedRevision: number;
};

export type WorkspaceNodeKind = "folder" | "object";

export type WorkspaceObjectType = "text" | "image" | "video";

export type WorkspaceTargetType = "script" | "media" | "empty";

export type WorkspaceNode = {
  id: string;
  projectId: string;
  storyboardId: string;
  parentId: string | null;
  kind: WorkspaceNodeKind;
  name: string;
  objectType: WorkspaceObjectType | null;
  targetType: WorkspaceTargetType | null;
  targetId: string | null;
  position: string;
  revision: number;
  createdAt: string;
  updatedAt: string;
  unseenUpdateAt: string | null;
};

export type CreateWorkspaceNodeRequest = {
  parentId: string | null;
  kind: WorkspaceNodeKind;
  name: string;
  objectType: WorkspaceObjectType | null;
};

export type UpdateWorkspaceNodeRequest = {
  parentId: string | null;
  name: string;
  expectedRevision: number;
};

export type MarkWorkspaceNodeViewedRequest = {
  seenThrough: string;
};

export type ReorderWorkspaceNodeRequest = {
  beforeId: string | null;
  afterId: string | null;
  expectedRevision: number;
};

export type AssetKind = "character" | "scene" | "prop" | "custom";

export type AssetSection = {
  id: string;
  storyboardId: string;
  parentId: string | null;
  name: string;
  kind: AssetKind;
  position: string;
  revision: number;
  bindingCount: number;
};

export type CreateAssetSectionRequest = {
  parentId: string | null;
  name: string;
  kind: AssetKind;
};

export type UpdateAssetSectionRequest = {
  name: string;
  kind: AssetKind;
  parentId: string | null;
  expectedRevision: number;
};

export type ViewKind = "front" | "back" | "side" | "top" | "threeView" | "custom";

export type AssetRepresentation = {
  id: string;
  assetId: string;
  label: string;
  viewKind: ViewKind;
  mediaId: string | null;
  position: string;
};

export type Asset = {
  id: string;
  projectId: string;
  type: AssetKind;
  name: string;
  description: string | null;
  canonicalPrompt: string | null;
  revision: number;
  referenceCount: number;
  representations: Array<AssetRepresentation>;
  createdAt: string;
  updatedAt: string;
};

export type AssetList = {
  items: Array<Asset>;
  page: Page;
};

export type CreateAssetRequest = {
  type: AssetKind;
  name: string;
  description: string | null;
  canonicalPrompt: string | null;
};

export type UpdateAssetRequest = (CreateAssetRequest) & ({
  expectedRevision: number;
});

export type CreateAssetRepresentationRequest = {
  label: string;
  viewKind: ViewKind;
  mediaId: string | null;
};

export type AssetBinding = {
  id: string;
  storyboardId: string;
  sectionId: string;
  assetId: string;
  position: string;
  promptOverride: string | null;
  derivedMediaId: string | null;
  revision: number;
  asset: Asset;
};

export type CreateAssetBindingsRequest = {
  sectionId: string;
  assetIds: Array<string>;
};

export type UpdateAssetBindingRequest = {
  sectionId: string;
  promptOverride: string | null;
  beforeId?: string | null;
  afterId?: string | null;
  expectedRevision: number;
};

export type DuplicateBindingStrategy = "skip";

export type CopyAssetBindingsRequest = {
  targetStoryboardId: string;
  bindingIds: Array<string>;
  includeSectionStructure: boolean;
  targetSectionId: string | null;
  includePromptOverrides: boolean;
  onDuplicate: DuplicateBindingStrategy;
};

export type CopyAssetBindingsResponse = {
  createdBindingIds: Array<string>;
  skipped: Array<CopyFailure>;
  sectionMap: Record<string, string>;
};

export type MediaKind = "image" | "video";

export type MediaRole = "assetView" | "firstFrame" | "lastFrame" | "keyframe" | "generatedVideo" | "custom";

export type MediaStatus = "placeholder" | "ready" | "processing" | "failed";

export type MediaOwner = {
  type: "asset";
  assetId: string;
} | {
  type: "storyboard";
  storyboardId: string;
};

export type MediaGeneration = {
  jobId: string;
  provider: string | null;
  model: string | null;
  error: string | null;
};

export type MediaItem = {
  id: string;
  projectId: string;
  owner: MediaOwner;
  kind: MediaKind;
  role: MediaRole;
  name: string;
  prompt: string | null;
  mimeType: string;
  width: number | null;
  height: number | null;
  durationMs: number | null;
  status: MediaStatus;
  revision: number;
  thumbnail: MediaThumbnail | null;
  preview: MediaAccess | null;
  generation: MediaGeneration | null;
  createdAt: string;
  updatedAt: string;
};

export type MediaList = {
  items: Array<MediaItem>;
  page: Page;
};

export type UpdateMediaRequest = {
  name: string;
  prompt: string | null;
  expectedRevision: number;
};

export type RequestMediaGeneration = {
  prompt: string;
  expectedRevision: number;
  generation?: GenerationOptions | null;
};

export type MediaAccessResponse = {
  thumbnail: MediaThumbnail | null;
  preview: MediaAccess | null;
};

export type ProposalTarget = {
  type: "script";
  storyboardId: string;
} | {
  type: "mediaPrompt";
  mediaId: string;
} | {
  type: "assetBindingPrompt";
  bindingId: string;
};

export type ProposalStatus = "pending" | "applying" | "applied" | "rejected" | "conflicted" | "expired" | "failed";

export type ProposalSource = {
  type: "ai";
  threadId: string;
  turnId: string;
  toolCallId: string;
};

export type ChangeProposal = {
  id: string;
  projectId: string;
  storyboardId: string;
  target: ProposalTarget;
  baseRevision: number;
  beforeValue: string;
  proposedValue: string;
  proposedInput?: GenerationInputSelection | null;
  summary: string;
  status: ProposalStatus;
  source: ProposalSource;
  revision: number;
  createdAt: string;
  resolvedAt: string | null;
};

export type ResolveProposalRequest = {
  expectedProposalRevision: number;
  expectedTargetRevision: number;
  generation?: GenerationOptions | null;
};

export type GenerationInputSelection = {
  type: "textOnly";
} | {
  type: "firstLastFrames";
  firstFrameMediaId: string;
  lastFrameMediaId: string | null;
} | {
  type: "referenceImages";
  mediaIds: Array<string>;
};

export type GenerationOptions = {
  model?: string | null;
  input?: GenerationInputSelection;
  imageSize?: string | null;
  videoResolution?: string | null;
  videoRatio?: string | null;
  durationSeconds?: number | null;
  generateAudio?: boolean | null;
};

export type GenerationSpec = {
  model: string;
  input: GenerationInputSelection;
  imageSize: string | null;
  videoResolution: string | null;
  videoRatio: string | null;
  durationSeconds: number | null;
  generateAudio: boolean | null;
};

export type GenerationModel = {
  id: string;
  label: string;
  kind: MediaKind;
  supportsFirstLastFrames: boolean;
  maxReferenceImages: number;
  minDurationSeconds: number | null;
  maxDurationSeconds: number | null;
};

export type GenerationStatus = "queued" | "waitingForProvider" | "running" | "succeeded" | "failed" | "cancelled";

export type GenerationJob = {
  id: string;
  projectId: string;
  storyboardId: string;
  proposalId: string | null;
  targetType: "mediaPrompt" | "assetBindingPrompt";
  targetId: string;
  targetRevision: number;
  spec: GenerationSpec;
  status: GenerationStatus;
  attempt: number;
  provider: string | null;
  resultMediaId: string | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
};

export type ApplyProposalTarget = {
  type: "script" | "mediaPrompt" | "assetBindingPrompt";
  revision: number;
};

export type ApplyProposalResponse = {
  proposal: ChangeProposal;
  target: ApplyProposalTarget;
  generationJob: GenerationJob | null;
};

export type WorkspaceThreadBinding = {
  projectId: string;
  storyboardId: string;
  threadId: string;
  createdAt: string;
};

export type ProjectEvent = {
  id: string;
  projectId: string;
  seq: number;
  occurredAt: string;
  type: string;
  payload: Record<string, unknown>;
};

export type ProductApiOperation =
  | "GET /projects"
  | "POST /projects"
  | "GET /projects/{projectId}"
  | "PATCH /projects/{projectId}"
  | "GET /projects/{projectId}/storyboards"
  | "POST /projects/{projectId}/storyboards"
  | "GET /projects/{projectId}/storyboards/{storyboardId}"
  | "PATCH /projects/{projectId}/storyboards/{storyboardId}"
  | "DELETE /projects/{projectId}/storyboards/{storyboardId}"
  | "POST /projects/{projectId}/storyboards/{storyboardId}/restore"
  | "POST /projects/{projectId}/storyboards/{storyboardId}/reorder"
  | "POST /projects/{projectId}/storyboards/{storyboardId}/duplicate"
  | "GET /projects/{projectId}/storyboards/{storyboardId}/script"
  | "PATCH /projects/{projectId}/storyboards/{storyboardId}/script"
  | "GET /projects/{projectId}/storyboards/{storyboardId}/workspace-nodes"
  | "POST /projects/{projectId}/storyboards/{storyboardId}/workspace-nodes"
  | "PATCH /projects/{projectId}/storyboards/{storyboardId}/workspace-nodes/{nodeId}"
  | "DELETE /projects/{projectId}/storyboards/{storyboardId}/workspace-nodes/{nodeId}"
  | "POST /projects/{projectId}/storyboards/{storyboardId}/workspace-nodes/{nodeId}/copies"
  | "PATCH /projects/{projectId}/storyboards/{storyboardId}/workspace-nodes/{nodeId}/order"
  | "PUT /projects/{projectId}/storyboards/{storyboardId}/workspace-nodes/{nodeId}/viewed"
  | "POST /projects/{projectId}/storyboards/{storyboardId}/workspace-nodes/{nodeId}/media"
  | "PUT /projects/{projectId}/storyboards/{storyboardId}/workspace-nodes/{nodeId}/media"
  | "PUT /projects/{projectId}/storyboards/{storyboardId}/generation-inputs/{inputId}"
  | "GET /projects/{projectId}/storyboards/{storyboardId}/asset-sections"
  | "POST /projects/{projectId}/storyboards/{storyboardId}/asset-sections"
  | "PATCH /projects/{projectId}/storyboards/{storyboardId}/asset-sections/{sectionId}"
  | "DELETE /projects/{projectId}/storyboards/{storyboardId}/asset-sections/{sectionId}"
  | "POST /projects/{projectId}/storyboards/{storyboardId}/asset-sections/{sectionId}/reorder"
  | "GET /projects/{projectId}/assets"
  | "POST /projects/{projectId}/assets"
  | "GET /projects/{projectId}/assets/{assetId}"
  | "PATCH /projects/{projectId}/assets/{assetId}"
  | "DELETE /projects/{projectId}/assets/{assetId}"
  | "POST /projects/{projectId}/assets/{assetId}/representations"
  | "GET /projects/{projectId}/storyboards/{storyboardId}/asset-bindings"
  | "POST /projects/{projectId}/storyboards/{storyboardId}/asset-bindings"
  | "PATCH /projects/{projectId}/storyboards/{storyboardId}/asset-bindings/{bindingId}"
  | "DELETE /projects/{projectId}/storyboards/{storyboardId}/asset-bindings/{bindingId}"
  | "POST /projects/{projectId}/storyboards/{sourceStoryboardId}/asset-bindings:copy"
  | "GET /projects/{projectId}/storyboards/{storyboardId}/media"
  | "GET /projects/{projectId}/media/{mediaId}"
  | "PATCH /projects/{projectId}/media/{mediaId}"
  | "DELETE /projects/{projectId}/media/{mediaId}"
  | "POST /projects/{projectId}/media/{mediaId}/access"
  | "GET /generation-models"
  | "POST /projects/{projectId}/storyboards/{storyboardId}/media/{mediaId}/generations"
  | "GET /projects/{projectId}/generation-jobs/{jobId}"
  | "GET /projects/{projectId}/media/{mediaId}/generation-jobs/latest"
  | "POST /projects/{projectId}/generation-jobs/{jobId}/retry"
  | "GET /projects/{projectId}/storyboards/{storyboardId}/ai-thread"
  | "POST /projects/{projectId}/storyboards/{storyboardId}/ai-thread"
  | "GET /projects/{projectId}/storyboards/{storyboardId}/ai-threads"
  | "DELETE /projects/{projectId}/storyboards/{storyboardId}/ai-threads/{threadId}"
  | "GET /projects/{projectId}/storyboards/{storyboardId}/proposals"
  | "GET /projects/{projectId}/proposals/{proposalId}"
  | "POST /projects/{projectId}/proposals/{proposalId}/apply"
  | "POST /projects/{projectId}/proposals/{proposalId}/reject"
  | "GET /projects/{projectId}/events/stream";

export type ProductApiOperationId =
  | "listProjects"
  | "createProject"
  | "getProject"
  | "updateProject"
  | "listStoryboards"
  | "createStoryboard"
  | "getStoryboard"
  | "updateStoryboard"
  | "deleteStoryboard"
  | "restoreStoryboard"
  | "reorderStoryboard"
  | "duplicateStoryboard"
  | "getStoryboardScript"
  | "updateStoryboardScript"
  | "listWorkspaceNodes"
  | "createWorkspaceNode"
  | "updateWorkspaceNode"
  | "deleteWorkspaceNode"
  | "copyWorkspaceNode"
  | "reorderWorkspaceNode"
  | "markWorkspaceNodeViewed"
  | "ensureWorkspaceObjectMedia"
  | "uploadWorkspaceObjectMedia"
  | "uploadGenerationInput"
  | "listAssetSections"
  | "createAssetSection"
  | "updateAssetSection"
  | "deleteAssetSection"
  | "reorderAssetSection"
  | "listAssets"
  | "createAsset"
  | "getAsset"
  | "updateAsset"
  | "deleteAsset"
  | "createAssetRepresentation"
  | "listAssetBindings"
  | "createAssetBindings"
  | "updateAssetBinding"
  | "deleteAssetBinding"
  | "copyAssetBindings"
  | "listStoryboardMedia"
  | "getMedia"
  | "updateMedia"
  | "deleteMedia"
  | "refreshMediaAccess"
  | "listGenerationModels"
  | "requestMediaGeneration"
  | "getGenerationJob"
  | "getLatestMediaGenerationJob"
  | "retryGenerationJob"
  | "getWorkspaceAiThread"
  | "createWorkspaceAiThread"
  | "listWorkspaceAiThreads"
  | "deleteWorkspaceAiThread"
  | "listChangeProposals"
  | "getChangeProposal"
  | "applyChangeProposal"
  | "rejectChangeProposal"
  | "streamProjectEvents";

export const PRODUCT_API_OPERATIONS = {
  listProjects: { method: "GET", path: "/projects" },
  createProject: { method: "POST", path: "/projects" },
  getProject: { method: "GET", path: "/projects/{projectId}" },
  updateProject: { method: "PATCH", path: "/projects/{projectId}" },
  listStoryboards: { method: "GET", path: "/projects/{projectId}/storyboards" },
  createStoryboard: { method: "POST", path: "/projects/{projectId}/storyboards" },
  getStoryboard: { method: "GET", path: "/projects/{projectId}/storyboards/{storyboardId}" },
  updateStoryboard: { method: "PATCH", path: "/projects/{projectId}/storyboards/{storyboardId}" },
  deleteStoryboard: { method: "DELETE", path: "/projects/{projectId}/storyboards/{storyboardId}" },
  restoreStoryboard: { method: "POST", path: "/projects/{projectId}/storyboards/{storyboardId}/restore" },
  reorderStoryboard: { method: "POST", path: "/projects/{projectId}/storyboards/{storyboardId}/reorder" },
  duplicateStoryboard: { method: "POST", path: "/projects/{projectId}/storyboards/{storyboardId}/duplicate" },
  getStoryboardScript: { method: "GET", path: "/projects/{projectId}/storyboards/{storyboardId}/script" },
  updateStoryboardScript: { method: "PATCH", path: "/projects/{projectId}/storyboards/{storyboardId}/script" },
  listWorkspaceNodes: { method: "GET", path: "/projects/{projectId}/storyboards/{storyboardId}/workspace-nodes" },
  createWorkspaceNode: { method: "POST", path: "/projects/{projectId}/storyboards/{storyboardId}/workspace-nodes" },
  updateWorkspaceNode: { method: "PATCH", path: "/projects/{projectId}/storyboards/{storyboardId}/workspace-nodes/{nodeId}" },
  deleteWorkspaceNode: { method: "DELETE", path: "/projects/{projectId}/storyboards/{storyboardId}/workspace-nodes/{nodeId}" },
  copyWorkspaceNode: { method: "POST", path: "/projects/{projectId}/storyboards/{storyboardId}/workspace-nodes/{nodeId}/copies" },
  reorderWorkspaceNode: { method: "PATCH", path: "/projects/{projectId}/storyboards/{storyboardId}/workspace-nodes/{nodeId}/order" },
  markWorkspaceNodeViewed: { method: "PUT", path: "/projects/{projectId}/storyboards/{storyboardId}/workspace-nodes/{nodeId}/viewed" },
  ensureWorkspaceObjectMedia: { method: "POST", path: "/projects/{projectId}/storyboards/{storyboardId}/workspace-nodes/{nodeId}/media" },
  uploadWorkspaceObjectMedia: { method: "PUT", path: "/projects/{projectId}/storyboards/{storyboardId}/workspace-nodes/{nodeId}/media" },
  uploadGenerationInput: { method: "PUT", path: "/projects/{projectId}/storyboards/{storyboardId}/generation-inputs/{inputId}" },
  listAssetSections: { method: "GET", path: "/projects/{projectId}/storyboards/{storyboardId}/asset-sections" },
  createAssetSection: { method: "POST", path: "/projects/{projectId}/storyboards/{storyboardId}/asset-sections" },
  updateAssetSection: { method: "PATCH", path: "/projects/{projectId}/storyboards/{storyboardId}/asset-sections/{sectionId}" },
  deleteAssetSection: { method: "DELETE", path: "/projects/{projectId}/storyboards/{storyboardId}/asset-sections/{sectionId}" },
  reorderAssetSection: { method: "POST", path: "/projects/{projectId}/storyboards/{storyboardId}/asset-sections/{sectionId}/reorder" },
  listAssets: { method: "GET", path: "/projects/{projectId}/assets" },
  createAsset: { method: "POST", path: "/projects/{projectId}/assets" },
  getAsset: { method: "GET", path: "/projects/{projectId}/assets/{assetId}" },
  updateAsset: { method: "PATCH", path: "/projects/{projectId}/assets/{assetId}" },
  deleteAsset: { method: "DELETE", path: "/projects/{projectId}/assets/{assetId}" },
  createAssetRepresentation: { method: "POST", path: "/projects/{projectId}/assets/{assetId}/representations" },
  listAssetBindings: { method: "GET", path: "/projects/{projectId}/storyboards/{storyboardId}/asset-bindings" },
  createAssetBindings: { method: "POST", path: "/projects/{projectId}/storyboards/{storyboardId}/asset-bindings" },
  updateAssetBinding: { method: "PATCH", path: "/projects/{projectId}/storyboards/{storyboardId}/asset-bindings/{bindingId}" },
  deleteAssetBinding: { method: "DELETE", path: "/projects/{projectId}/storyboards/{storyboardId}/asset-bindings/{bindingId}" },
  copyAssetBindings: { method: "POST", path: "/projects/{projectId}/storyboards/{sourceStoryboardId}/asset-bindings:copy" },
  listStoryboardMedia: { method: "GET", path: "/projects/{projectId}/storyboards/{storyboardId}/media" },
  getMedia: { method: "GET", path: "/projects/{projectId}/media/{mediaId}" },
  updateMedia: { method: "PATCH", path: "/projects/{projectId}/media/{mediaId}" },
  deleteMedia: { method: "DELETE", path: "/projects/{projectId}/media/{mediaId}" },
  refreshMediaAccess: { method: "POST", path: "/projects/{projectId}/media/{mediaId}/access" },
  listGenerationModels: { method: "GET", path: "/generation-models" },
  requestMediaGeneration: { method: "POST", path: "/projects/{projectId}/storyboards/{storyboardId}/media/{mediaId}/generations" },
  getGenerationJob: { method: "GET", path: "/projects/{projectId}/generation-jobs/{jobId}" },
  getLatestMediaGenerationJob: { method: "GET", path: "/projects/{projectId}/media/{mediaId}/generation-jobs/latest" },
  retryGenerationJob: { method: "POST", path: "/projects/{projectId}/generation-jobs/{jobId}/retry" },
  getWorkspaceAiThread: { method: "GET", path: "/projects/{projectId}/storyboards/{storyboardId}/ai-thread" },
  createWorkspaceAiThread: { method: "POST", path: "/projects/{projectId}/storyboards/{storyboardId}/ai-thread" },
  listWorkspaceAiThreads: { method: "GET", path: "/projects/{projectId}/storyboards/{storyboardId}/ai-threads" },
  deleteWorkspaceAiThread: { method: "DELETE", path: "/projects/{projectId}/storyboards/{storyboardId}/ai-threads/{threadId}" },
  listChangeProposals: { method: "GET", path: "/projects/{projectId}/storyboards/{storyboardId}/proposals" },
  getChangeProposal: { method: "GET", path: "/projects/{projectId}/proposals/{proposalId}" },
  applyChangeProposal: { method: "POST", path: "/projects/{projectId}/proposals/{proposalId}/apply" },
  rejectChangeProposal: { method: "POST", path: "/projects/{projectId}/proposals/{proposalId}/reject" },
  streamProjectEvents: { method: "GET", path: "/projects/{projectId}/events/stream" },
} as const satisfies Record<ProductApiOperationId, { method: string; path: string }>;
