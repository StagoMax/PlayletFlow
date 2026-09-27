import { renderToStaticMarkup } from "react-dom/server";
import type { MediaItem } from "../productApi/generated";
import { MediaMetadata } from "./MediaMetadata";
import { MediaPromptComposer, synchronizePromptDraft } from "./MediaPromptComposer";
import { composeSubmissionText } from "../composer/submission";
import type { ComposerAssetReference } from "../composer/types";
import { parseMediaPromptDraft, synchronizeMediaPromptDraft } from "./mediaPromptDraft";
import { imageGenerationInput } from "../generation/generationOptions";
import { MediaThumbnail } from "./MediaThumbnail";
import { MediaViewer } from "./MediaViewer";
import { hoverPreviewSize } from "./HoverPreview";
import { formatAspectRatio, formatDuration } from "./formatMedia";
import type { PreviewItem } from "./types";

type TestResult = { ok: true; message: string } | { ok: false; message: string };

function check(condition: boolean, message: string): TestResult {
  return condition ? { ok: true, message } : { ok: false, message };
}

function media(overrides: Partial<MediaItem> = {}): MediaItem {
  return {
    id: "media-1",
    projectId: "project-1",
    owner: { type: "storyboard", storyboardId: "storyboard-1" },
    kind: "image",
    role: "keyframe",
    name: "雨夜关键帧",
    prompt: "雨夜港口，完整画幅",
    mimeType: "image/webp",
    width: 1600,
    height: 900,
    durationMs: null,
    status: "ready",
    revision: 2,
    thumbnail: { url: "/thumb.webp", expiresAt: null, width: 320, height: 180 },
    preview: { url: "/preview.webp", expiresAt: null, width: 1600, height: 900, mimeType: "image/webp" },
    generation: { jobId: "job-1", provider: "fixture", model: "preview-test", error: null },
    createdAt: "2026-09-25T08:20:00.000Z",
    updatedAt: "2026-09-26T06:30:00.000Z",
    ...overrides,
  };
}

function item(overrides: Partial<MediaItem> = {}): PreviewItem {
  const previewMedia = media(overrides);
  return {
    id: previewMedia.id,
    name: previewMedia.name,
    description: "测试媒体",
    label: "关键帧",
    accent: "#8293ff",
    media: previewMedia,
  };
}

