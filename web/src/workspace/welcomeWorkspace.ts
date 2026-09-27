import type { MediaItem, Project, StoryboardDetail, WorkspaceNode } from "../productApi/generated";
import { workspaceTreeFromNodes } from "./workspaceNodeClient";
import type { WorkspaceSelection, WorkspaceSnapshot } from "./types";
import source from "./welcomeWorkspace.json";

type WelcomeWorkspace = {
  project: Project;
  storyboard: StoryboardDetail;
  nodes: WorkspaceNode[];
  objectMedia: Record<string, MediaItem>;
  initialSelection: WorkspaceSelection;
};

const welcome = source as unknown as WelcomeWorkspace;

export function createWelcomeWorkspace(): WorkspaceSnapshot {
  const storyboard = { ...welcome.storyboard, index: 1 };
  return {
    project: { ...welcome.project },
    storyboards: [storyboard],
    workspaces: {
      [storyboard.id]: {
        storyboard,
        assetGroups: [],
        videoGroups: [],
        navigationTree: workspaceTreeFromNodes(welcome.nodes),
      },
    },
    initialStoryboardId: storyboard.id,
    initialSelection: welcome.initialSelection,
    objectMedia: { ...welcome.objectMedia },
  };
}

export const welcomeStoryboardId = welcome.storyboard.id;
export const welcomeSelection = welcome.initialSelection;
