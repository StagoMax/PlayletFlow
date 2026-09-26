import type {
  AssetBinding,
  CreateStoryboardRequest,
  CreateStoryboardResponse,
  GenerationJob,
  GenerationModel,
  RequestMediaGeneration,
  StoryboardScript,
  UpdateScriptRequest,
} from "../productApi/generated";
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

export interface WorkspaceClient {
  load(signal: AbortSignal): Promise<WorkspaceSnapshot>;
  listAssetBindings(projectId: string, storyboardId: string, signal: AbortSignal): Promise<AssetBinding[]>;
  createStoryboard(
    projectId: string,
    request: CreateStoryboardRequest,
    idempotencyKey: string,
    signal?: AbortSignal,
  ): Promise<CreatedWorkspaceStoryboard>;
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
  requestMediaGeneration(
    projectId: string,
    storyboardId: string,
    mediaId: string,
    request: RequestMediaGeneration,
    idempotencyKey: string,
    signal?: AbortSignal,
  ): Promise<WorkspaceGenerationJob>;
  getGenerationJob(
    projectId: string,
    jobId: string,
    signal?: AbortSignal,
  ): Promise<WorkspaceGenerationJob>;
}
