import type { StoryboardWorkspace, WorkspaceTreeNode } from "../workspace/types";
import type { ComposerAssetReference } from "./types";

export function workspaceComposerAssets(workspace: StoryboardWorkspace): ComposerAssetReference[] {
  const mediaAssets = [...workspace.assetGroups, ...workspace.videoGroups]
    .flatMap((group) => group.items)
    .map((item): ComposerAssetReference => ({
      id: item.id,
      kind: item.media.kind,
      name: item.name,
      mediaId: item.media.id,
      thumbnailUrl: item.media.thumbnail?.url,
      durationMs: item.media.durationMs,
    }));

  const textAssets: ComposerAssetReference[] = [
    {
      id: `script-${workspace.storyboard.id}`,
      kind: "text",
      name: "分镜脚本",
      textPreview: compactText(workspace.storyboard.script.text),
    },
    ...emptyTextAssets(workspace.navigationTree),
  ];

  return uniqueById([...mediaAssets, ...textAssets]);
}

function emptyTextAssets(nodes: WorkspaceTreeNode[]): ComposerAssetReference[] {
  const assets: ComposerAssetReference[] = [];
  for (const node of nodes) {
    if (node.kind === "folder") {
      assets.push(...emptyTextAssets(node.children));
    } else if (node.objectType === "text" && node.selection.kind === "emptyObject") {
      assets.push({
        id: node.id,
        kind: "text",
        name: node.name,
        textPreview: "尚未填写内容",
      });
    }
  }
  return assets;
}

function compactText(value: string) {
  const normalized = value.replace(/\s+/gu, " ").trim();
  return normalized.length > 96 ? `${normalized.slice(0, 96)}…` : normalized;
}

function uniqueById(assets: ComposerAssetReference[]) {
  const seen = new Set<string>();
  return assets.filter((asset) => {
    if (seen.has(asset.id)) return false;
    seen.add(asset.id);
    return true;
  });
}
