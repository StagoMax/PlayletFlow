import type { WorkspaceAction, WorkspaceSnapshot, WorkspaceState } from "./types";

const stateKey = (projectId: string) => `videoflow:workspace-view:v1:${projectId}`;

export function createWorkspaceState(data: WorkspaceSnapshot): WorkspaceState {
  const storyboardId = data.initialStoryboardId;
  const initial = {
    currentStoryboardId: storyboardId,
    selection: data.initialSelection ?? { kind: "script" as const, storyboardId },
  };
  try {
    const stored = window.localStorage.getItem(stateKey(data.project.id));
    if (!stored) return initial;
    const parsed = JSON.parse(stored) as WorkspaceState;
    if (!data.workspaces[parsed.currentStoryboardId]) return initial;
    const selection = parsed.selection;
    if (selection.kind === "script" && selection.storyboardId !== parsed.currentStoryboardId) return initial;
    if (selection.kind === "item" && typeof selection.itemId !== "string") return initial;
    if (selection.kind === "emptyObject" && typeof selection.objectId !== "string") return initial;
    return parsed;
  } catch {
    return initial;
  }
}

export function rememberWorkspaceState(projectId: string, state: WorkspaceState) {
  try {
    window.localStorage.setItem(stateKey(projectId), JSON.stringify(state));
  } catch {
    // Browsers with disabled storage still keep the current in-memory selection.
  }
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
