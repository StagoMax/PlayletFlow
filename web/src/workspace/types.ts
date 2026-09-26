import type { Project, StoryboardDetail, StoryboardSummary } from "../productApi/generated";
import type { PreviewItem } from "../preview/types";

export type NavigatorItem = PreviewItem & {
  navigationName?: string;
  subject?: {
    id: string;
    name: string;
  };
};

export type NavigatorGroup = {
  id: string;
  name: string;
  kind: "character" | "scene" | "prop" | "keyframe" | "generatedVideo";
  items: NavigatorItem[];
};

export type WorkspaceObjectType = "text" | "image" | "video";

export type WorkspaceFolderNode = {
  kind: "folder";
  id: string;
  name: string;
  children: WorkspaceTreeNode[];
};

export type WorkspaceObjectNode = {
  kind: "object";
  id: string;
  name: string;
  objectType: WorkspaceObjectType;
  mediaId?: string;
  selection: WorkspaceSelection;
};

export type WorkspaceTreeNode = WorkspaceFolderNode | WorkspaceObjectNode;

export type StoryboardWorkspace = {
  storyboard: StoryboardDetail;
  assetGroups: NavigatorGroup[];
  videoGroups: NavigatorGroup[];
  navigationTree: WorkspaceTreeNode[];
};

export type WorkspaceSnapshot = {
  project: Project;
  storyboards: StoryboardSummary[];
  workspaces: Record<string, StoryboardWorkspace>;
  initialStoryboardId: string;
};

export type WorkspaceSelection = (
  | { kind: "script"; storyboardId: string }
  | { kind: "item"; itemId: string }
  | { kind: "emptyObject"; objectId: string; objectType: WorkspaceObjectType }
) & { nodeId?: string };

export type WorkspaceState = {
  currentStoryboardId: string;
  selection: WorkspaceSelection;
};

export type WorkspaceAction =
  | { type: "storyboardSelected"; storyboardId: string; selection?: WorkspaceSelection }
  | { type: "contentSelected"; selection: WorkspaceSelection };

export type WorkspaceResource =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "empty"; data: WorkspaceSnapshot }
  | { status: "ready"; data: WorkspaceSnapshot };