export const previewTestCases: Record<string, () => TestResult> = {
  "saved media prompts restore reference IDs without duplicating their footer"() {
    const reference: ComposerAssetReference = {
      id: "86bf4fd5-df01-466c-a535-1a5964248977",
      name: "东施-正面图",
      kind: "image",
      mediaId: "86bf4fd5-df01-466c-a535-1a5964248977",
      selection: { kind: "emptyObject", objectId: "image-1", objectType: "image" },
    };
    const body = "@东施-正面图 让这个正面图放大详细一点。";
    const saved = composeSubmissionText(body, [reference], []);
    const restored = parseMediaPromptDraft(saved);
    const repeated = composeSubmissionText(restored.text, [reference], []);
    const previouslyDuplicated = parseMediaPromptDraft(`${saved}\n\n${saved.slice(saved.indexOf("引用资产："))}`);
    const updated = synchronizeMediaPromptDraft(parseMediaPromptDraft(""), "", saved);
    const dirty = synchronizeMediaPromptDraft({ text: "正在编辑", references: [] }, "", saved);
    const malformed = parseMediaPromptDraft(`${body}\n\n引用资产：\n- 图片「东施-正面图」(broken`);
    return check(
      restored.text === body
        && restored.references[0]?.id === reference.id
        && restored.references[0]?.name === reference.name
        && repeated === saved
        && previouslyDuplicated.text === body
        && previouslyDuplicated.references.length === 1
        && updated.references[0]?.id === reference.id
        && dirty.text === "正在编辑"
        && malformed.text.endsWith("(broken"),
      "refresh should restore the saved reference by ID, keep a local draft, and avoid a second reference footer",
    );
  },
  "media prompt follows an externally saved prompt without replacing a local draft"() {
    const synchronized = synchronizePromptDraft("", "", "AI 写入的新提示词");
    const preserved = synchronizePromptDraft("用户正在编辑", "", "AI 写入的新提示词");
    return check(
      synchronized === "AI 写入的新提示词" && preserved === "用户正在编辑",
      "external prompt updates should populate a pristine editor and preserve a dirty draft",
    );
  },
  "thumbnail uses a square crop source with lazy loading metadata"() {
    const markup = renderToStaticMarkup(<MediaThumbnail item={item()} />);
    return check(
      markup.includes("media-thumbnail") && markup.includes("loading=\"lazy\"") && markup.includes("width=\"320\""),
      "thumbnail should reserve dimensions and lazy-load its dedicated source",
    );
  },

  "main image preview uses the full preview source and accessible name"() {
    const markup = renderToStaticMarkup(<MediaViewer item={item()} />);
    return check(
      markup.includes("/preview.webp")
        && markup.includes("alt=\"雨夜关键帧\"")
        && markup.includes("aria-label=\"图片缩放控制\"")
        && markup.includes("aria-label=\"适应窗口\""),
      "main viewer should render the full image with accessible zoom and fit controls",
    );
  },

  "video preview exposes native controls"() {
    const video = item({
      kind: "video",
      role: "generatedVideo",
      mimeType: "video/mp4",
      durationMs: 6_000,
      preview: { url: "/clip.mp4", expiresAt: null, width: 1920, height: 1080, mimeType: "video/mp4" },
    });
    const markup = renderToStaticMarkup(<MediaViewer item={video} />);
    return check(markup.includes("<video") && markup.includes("controls=\"\""), "video viewer should use native playback controls");
  },

  "video poster still uses the video viewer when the source is pending"() {
    const pendingVideo = item({ kind: "video", role: "generatedVideo", mimeType: "video/mp4", preview: null });
    const markup = renderToStaticMarkup(<MediaViewer item={pendingVideo} />);
    return check(
      markup.includes("<video") && markup.includes("视频源尚未就绪"),
      "video items should keep a familiar video surface while their playable source is pending",
    );
  },

  "processing media announces a non-fabricated status"() {
    const markup = renderToStaticMarkup(<MediaViewer item={item({ status: "processing", preview: null })} />);
    return check(
      markup.includes("aria-live=\"polite\"") && markup.includes("不展示虚假的进度百分比"),
      "processing state should be announced without inventing progress",
    );
  },

  "expired access offers an explicit refresh path"() {
    const expired = item({
      preview: { url: "/expired.webp", expiresAt: "2020-01-01T00:00:00.000Z", width: 1600, height: 900, mimeType: "image/webp" },
    });
    const markup = renderToStaticMarkup(<MediaViewer item={expired} onRefreshAccess={() => undefined} />);
    return check(markup.includes("预览地址已过期") && markup.includes("刷新访问地址"), "expired access should explain recovery");
  },

  "media metadata keeps non-prompt details out of the editor"() {
    const markup = renderToStaticMarkup(<MediaMetadata item={item()} />);
    return check(
      markup.includes("1600 × 900")
        && markup.includes("16:9")
        && !markup.includes("雨夜港口，完整画幅")
        && !markup.includes("类型")
        && !markup.includes("状态")
        && !markup.includes("来源任务")
        && !markup.includes("preview-test"),
      "header metadata should keep dimensions and ratio without prompt or redundant metadata",
    );
  },

  "image prompt composer shows size beside the mention control without settings"() {
    const markup = renderToStaticMarkup(
      <MediaPromptComposer
        initialPrompt="雨夜港口，完整画幅"
        kind="image"
        media={[]}
        assets={[]}
        loadModels={async () => []}
        onGenerate={async () => { throw new Error("not submitted during render"); }}
      />,
    );
    return check(
      markup.includes("图片生成提示词编辑器")
        && markup.includes("role=\"textbox\"")
        && markup.includes("aria-label=\"生成提示词\"")
        && markup.includes("aria-label=\"添加附件\"")
        && /引用资产[\s\S]*图片规格[\s\S]*Seedream 5\.0 Lite/u.test(markup)
        && !markup.includes("aria-label=\"添加资产或附件\"")
        && !markup.includes("打开生成设置")
        && !markup.includes("仅使用提示词"),
      "image size should be inline after @ and image mode should not need settings",
    );
  },

  "image inputs follow referenced and uploaded images"() {
    const noImages = imageGenerationInput([], []);
    const withImages = imageGenerationInput(["media-1"], [{ id: "upload-1", file: {} as File }]);
    return check(
      noImages.type === "textOnly"
        && withImages.type === "referenceImages"
        && withImages.mediaIds.join(",") === "media-1,upload-1",
      "image generation should derive its input mode from present images",
    );
  },

  "aspect ratio is reduced without changing its value"() {
    return check(formatAspectRatio(media({ width: 1920, height: 1080 })) === "16:9", "ratio should reduce to 16:9");
  },

  "portrait media keeps one 9:16 label and its full viewer ratio"() {
    const portrait = item({ width: 1080, height: 1920 });
    const markup = renderToStaticMarkup(<><MediaMetadata item={portrait} /><MediaViewer item={portrait} /></>);
    return check(
      markup.match(/9:16/g)?.length === 1 && markup.includes("--media-aspect-ratio:1080 / 1920"),
      "portrait ratio should appear once in the header while the viewer keeps its full frame",
    );
  },

  "hover preview follows source dimensions and fits the viewport"() {
    const portrait = media({ width: 1080, height: 1920, preview: { url: "/portrait.webp", expiresAt: null, width: 1080, height: 1920, mimeType: "image/webp" } });
    const landscape = media({ width: 1920, height: 1080, preview: { url: "/landscape.webp", expiresAt: null, width: 1920, height: 1080, mimeType: "image/webp" } });
    const portraitSize = hoverPreviewSize(portrait, 1280, 720);
    const landscapeSize = hoverPreviewSize(landscape, 1280, 720);
    const shortViewportSize = hoverPreviewSize(portrait, 1280, 420);
    return check(
      portraitSize.width / portraitSize.height === 1080 / 1920
        && landscapeSize.width / landscapeSize.height === 1920 / 1080
        && portraitSize.width === 267
        && landscapeSize.width === 267
        && shortViewportSize.height <= 420 - 32
        && shortViewportSize.width < portraitSize.width,
      "hover panel should use each media ratio and shrink tall media within the visible viewport",
    );
  },

  "minute durations keep seconds zero-padded"() {
    return check(
      formatDuration(61_500) === "1:01.5" && formatDuration(61_000) === "1:01",
      "minute duration should remain easy to scan",
    );
  },
};
