import type { StoryboardSummary } from "../productApi/generated";
import type { WorkspaceSnapshot, StoryboardWorkspace } from "./types";

export function withStoryboardOrder(
  snapshot: WorkspaceSnapshot,
  ordered: StoryboardSummary[],
  addedWorkspaces: Record<string, StoryboardWorkspace> = {},
): WorkspaceSnapshot {
  const storyboards = ordered.map((storyboard, index) => ({ ...storyboard, index: index + 1 }));
  const workspaces = { ...snapshot.workspaces, ...addedWorkspaces };
  for (const storyboard of storyboards) {
    const workspace = workspaces[storyboard.id];
    if (workspace) workspaces[storyboard.id] = {
      ...workspace,
      storyboard: { ...workspace.storyboard, ...storyboard },
    };
  }
  return { ...snapshot, storyboards, workspaces };
}

export function withoutStoryboard(snapshot: WorkspaceSnapshot, storyboardId: string): WorkspaceSnapshot {
  const workspaces = { ...snapshot.workspaces };
  delete workspaces[storyboardId];
  const ordered = snapshot.storyboards.filter((item) => item.id !== storyboardId);
  return withStoryboardOrder({
    ...snapshot,
    workspaces,
    initialStoryboardId: snapshot.initialStoryboardId === storyboardId
      ? ordered[0]?.id ?? ""
      : snapshot.initialStoryboardId,
  }, ordered);
}
