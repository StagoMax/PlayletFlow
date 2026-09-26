import { createContext, useContext, type Dispatch } from "react";
import type {
  ApplyProposalResponse,
  AssetBinding,
  AssetCopySummary,
  GenerationJob,
  GenerationModel,
  GenerationOptions,
  StoryboardScript,
} from "../productApi/generated";
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
  dispatch: Dispatch<WorkspaceAction>;
  listAssetBindings: (storyboardId: string, signal: AbortSignal) => Promise<AssetBinding[]>;
  createStoryboard: (input: {
    name: string;
    sourceStoryboardId: string;
    bindingIds: string[];
    includePromptOverrides: boolean;
  }) => Promise<AssetCopySummary>;
  commitAppliedProposal: (response: ApplyProposalResponse) => void;
  refreshScript: (storyboardId: string, signal?: AbortSignal) => Promise<StoryboardScript | null>;
  saveScript: (storyboardId: string, text: string, expectedRevision: number) => Promise<StoryboardScript>;
  createFolder: (storyboardId: string, parentId: string | null, name: string) => Promise<WorkspaceFolderNode>;
  createObject: (
    storyboardId: string,
    parentId: string | null,
    name: string,
    objectType: WorkspaceObjectType,
  ) => Promise<WorkspaceObjectNode>;
  loadGenerationModels: (signal?: AbortSignal) => Promise<GenerationModel[]>;
  generateMedia: (
    storyboardId: string,
    itemId: string,
    mediaId: string,
    prompt: string,
    expectedRevision: number,
    generation: GenerationOptions,
    idempotencyKey: string,
  ) => Promise<GenerationJob>;
};

export const WorkspaceContext = createContext<WorkspaceContextValue | null>(null);

export function useWorkspace() {
  const value = useContext(WorkspaceContext);
  if (!value) throw new Error("useWorkspace must be used inside WorkspaceProvider");
  return value;
}
