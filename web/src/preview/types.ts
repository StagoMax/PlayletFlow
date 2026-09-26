import type { MediaItem } from "../productApi/generated";

export type PreviewItem = {
  id: string;
  name: string;
  description: string;
  label: string;
  accent: string;
  media: MediaItem;
};

export type HoverPreviewMedia = Pick<
  MediaItem,
  "kind" | "status" | "width" | "height" | "durationMs" | "mimeType" | "thumbnail" | "preview"
>;

export type HoverPreviewItem = {
  name: string;
  media: HoverPreviewMedia;
};
