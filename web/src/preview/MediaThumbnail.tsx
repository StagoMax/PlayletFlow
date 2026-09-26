import { Icon } from "../workspace/Icons";
import { BrokenMediaIcon, ClockIcon } from "./PreviewIcons";
import { formatDuration, isAccessExpired, mediaStatusLabel } from "./formatMedia";
import type { PreviewItem } from "./types";
import type { CSSProperties } from "react";
import "./preview.css";

type MediaThumbnailProps = {
  item: PreviewItem;
};

export function MediaThumbnail({ item }: MediaThumbnailProps) {
  const { media } = item;
  const thumbnail = media.thumbnail;
  const hasThumbnail = media.status === "ready" && thumbnail && !isAccessExpired({ ...thumbnail, mimeType: media.mimeType });
  const duration = formatDuration(media.durationMs);

  return (
    <span
      className={`media-thumbnail media-thumbnail-${media.status}`}
      style={{ "--media-accent": item.accent } as CSSProperties}
      aria-hidden="true"
    >
      {hasThumbnail ? (
        <img
          src={thumbnail.url}
          alt=""
          width={thumbnail.width}
          height={thumbnail.height}
          loading="lazy"
          decoding="async"
        />
      ) : (
        <span className="media-thumbnail-placeholder">
          <span className="thumbnail-grid" />
          {media.status === "failed" ? (
            <BrokenMediaIcon />
          ) : media.status === "processing" ? (
            <span className="media-thumbnail-spinner" />
          ) : media.kind === "video" ? (
            <Icon name="play" />
          ) : (
            <Icon name="image" />
          )}
        </span>
      )}
      <span className="media-thumbnail-label">{item.label}</span>
      {media.kind === "video" ? (
        <span className="media-thumbnail-kind"><Icon name="play" /></span>
      ) : null}
      {duration ? <span className="media-thumbnail-duration">{duration}</span> : null}
      {media.status !== "ready" ? (
        <span className="media-thumbnail-status">
          {media.status === "processing" ? <ClockIcon /> : null}
          {mediaStatusLabel(media.status)}
        </span>
      ) : null}
    </span>
  );
}
