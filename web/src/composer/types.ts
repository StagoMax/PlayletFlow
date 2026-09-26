import type { HoverPreviewMedia } from "../preview/types";
import type { WorkspaceReference } from "../chat/workspaceReference";
import type { WorkspaceSelection } from "../workspace/types";

export type ComposerAssetKind = "image" | "video" | "text";

export type ComposerAssetReference = WorkspaceReference & {
  mediaId?: string;
  thumbnailUrl?: string;
  durationMs?: number | null;
  textPreview?: string;
  previewMedia?: HoverPreviewMedia;
  selection: WorkspaceSelection;
};

export type ComposerAttachment = {
  id: string;
  kind: ComposerAssetKind;
  name: string;
  mimeType: string;
  bytes: number;
  previewUrl?: string;
  textPreview?: string;
  file: File;
};

export type ComposerModelOption = {
  id: string;
  label: string;
  description?: string;
};
