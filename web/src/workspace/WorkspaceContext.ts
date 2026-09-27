import { createContext, useContext, type Dispatch } from "react";
import type {
  ApplyProposalResponse,
  GenerationJob,
  GenerationModel,
  GenerationOptions,
  MediaItem,
  StoryboardScript,
} from "../productApi/generated";
import type { GenerationImageFile } from "../generation/generationOptions";
import type { WorkspaceGenerationJob } from "./workspaceClient";
import type {
  StoryboardWorkspace,
  WorkspaceAction,
  WorkspaceFolderNode,
  WorkspaceObjectNode,
  WorkspaceObjectType,
  WorkspaceSnapshot,
  WorkspaceState,
} from "./types";

export type WorkspaceContextValue = {
  data: WorkspaceSnapshot;
  state: WorkspaceState;
  current: StoryboardWorkspace;
  objectMedia: Readonly<Record<string, MediaItem>>;
  publishObjectMedia: (objectId: string, media: MediaItem) => void;
  publishWorkspaceNodeMedia: (storyboardId: string, nodeId: string, media: MediaItem) => void;
  dispatch: Dispatch<WorkspaceAction>;
  createStoryboard: (input: {
    name: string;
    sourceStoryboardId: string;
  }) => Promise<void>;
  duplicateStoryboard: (storyboardId: string) => Promise<void>;
  renameStoryboard: (name: string) => Promise<void>;
  deleteStoryboard: (storyboardId?: string) => Promise<void>;
  reorderStoryboard: (storyboardId: string, targetId: string, placement: "before" | "after") => Promise<void>;
  commitAppliedProposal: (response: ApplyProposalResponse) => void;
  refreshNavigationTree: (storyboardId: string, signal?: AbortSignal) => Promise<void>;
  refreshScript: (storyboardId: string, signal?: AbortSignal) => Promise<StoryboardScript | null>;
  saveScript: (storyboardId: string, text: string, expectedRevision: number) => Promise<StoryboardScript>;
  createFolder: (storyboardId: string, parentId: string | null, name: string) => Promise<WorkspaceFolderNode>;
  createObject: (
    storyboardId: string,
    parentId: string | null,
    name: string,
    objectType: WorkspaceObjectType,
  ) => Promise<WorkspaceObjectNode>;
  renameNode: (nodeId: string, name: string) => Promise<void>;
  deleteNode: (nodeId: string) => Promise<void>;
  copyNode: (nodeId: string) => Promise<void>;
  reorderNode: (nodeId: string, targetId: string, placement: "before" | "after") => Promise<void>;
  moveNode: (nodeId: string, parentId: string | null) => Promise<void>;
  markObjectViewed: (storyboardId: string, nodeId: string, seenThrough: string) => Promise<void>;
  loadGenerationModels: (signal?: AbortSignal) => Promise<GenerationModel[]>;
  loadGenerationJob: (
    mediaId: string,
    jobId?: string | null,
    signal?: AbortSignal,
  ) => Promise<WorkspaceGenerationJob | null>;
  generateMedia: (
    storyboardId: string,
    itemId: string,
    mediaId: string,
    prompt: string,
    expectedRevision: number,
    generation: GenerationOptions,
    idempotencyKey: string,
    imageFiles?: readonly GenerationImageFile[],
  ) => Promise<GenerationJob>;
};

export const WorkspaceContext = createContext<WorkspaceContextValue | null>(null);

export function useWorkspace() {
  const value = useContext(WorkspaceContext);
  if (!value) throw new Error("useWorkspace must be used inside WorkspaceProvider");
  return value;
}
