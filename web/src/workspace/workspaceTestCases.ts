import type { WorkspaceNode } from "../productApi/generated";
import { updateNodeUnseenUpdateAt } from "./resourceTree";
import { workspaceTreeFromNodes } from "./workspaceNodeClient";

type CaseResult = { ok: boolean; message?: string };

const unseenUpdateAt = "2026-09-27T09:00:00Z";

export const workspaceTestCases: Record<string, () => CaseResult> = {
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
