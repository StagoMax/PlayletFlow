import type { WorkspaceNode } from "../productApi/generated";
import { workspaceComposerAssets } from "../composer/workspaceAssets";
import { parseMediaPromptDraft, reconcileMediaPromptReferences } from "../preview/mediaPromptDraft";
import { cloneStoryboardWorkspace } from "./fixtureStoryboardSnapshots";
import { createSnapshot } from "./fixtureWorkspaceData";
import { updateNodeUnseenUpdateAt } from "./resourceTree";
import { createWelcomeWorkspace } from "./welcomeWorkspace";
import { copiedWorkspaceIds, workspaceTreeFromNodes } from "./workspaceNodeClient";

type CaseResult = { ok: boolean; message?: string };

const unseenUpdateAt = "2026-09-27T09:00:00Z";

export const workspaceTestCases: Record<string, () => CaseResult> = {
  "copied persisted media IDs remain usable in the copied composer": () => {
    const snapshot = createSnapshot(1, 0);
    const source = snapshot.workspaces[snapshot.initialStoryboardId];
    const item = source.videoGroups.flatMap((group) => group.items)[0];
    if (!item) return { ok: false, message: "source fixture has no storyboard media" };
    const copiedMediaId = crypto.randomUUID();
    const copied = cloneStoryboardWorkspace(
      source,
      { ...source.storyboard, id: crypto.randomUUID() },
      {},
      true,
      { nodes: new Map(), media: new Map([[item.media.id, copiedMediaId]]) },
    );
    const copiedItem = copied.workspace.videoGroups.flatMap((group) => group.items)[0];
    const composerAssets = workspaceComposerAssets(copied.workspace);
    return copiedItem?.media.id === copiedMediaId
      && composerAssets.some((asset) => asset.id === copiedMediaId)
      ? { ok: true }
      : { ok: false, message: "copied composer still uses the source storyboard media ID" };
  },
  "persisted copy IDs pair nodes by tree position even when names repeat": () => {
    const source = [
      workspaceNode({ id: "source-a", kind: "folder", name: "场景", position: "1" }),
      workspaceNode({ id: "source-b", kind: "folder", name: "场景", position: "2" }),
      workspaceNode({ id: "source-media-a", parentId: "source-a", kind: "object", name: "画面", objectType: "image", targetType: "media", targetId: "media-a", position: "1" }),
      workspaceNode({ id: "source-media-b", parentId: "source-b", kind: "object", name: "画面", objectType: "image", targetType: "media", targetId: "media-b", position: "1" }),
    ];
    const target = [
      workspaceNode({ id: "target-b", kind: "folder", name: "场景", position: "2" }),
      workspaceNode({ id: "target-media-b", parentId: "target-b", kind: "object", name: "画面", objectType: "image", targetType: "media", targetId: "copied-b", position: "1" }),
      workspaceNode({ id: "target-a", kind: "folder", name: "场景", position: "1" }),
      workspaceNode({ id: "target-media-a", parentId: "target-a", kind: "object", name: "画面", objectType: "image", targetType: "media", targetId: "copied-a", position: "1" }),
    ];
    const ids = copiedWorkspaceIds(source, target);
    return ids.nodes.get("source-media-a") === "target-media-a"
      && ids.nodes.get("source-media-b") === "target-media-b"
      && ids.media.get("media-a") === "copied-a"
      && ids.media.get("media-b") === "copied-b"
      ? { ok: true }
      : { ok: false, message: "copied resources were paired by name or list order" };
  },
  "deleted media in a copy does not discard mappings for valid media": () => {
    const source = [
      workspaceNode({ id: "source-valid", kind: "object", name: "有效图片", objectType: "image", targetType: "media", targetId: "media-valid", position: "1" }),
      workspaceNode({ id: "source-deleted", kind: "object", name: "已删除图片", objectType: "image", targetType: "media", targetId: "media-deleted", position: "2" }),
    ];
    const target = [
      workspaceNode({ id: "target-valid", kind: "object", name: "有效图片", objectType: "image", targetType: "media", targetId: "copied-valid", position: "1" }),
      workspaceNode({ id: "target-empty", kind: "object", name: "已删除图片", objectType: "image", targetType: "empty", targetId: null, position: "2" }),
    ];
    const ids = copiedWorkspaceIds(source, target);
    return ids.nodes.get("source-deleted") === "target-empty"
      && ids.media.get("media-valid") === "copied-valid"
      && !ids.media.has("media-deleted")
      ? { ok: true }
      : { ok: false, message: "a deleted media node invalidated the entire copied resource map" };
  },
  "copied media prompts point to copied assets and old drafts recover unique references": () => {
    const snapshot = createWelcomeWorkspace();
    const source = snapshot.workspaces[snapshot.initialStoryboardId];
    const copiedId = crypto.randomUUID();
    const copied = cloneStoryboardWorkspace(source, { ...source.storyboard, id: copiedId }, snapshot.objectMedia ?? {});
    const copiedAssets = workspaceComposerAssets(copied.workspace, copied.objectMedia);
    const copiedAssetIds = new Set(copiedAssets.map((asset) => asset.id));
    const sourceVideo = Object.values(snapshot.objectMedia ?? {}).find((media) => media.kind === "video" && media.prompt?.includes("引用资产："));
    const copiedVideo = Object.values(copied.objectMedia).find((media) => media.kind === "video" && media.prompt?.includes("引用资产："));
    if (!sourceVideo?.prompt || !copiedVideo?.prompt) return { ok: false, message: "reference-bearing video was not cloned" };
    const originalReferences = parseMediaPromptDraft(sourceVideo.prompt).references;
    const copiedReferences = parseMediaPromptDraft(copiedVideo.prompt).references;
    const recovered = reconcileMediaPromptReferences(originalReferences, copiedAssets);
    return copiedReferences.length === originalReferences.length
      && copiedReferences.every((reference) => copiedAssetIds.has(reference.id) && !originalReferences.some((original) => original.id === reference.id))
      && recovered.every((reference) => copiedAssetIds.has(reference.id))
      ? { ok: true }
      : { ok: false, message: "copied prompt or recovered draft still references source media" };
  },
  "workspace nodes retain durable unseen AI updates until viewed": () => {
    const nodes: WorkspaceNode[] = [
      workspaceNode({ id: "folder", kind: "folder", name: "视频", objectType: null, targetType: null, targetId: null }),
      workspaceNode({
        id: "video",
        parentId: "folder",
        kind: "object",
        name: "推进镜头",
        objectType: "video",
        targetType: "media",
        targetId: "video",
        unseenUpdateAt,
      }),
    ];
    const tree = workspaceTreeFromNodes(nodes);
    const folder = tree[0];
    if (folder?.kind !== "folder") return { ok: false, message: "folder mapping failed" };
    const video = folder.children[0];
    if (video?.kind !== "object" || video.unseenUpdateAt !== unseenUpdateAt) {
      return { ok: false, message: "unseen update was dropped while mapping the workspace tree" };
    }
    const viewed = updateNodeUnseenUpdateAt(tree, "video", null);
    const viewedFolder = viewed[0];
    const viewedVideo = viewedFolder?.kind === "folder" ? viewedFolder.children[0] : null;
    return viewedVideo?.kind === "object" && viewedVideo.unseenUpdateAt === null
      ? { ok: true }
      : { ok: false, message: "viewing the object did not clear its unseen update" };
  },
};

function workspaceNode(overrides: Partial<WorkspaceNode> & Pick<WorkspaceNode, "id" | "kind" | "name">): WorkspaceNode {
  const { id, kind, name, ...rest } = overrides;
  return {
    id,
    projectId: "10000000-0000-4000-8000-000000000001",
    storyboardId: "20000000-0000-4000-8000-000000000001",
    parentId: null,
    kind,
    name,
    objectType: null,
    targetType: null,
    targetId: null,
    position: overrides.id,
    revision: 1,
    createdAt: "2026-09-27T08:00:00Z",
    updatedAt: "2026-09-27T08:00:00Z",
    unseenUpdateAt: null,
    ...rest,
  };
}
