import type { MediaItem } from "../productApi/generated";
import type { StoryboardWorkspace } from "../workspace/types";
import { findAssetMentionQuery } from "./assetMention";
import { inlineReferenceSegments, removeInlineReference } from "./inlineReferences";
import { workspaceComposerAssets } from "./workspaceAssets";

type TestResult = { ok: boolean; message: string };

function media(id: string, kind: "image" | "video", status: MediaItem["status"] = "ready"): MediaItem {
  return {
    id,
    projectId: "project-1",
    owner: { type: "storyboard", storyboardId: "storyboard-1" },
    kind,
    role: kind === "image" ? "assetView" : "generatedVideo",
    name: id,
    prompt: null,
    mimeType: kind === "image" ? "image/png" : "video/mp4",
    width: 1280,
    height: 720,
    durationMs: kind === "video" ? 4_000 : null,
    status,
    revision: 1,
    thumbnail: status === "placeholder" ? null : { url: `/${id}.webp`, expiresAt: null, width: 320, height: 180 },
    preview: status === "ready" ? { url: `/${id}`, expiresAt: null, width: 1280, height: 720, mimeType: kind === "image" ? "image/png" : "video/mp4" } : null,
    generation: null,
    createdAt: "2026-09-27T00:00:00Z",
    updatedAt: "2026-09-27T00:00:00Z",
  };
}

const workspace: StoryboardWorkspace = {
  storyboard: {
    id: "storyboard-1",
    projectId: "project-1",
    name: "测试片段",
    position: "a",
    index: 1,
    revision: 1,
    pendingProposalCount: 0,
    thumbnail: null,
    updatedAt: "2026-09-27T00:00:00Z",
    script: { text: "片段脚本正文", revision: 1, updatedAt: "2026-09-27T00:00:00Z" },
    counts: { assetBindings: 0, keyframes: 0, videos: 0 },
    createdAt: "2026-09-27T00:00:00Z",
  },
  assetGroups: [],
  videoGroups: [],
  navigationTree: [{
    kind: "folder",
    id: "assets",
    name: "资产",
    children: [
      { kind: "object", id: "image-1", name: "角色正面图", objectType: "image", mediaId: "image-1", unseenUpdateAt: null, selection: { kind: "emptyObject", objectId: "image-1", objectType: "image" } },
      { kind: "object", id: "video-1", name: "动作参考", objectType: "video", mediaId: "video-1", unseenUpdateAt: null, selection: { kind: "emptyObject", objectId: "video-1", objectType: "video" } },
      { kind: "object", id: "image-empty", name: "尚未上传", objectType: "image", mediaId: "image-empty", unseenUpdateAt: null, selection: { kind: "emptyObject", objectId: "image-empty", objectType: "image" } },
      { kind: "object", id: "notes", name: "导演备注", objectType: "text", unseenUpdateAt: null, selection: { kind: "emptyObject", objectId: "notes", objectType: "text" } },
    ],
  }],
};

export const composerTestCases: Record<string, () => TestResult> = {
  "an inline reference is not reopened as a mention search"() {
    const marker = "@角色正面图";
    const protectedRange = { start: 0, end: marker.length };
    const besideReference = findAssetMentionQuery(marker, marker.length, [protectedRange]);
    const newQueryValue = `${marker}@动作`;
    const newQuery = findAssetMentionQuery(newQueryValue, newQueryValue.length, [protectedRange]);
    return {
      ok: besideReference === null
        && newQuery?.start === marker.length
        && newQuery.query === "动作",
      message: "引用标签自身的 @ 不应重新打开搜索，但标签后的新 @ 仍应可检索。",
    };
  },
  "a mention starts immediately after ordinary text"() {
    const value = "请参考@角色";
    const trigger = findAssetMentionQuery(value, 4);
    const mention = findAssetMentionQuery(value, value.length);
    return {
      ok: trigger?.start === 3 && trigger.query === ""
        && mention?.start === 3 && mention.end === value.length && mention.query === "角色",
      message: "正文后直接输入 @ 应打开引用搜索，无需先输入空格。",
    };
  },
  "asset markers become inline reference segments without losing surrounding text"() {
    const references = workspaceComposerAssets(workspace, {
      "image-1": media("image-1", "image"),
      "video-1": media("video-1", "video"),
    }).filter((asset) => asset.id === "image-1" || asset.id === "video-1");
    const segments = inlineReferenceSegments(
      "参考 @角色正面图 后衔接 @动作参考。",
      references,
    );
    const summary = segments.map((segment) => segment.type === "text"
      ? `text:${segment.text}`
      : `reference:${segment.reference.name}`);
    return {
      ok: summary.join("|") === "text:参考 |reference:角色正面图|text: 后衔接 |reference:动作参考|text:。",
      message: "素材标记应在原位置渲染为行内引用，同时保持标记前后的提示词顺序。",
    };
  },
  "removing one reference leaves longer names and other references intact"() {
    const references = workspaceComposerAssets(workspace, {
      "image-1": media("image-1", "image"),
      "video-1": media("video-1", "video"),
    }).filter((asset) => asset.id === "image-1" || asset.id === "video-1");
    const shorter = { ...references[0], name: "角色" };
    const longer = { ...references[1], name: "角色正面图" };
    const result = removeInlineReference("@角色 @角色正面图 @角色", [shorter, longer], shorter.id);
    return {
      ok: result === " @角色正面图 ",
      message: "删除缩略图引用时，应删除该引用的所有行内标记，不破坏名称相近的其他引用。",
    };
  },
  "workspace references include media-backed tree objects"() {
    const assets = workspaceComposerAssets(workspace, {
      "image-1": media("image-1", "image"),
      "video-1": media("video-1", "video"),
      "image-empty": media("image-empty", "image", "placeholder"),
    });
    const summary = assets.map((asset) => `${asset.kind}:${asset.name}:${asset.mediaId ?? "text"}`);
    return {
      ok: summary.join("|") === [
        "text:片段脚本:text",
        "image:角色正面图:image-1",
        "video:动作参考:video-1",
        "image:尚未上传:image-empty",
        "text:导演备注:text",
      ].join("|"),
      message: "资源树中的图片和视频对象都应进入引用列表，并保留真实媒体状态供生成入口校验。",
    };
  },
};
