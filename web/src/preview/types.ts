import type { MediaItem } from "../productApi/generated";

export type PreviewItem = {
  id: string;
  name: string;
  description: string;
  label: string;
  accent: string;
  media: MediaItem;
};

