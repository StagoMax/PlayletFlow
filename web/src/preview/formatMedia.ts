import type { MediaAccess, MediaItem, MediaRole, MediaStatus } from "../productApi/generated";

const ROLE_LABELS: Record<MediaRole, string> = {
  assetView: "资产视图",
  firstFrame: "首帧",
  lastFrame: "尾帧",
  keyframe: "关键帧",
  generatedVideo: "生成视频",
  custom: "自定义媒体",
};

const STATUS_LABELS: Record<MediaStatus, string> = {
  placeholder: "等待媒体",
  ready: "可预览",
  processing: "生成处理中",
  failed: "生成失败",
};

export function mediaRoleLabel(role: MediaRole) {
  return ROLE_LABELS[role];
}

export function mediaStatusLabel(status: MediaStatus) {
  return STATUS_LABELS[status];
}

export function formatDimensions(media: MediaItem) {
  if (!media.width || !media.height) return "未知";
  return `${media.width} × ${media.height}`;
}

export function formatAspectRatio(media: Pick<MediaItem, "width" | "height">) {
  if (!media.width || !media.height) return "未知";
  return `${reduceRatio(media.width, media.height)}`;
}

export function mediaAspectRatio(media: MediaItem) {
  if (!media.width || !media.height) return "16 / 9";
  return `${media.width} / ${media.height}`;
}

export function formatDuration(durationMs: number | null) {
  if (durationMs === null) return null;
  const totalSeconds = Math.max(0, Math.round(durationMs / 100) / 10);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds - minutes * 60;
  const formattedSeconds = seconds.toFixed(seconds % 1 === 0 ? 0 : 1);
  return minutes > 0
    ? `${minutes}:${formattedSeconds.padStart(formattedSeconds.includes(".") ? 4 : 2, "0")}`
    : `${formattedSeconds} 秒`;
}

export function formatCreatedAt(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "未知";
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

export function isAccessExpired(access: MediaAccess | null, now = Date.now()) {
  if (!access?.expiresAt) return false;
  const expiresAt = Date.parse(access.expiresAt);
  return !Number.isNaN(expiresAt) && expiresAt <= now;
}

function reduceRatio(width: number, height: number) {
  let left = Math.round(width);
  let right = Math.round(height);
  while (right !== 0) {
    const remainder = left % right;
    left = right;
    right = remainder;
  }
  return `${Math.round(width) / left}:${Math.round(height) / left}`;
}
