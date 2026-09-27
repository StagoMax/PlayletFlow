import { useState } from "react";
import { Icon } from "../workspace/Icons";
import { ImagePreviewSurface } from "./ImagePreviewSurface";
import { BrokenMediaIcon, ClockIcon, RefreshMediaIcon } from "./PreviewIcons";
import {
  isAccessExpired,
  mediaAspectRatio,
} from "./formatMedia";
import type { PreviewItem } from "./types";
import type { CSSProperties, ReactNode, SyntheticEvent } from "react";
import "./preview.css";

type MediaViewerProps = {
  item: PreviewItem | null;
  onRefreshAccess?: (mediaId: string) => void;
  onPreviewClick?: () => void;
};

export function MediaViewer({ item, onRefreshAccess, onPreviewClick }: MediaViewerProps) {
  if (!item) {
    return (
      <section className="media-viewer" aria-label="媒体预览" onClick={onPreviewClick}>
        <ViewerState icon={<Icon name="image" />} title="请选择媒体" description="从左侧选择图片或视频以查看完整预览。" />
      </section>
    );
  }

  const { media } = item;
  const previewExpired = isAccessExpired(media.preview);
  const thumbnailExpired = media.thumbnail
    ? isAccessExpired({ ...media.thumbnail, mimeType: media.mimeType })
    : false;
  const preview = previewExpired ? null : media.preview;
  const thumbnail = thumbnailExpired ? null : media.thumbnail;
  const style = {
    "--media-aspect-ratio": mediaAspectRatio(media),
    "--media-accent": item.accent,
  } as CSSProperties;

  let content;
  if (media.status === "processing") {
    content = <ViewerState live icon={<ClockIcon />} title="媒体正在生成" description="完成后会在这里显示预览，不展示虚假的进度百分比。" />;
  } else if (media.status === "failed") {
    content = (
      <ViewerState
        alert
        icon={<BrokenMediaIcon />}
        title="媒体生成失败"
        description={media.generation?.error || "生成服务没有返回可预览内容。"}
      />
    );
  } else if (media.status === "placeholder") {
    content = <ViewerState icon={<Icon name="image" />} title="等待添加媒体" description="当前条目只有名称和提示词，尚未关联图片或视频。" />;
  } else if (previewExpired || thumbnailExpired) {
    content = (
      <ViewerState
        icon={<RefreshMediaIcon />}
        title="预览地址已过期"
        description="刷新安全访问地址后即可继续预览。"
        action={onRefreshAccess ? () => onRefreshAccess(media.id) : undefined}
      />
    );
  } else if (media.kind === "video" && (preview?.mimeType.startsWith("video/") || thumbnail?.url)) {
    const source = preview?.mimeType.startsWith("video/") ? preview.url : undefined;
    content = <VideoSurface key={source || thumbnail?.url} src={source} poster={thumbnail?.url} name={media.name} />;
  } else if (media.kind === "image" && (preview?.url || thumbnail?.url)) {
    const source = preview?.url || thumbnail?.url || "";
    content = <ImageSurface key={source} src={source} name={media.name} />;
  } else {
    content = <ViewerState icon={media.kind === "video" ? <Icon name="play" /> : <Icon name="image" />} title="暂无可用预览" description="媒体元数据已保存，但当前没有可访问的预览地址。" />;
  }

  return (
    <figure className="media-viewer" aria-label={`${media.name}媒体预览`} onClick={onPreviewClick}>
      <div className="media-viewer-glow" style={style} />
      <div className="media-viewer-frame" style={style}>{content}</div>
    </figure>
  );
}

function ImageSurface({ src, name }: { src: string; name: string }) {
  const [failed, setFailed] = useState(false);
  if (failed) {
    return <ViewerState alert icon={<BrokenMediaIcon />} title="图片加载失败" description="访问地址不可用，请刷新后重试。" />;
  }
  return <ImagePreviewSurface src={src} name={name} onError={() => setFailed(true)} />;
}

function VideoSurface({ src, poster, name }: { src?: string; poster?: string; name: string }) {
  const [failed, setFailed] = useState(false);
  if (failed) {
    return <ViewerState alert icon={<BrokenMediaIcon />} title="视频加载失败" description="已保留海报帧，请刷新访问地址后重试。" />;
  }
  const onError = (_event: SyntheticEvent<HTMLVideoElement>) => setFailed(true);
  return (
    <div className="media-viewer-video-shell">
      <div className="media-viewer-media-stage">
        <video className="media-viewer-video" src={src} poster={poster} controls preload="metadata" playsInline aria-label={`${name}视频预览`} onError={src ? onError : undefined} />
      </div>
      {!src ? <span className="media-viewer-video-notice"><Icon name="play" />视频源尚未就绪</span> : null}
    </div>
  );
}

function ViewerState({
  icon,
  title,
  description,
  action,
  live = false,
  alert = false,
}: {
  icon: ReactNode;
  title: string;
  description: string;
  action?: () => void;
  live?: boolean;
  alert?: boolean;
}) {
  return (
    <div className="media-viewer-state" role={alert ? "alert" : undefined} aria-live={live ? "polite" : undefined}>
      <span>{icon}</span>
      <strong>{title}</strong>
      <p>{description}</p>
      {action ? <button type="button" onClick={action}><RefreshMediaIcon />刷新访问地址</button> : null}
    </div>
  );
}
