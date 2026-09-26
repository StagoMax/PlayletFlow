import { renderToStaticMarkup } from "react-dom/server";
import type { MediaItem } from "../productApi/generated";
import { MediaMetadata } from "./MediaMetadata";
import { MediaPromptComposer } from "./MediaPromptComposer";
import { MediaThumbnail } from "./MediaThumbnail";
import { MediaViewer } from "./MediaViewer";
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

  "prompt composer owns the editable prompt and generation controls"() {
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
      markup.includes("雨夜港口，完整画幅")
        && markup.includes("图片生成提示词编辑器")
        && markup.includes("生成设置"),
      "prompt editor should own the prompt, submit action and generation settings",
    );
  },

  "aspect ratio is reduced without changing its value"() {
    return check(formatAspectRatio(media({ width: 1920, height: 1080 })) === "16:9", "ratio should reduce to 16:9");
  },

  "portrait media preserves its 9:16 ratio metadata"() {
    const markup = renderToStaticMarkup(<MediaViewer item={item({ width: 1080, height: 1920 })} />);
    return check(
      markup.includes("9:16") && markup.includes("--media-aspect-ratio:1080 / 1920"),
      "portrait preview should carry the original 9:16 ratio into the viewer",
    );
  },

  "minute durations keep seconds zero-padded"() {
    return check(
      formatDuration(61_500) === "1:01.5" && formatDuration(61_000) === "1:01",
      "minute duration should remain easy to scan",
    );
  },
};
