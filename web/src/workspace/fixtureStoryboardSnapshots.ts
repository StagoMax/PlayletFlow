import type { MediaItem, StoryboardDetail } from "../productApi/generated";
import type { StoryboardClient } from "../storyboards/storyboardClient";
import { remapMediaPromptReferenceIds } from "../preview/mediaPromptDraft";
import { createNavigationTree } from "./resourceTree";
import { withStoryboardOrder } from "./storyboardOrder";
import type { CopiedWorkspaceIds, WorkspaceNodeClient } from "./workspaceNodeClient";
import { copiedWorkspaceIds } from "./workspaceNodeClient";
import type { NavigatorGroup, StoryboardWorkspace, WorkspaceSnapshot, WorkspaceTreeNode } from "./types";

export async function hydrateFixtureStoryboards(
  snapshot: WorkspaceSnapshot,
  client: StoryboardClient,
  signal: AbortSignal,
  nodeClient?: WorkspaceNodeClient | null,
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
    let copiedIds: CopiedWorkspaceIds | undefined;
    if (source && nodeClient) {
      try {
        const [sourceNodes, targetNodes] = await Promise.all([
          nodeClient.list(snapshot.project.id, source.storyboard.id, signal),
          nodeClient.list(snapshot.project.id, detail.id, signal),
        ]);
        copiedIds = copiedWorkspaceIds(sourceNodes, targetNodes);
      } catch (cause) {
        if (signal.aborted) throw cause;
        console.warn("[workspace] copied resource IDs are unavailable", cause);
      }
    }
    workspaces[summary.id] = source
      ? copyStoryboardWorkspace(source, detail, copiedIds)
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

export function copyStoryboardWorkspace(source: StoryboardWorkspace, storyboard: StoryboardDetail, copiedIds?: CopiedWorkspaceIds): StoryboardWorkspace {
  return cloneStoryboardWorkspace(source, storyboard, {}, true, copiedIds).workspace;
}

export function cloneStoryboardWorkspace(
  source: StoryboardWorkspace,
  storyboard: StoryboardDetail,
  sourceObjectMedia: Readonly<Record<string, MediaItem>>,
  preserveCanonicalItemIds = false,
  copiedIds?: CopiedWorkspaceIds,
): { workspace: StoryboardWorkspace; objectMedia: Record<string, MediaItem>; mediaFiles: Array<[string, string]> } {
  const nodeIds = new Map<string, string>();
  const mediaIds = new Map<string, string>();
  const mediaFiles: Array<[string, string]> = [];
  const remapNode = (id: string) => {
    let mapped = nodeIds.get(id);
    if (!mapped) { mapped = copiedIds?.nodes.get(id) ?? crypto.randomUUID(); nodeIds.set(id, mapped); }
    return mapped;
  };
  const remapMedia = (media: MediaItem, preferredId?: string): MediaItem => {
    if (media.owner.type === "asset") return { ...media };
    let id = mediaIds.get(media.id);
    if (!id) { id = copiedIds?.media.get(media.id) ?? preferredId ?? crypto.randomUUID(); mediaIds.set(media.id, id); }
    const sourceFile = media.preview?.url.startsWith("browser-media:")
      ? media.preview.url.slice("browser-media:".length)
      : media.preview?.url.startsWith("blob:") ? media.id
      : media.thumbnail?.url.startsWith("browser-media:")
        ? media.thumbnail.url.slice("browser-media:".length)
        : media.thumbnail?.url.startsWith("blob:") ? media.id : null;
    if (sourceFile && !mediaFiles.some(([, target]) => target === id)) mediaFiles.push([sourceFile, id]);
    const replaceUrl = (url: string) => url.startsWith("browser-media:") ? `browser-media:${id}` : url;
    return {
      ...media,
      id,
      owner: { type: "storyboard", storyboardId: storyboard.id },
      status: media.status === "processing" ? "placeholder" : media.status,
      preview: media.preview ? { ...media.preview, url: replaceUrl(media.preview.url) } : null,
      thumbnail: media.thumbnail ? { ...media.thumbnail, url: replaceUrl(media.thumbnail.url) } : null,
      generation: media.status === "processing" ? null : media.generation,
    };
  };
  const cloneGroups = (groups: NavigatorGroup[]) => groups.map((group) => {
    const groupId = crypto.randomUUID();
    nodeIds.set(`folder-${group.id}`, `folder-${groupId}`);
    for (const item of group.items) {
      if (preserveCanonicalItemIds) {
        nodeIds.set(item.id, copiedIds?.media.get(item.id) ?? copiedIds?.nodes.get(item.id) ?? item.id);
        mediaIds.set(item.media.id, copiedIds?.media.get(item.media.id) ?? item.media.id);
      }
      if (item.subject) nodeIds.set(`folder-${group.id}-${item.subject.id}`, `folder-${groupId}-${item.subject.id}`);
    }
    return {
      ...group,
      id: groupId,
      items: group.items.map((item) => ({
        ...item,
        id: remapNode(item.id),
        subject: item.subject ? { ...item.subject } : undefined,
        media: preserveCanonicalItemIds && item.media.owner.type === "storyboard"
          ? { ...item.media, id: mediaIds.get(item.media.id) ?? item.media.id,
            owner: { type: "storyboard" as const, storyboardId: storyboard.id },
            status: item.media.status === "processing" ? "placeholder" as const : item.media.status,
            generation: null }
          : remapMedia(item.media),
      })),
    };
  });
  const assetGroups = cloneGroups(source.assetGroups);
  const videoGroups = cloneGroups(source.videoGroups);
  nodeIds.set(`folder-script-${source.storyboard.id}`, `folder-script-${storyboard.id}`);
  nodeIds.set(`folder-assets-${source.storyboard.id}`, `folder-assets-${storyboard.id}`);
  nodeIds.set(`folder-video-${source.storyboard.id}`, `folder-video-${storyboard.id}`);
  nodeIds.set(`script-${source.storyboard.id}`, `script-${storyboard.id}`);
  const cloneTree = (nodes: WorkspaceTreeNode[]): WorkspaceTreeNode[] => nodes.map((node): WorkspaceTreeNode => {
    const id = remapNode(node.id);
    if (node.kind === "folder") return { ...node, id, children: cloneTree(node.children) };
    const selection = node.selection.kind === "script"
      ? { ...node.selection, storyboardId: storyboard.id }
      : node.selection.kind === "item"
        ? { ...node.selection, itemId: remapNode(node.selection.itemId) }
        : { ...node.selection, objectId: remapNode(node.selection.objectId) };
    const mediaId = node.mediaId ? mediaIds.get(node.mediaId) ?? remapNode(node.mediaId) : undefined;
    return {
      ...node,
      id,
      selection: { ...selection, nodeId: node.selection.nodeId ? remapNode(node.selection.nodeId) : undefined },
      mediaId,
    };
  });
  const navigationTree = source.navigationTree.length
    ? cloneTree(source.navigationTree)
    : createNavigationTree(storyboard.id, assetGroups, videoGroups);
  const objectMedia: Record<string, MediaItem> = {};
  for (const [sourceId, media] of Object.entries(sourceObjectMedia)) {
    const id = nodeIds.get(sourceId);
    if (id) objectMedia[id] = remapMedia(media, mediaIds.get(media.id) ?? nodeIds.get(media.id) ?? id);
  }
  const referenceIds = new Map([...nodeIds, ...mediaIds]);
  const withCopiedReferences = (media: MediaItem): MediaItem => media.owner.type === "storyboard" && media.prompt
    ? { ...media, prompt: remapMediaPromptReferenceIds(media.prompt, referenceIds) }
    : media;
  const remapGroups = (groups: NavigatorGroup[]) => groups.map((group) => ({
    ...group,
    items: group.items.map((item) => ({ ...item, media: withCopiedReferences(item.media) })),
  }));
  for (const [id, media] of Object.entries(objectMedia)) objectMedia[id] = withCopiedReferences(media);
  return { workspace: { storyboard, assetGroups: remapGroups(assetGroups), videoGroups: remapGroups(videoGroups), navigationTree }, objectMedia, mediaFiles };
}
