import type {
  CreateStoryboardRequest,
  CreateStoryboardResponse,
  StoryboardDetail,
  ReorderRequest,
  GenerationJob,
  GenerationModel,
  MediaItem,
  RequestMediaGeneration,
  StoryboardScript,
  UpdateScriptRequest,
} from "../productApi/generated";
import type { GenerationImageFile } from "../generation/generationOptions";
import type {
  StoryboardWorkspace,
  WorkspaceFolderNode,
  WorkspaceObjectNode,
  WorkspaceObjectType,
  WorkspaceSnapshot,
  WorkspaceTreeNode,
} from "./types";

export type WorkspaceGenerationResult = {
  objectKey: string;
  url: string;
  expiresAt: string;
  kind: "image" | "video";
  mimeType: string;
  width: number | null;
  height: number | null;
  durationMs: number | null;
};

export type WorkspaceGenerationJob = GenerationJob & {
  result?: WorkspaceGenerationResult | null;
};

export type CreatedWorkspaceStoryboard = CreateStoryboardResponse & {
  workspace: StoryboardWorkspace;
};
export type DuplicatedWorkspaceStoryboard = {
  storyboard: StoryboardDetail;
  workspace: StoryboardWorkspace;
  objectMedia?: Record<string, MediaItem>;
};

export interface WorkspaceClient {
  load(signal: AbortSignal): Promise<WorkspaceSnapshot>;
  createStoryboard(
    projectId: string,
    request: CreateStoryboardRequest,
    idempotencyKey: string,
    signal?: AbortSignal,
  ): Promise<CreatedWorkspaceStoryboard>;
  duplicateStoryboard(projectId: string, storyboardId: string, idempotencyKey: string, signal?: AbortSignal): Promise<DuplicatedWorkspaceStoryboard>;
  reorderStoryboard(projectId: string, storyboardId: string, request: ReorderRequest, idempotencyKey: string, signal?: AbortSignal): Promise<StoryboardDetail>;
  renameStoryboard(projectId: string, storyboardId: string, name: string, expectedRevision: number): Promise<StoryboardDetail>;
  deleteStoryboard(projectId: string, storyboardId: string, expectedRevision: number): Promise<void>;
  loadNavigationTree(
    projectId: string,
    storyboardId: string,
    signal?: AbortSignal,
  ): Promise<WorkspaceTreeNode[] | null>;
  loadScript(
    projectId: string,
    storyboardId: string,
    signal?: AbortSignal,
  ): Promise<StoryboardScript | null>;
  listGenerationModels(signal?: AbortSignal): Promise<GenerationModel[]>;
  updateScript(
    projectId: string,
    storyboardId: string,
    request: UpdateScriptRequest,
    signal?: AbortSignal,
  ): Promise<StoryboardScript>;
  createFolder(
    projectId: string,
    storyboardId: string,
    parentId: string | null,
    name: string,
    signal?: AbortSignal,
  ): Promise<WorkspaceFolderNode>;
  createObject(
    projectId: string,
    storyboardId: string,
    parentId: string | null,
    name: string,
    objectType: WorkspaceObjectType,
    signal?: AbortSignal,
  ): Promise<WorkspaceObjectNode>;
  renameNode(projectId: string, storyboardId: string, nodeId: string, name: string): Promise<WorkspaceTreeNode[]>;
  deleteNode(projectId: string, storyboardId: string, nodeId: string): Promise<WorkspaceTreeNode[]>;
  copyNode(projectId: string, storyboardId: string, nodeId: string): Promise<WorkspaceTreeNode[]>;
  reorderNode(projectId: string, storyboardId: string, nodeId: string, targetId: string, placement: "before" | "after"): Promise<WorkspaceTreeNode[]>;
  moveNode(projectId: string, storyboardId: string, nodeId: string, parentId: string | null): Promise<WorkspaceTreeNode[]>;
  markObjectViewed(projectId: string, storyboardId: string, nodeId: string, seenThrough: string): Promise<WorkspaceTreeNode[]>;
  requestMediaGeneration(
    projectId: string,
    storyboardId: string,
    mediaId: string,
    request: RequestMediaGeneration,
    idempotencyKey: string,
    signal?: AbortSignal,
    imageFiles?: readonly GenerationImageFile[],
    referenceMedia?: readonly MediaItem[],
  ): Promise<WorkspaceGenerationJob>;
  getGenerationJob(
    projectId: string,
    jobId: string,
    signal?: AbortSignal,
  ): Promise<WorkspaceGenerationJob>;
}
