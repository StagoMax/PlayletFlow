import type { StoryboardDetail } from "../productApi/generated";
import type { StoryboardClient } from "../storyboards/storyboardClient";
import { createNavigationTree } from "./resourceTree";
import { withStoryboardOrder } from "./storyboardOrder";
import type { NavigatorGroup, StoryboardWorkspace, WorkspaceSnapshot } from "./types";

export async function hydrateFixtureStoryboards(
  snapshot: WorkspaceSnapshot,
  client: StoryboardClient,
  signal: AbortSignal,
): Promise<WorkspaceSnapshot> {
  const persisted = (await client.listAll(snapshot.project.id, signal))
    .filter((item) => snapshot.workspaces[item.id]
      || !/^20000000-0000-4000-8000-\d{12}$/.test(item.id));
  if (!persisted.length) return snapshot;
  const workspaces = { ...snapshot.workspaces };
  for (const summary of persisted) {
    const existing = workspaces[summary.id];
    if (existing) {
      workspaces[summary.id] = { ...existing, storyboard: { ...existing.storyboard, ...summary } };
      continue;
    }
    const detail = await client.get(snapshot.project.id, summary.id, signal);
    let sourceId: string | null = null;
    try {
      sourceId = window.localStorage.getItem(`videoflow:storyboard-source:${summary.id}`);
    } catch {
      // Local storage may be unavailable in a private browser context.
    }
    const source = sourceId ? workspaces[sourceId] : null;
    workspaces[summary.id] = source
      ? copyStoryboardWorkspace(source, detail)
      : { storyboard: detail, assetGroups: [], videoGroups: [], navigationTree: createNavigationTree(detail.id, [], []) };
  }
  return withStoryboardOrder({
    ...snapshot,
    workspaces,
    initialStoryboardId: persisted.some((item) => item.id === snapshot.initialStoryboardId)
      ? snapshot.initialStoryboardId
      : persisted[0].id,
  }, persisted);
}

export function cloneNavigatorGroup(group: NavigatorGroup): NavigatorGroup {
  return {
    ...group,
    items: group.items.map((item) => ({
      ...item,
      subject: item.subject ? { ...item.subject } : undefined,
      media: { ...item.media },
    })),
  };
}

export function copyStoryboardWorkspace(source: StoryboardWorkspace, storyboard: StoryboardDetail): StoryboardWorkspace {
  const cloneGroups = (groups: NavigatorGroup[]) => groups.map((group) => ({
    ...group,
    id: crypto.randomUUID(),
    items: group.items.map((item) => ({
      ...item,
      subject: item.subject ? { ...item.subject } : undefined,
      media: item.media.owner.type === "asset"
        ? { ...item.media }
        : {
          ...item.media,
          owner: { type: "storyboard" as const, storyboardId: storyboard.id },
          status: item.media.status === "processing" ? "placeholder" as const : item.media.status,
          generation: null,
        },
    })),
  }));
  const assetGroups = cloneGroups(source.assetGroups);
  const videoGroups = cloneGroups(source.videoGroups);
  return {
    storyboard,
    assetGroups,
    videoGroups,
    navigationTree: createNavigationTree(storyboard.id, assetGroups, videoGroups),
  };
}
