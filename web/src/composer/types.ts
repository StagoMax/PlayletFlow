export type ComposerAssetKind = "image" | "video" | "text";

export type ComposerAssetReference = {
  id: string;
  kind: ComposerAssetKind;
  name: string;
  mediaId?: string;
  thumbnailUrl?: string;
  durationMs?: number | null;
  textPreview?: string;
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
