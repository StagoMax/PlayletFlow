import type { WorkspaceAction, WorkspaceState } from "./types";

export function createWorkspaceState(storyboardId: string): WorkspaceState {
  return {
    currentStoryboardId: storyboardId,
    selection: { kind: "script", storyboardId },
  };
}

export function workspaceReducer(state: WorkspaceState, action: WorkspaceAction): WorkspaceState {
  switch (action.type) {
    case "storyboardSelected":
      if (action.storyboardId === state.currentStoryboardId) return state;
      return {
        currentStoryboardId: action.storyboardId,
        selection: action.selection ?? { kind: "script", storyboardId: action.storyboardId },
      };
    case "contentSelected":
      return { ...state, selection: action.selection };
  }
}
