import type { MediaItem } from "../productApi/generated";
import type {
  NavigatorItem,
  StoryboardWorkspace,
  WorkspaceObjectNode,
  WorkspaceTreeNode,
} from "../workspace/types";
import type { ComposerAssetReference } from "./types";

export function workspaceComposerAssets(
  workspace: StoryboardWorkspace,
  objectMedia: Readonly<Record<string, MediaItem>> = {},
): ComposerAssetReference[] {
  const itemsById = new Map(
    [...workspace.assetGroups, ...workspace.videoGroups]
      .flatMap((group) => group.items)
      .map((item) => [item.id, item]),
  );
  const assets: ComposerAssetReference[] = [{
    id: `script-${workspace.storyboard.id}`,
    kind: "text",
    name: "片段脚本",
    textPreview: compactText(workspace.storyboard.script.text),
    selection: { kind: "script", storyboardId: workspace.storyboard.id },
  }];
  collectTreeAssets(workspace.navigationTree, itemsById, objectMedia, assets);
  return uniqueById(assets);
}

function collectTreeAssets(
  nodes: readonly WorkspaceTreeNode[],
  itemsById: ReadonlyMap<string, NavigatorItem>,
  objectMedia: Readonly<Record<string, MediaItem>>,
  assets: ComposerAssetReference[],
) {
  for (const node of nodes) {
    if (node.kind === "folder") {
      collectTreeAssets(node.children, itemsById, objectMedia, assets);
      continue;
    }
    const asset = assetFromNode(node, itemsById, objectMedia);
    if (asset) assets.push(asset);
  }
}

function assetFromNode(
  node: WorkspaceObjectNode,
  itemsById: ReadonlyMap<string, NavigatorItem>,
  objectMedia: Readonly<Record<string, MediaItem>>,
): ComposerAssetReference | null {
  const selection = { ...node.selection, nodeId: node.id };
  if (node.selection.kind === "script") return null;
  if (node.objectType === "text") {
    return {
      id: node.id,
      kind: "text",
      name: node.name,
      textPreview: "尚未填写内容",
      selection,
    };
  }
  const media = node.selection.kind === "item"
    ? itemsById.get(node.selection.itemId)?.media
    : objectMedia[node.id];
  if (!media) return null;
  return mediaAsset(node.name, media, selection);
}

function mediaAsset(
  name: string,
  media: MediaItem,
  selection: ComposerAssetReference["selection"],
): ComposerAssetReference {
  return {
    id: media.id,
    kind: media.kind,
    name,
    mediaId: media.id,
    thumbnailUrl: media.thumbnail?.url,
    durationMs: media.durationMs,
    selection,
    previewMedia: {
      kind: media.kind,
      status: media.status,
      width: media.width,
      height: media.height,
      durationMs: media.durationMs,
      mimeType: media.mimeType,
      thumbnail: media.thumbnail,
      preview: media.preview,
    },
  };
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
