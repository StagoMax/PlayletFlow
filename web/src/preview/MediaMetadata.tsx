import {
  formatAspectRatio,
  formatCreatedAt,
  formatDimensions,
  formatDuration,
} from "./formatMedia";
import type { PreviewItem } from "./types";

export function MediaMetadata({ item }: { item: PreviewItem }) {
  const { media } = item;
  const duration = formatDuration(media.durationMs);
  return (
    <dl className="media-header-metadata" aria-label={`${item.name}媒体信息`}>
      <div><dt>尺寸</dt><dd>{formatDimensions(media)}</dd></div>
      <div><dt>比例</dt><dd>{formatAspectRatio(media)}</dd></div>
      {duration ? <div><dt>时长</dt><dd>{duration}</dd></div> : null}
      <div><dt>创建时间</dt><dd>{formatCreatedAt(media.createdAt)}</dd></div>
    </dl>
  );
}
