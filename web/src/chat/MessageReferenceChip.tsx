import type { ComposerAssetReference } from "../composer/types";
import { HoverPreview } from "../preview/HoverPreview";
import { Icon } from "../workspace/Icons";
import type { WorkspaceReference } from "./workspaceReference";

type MessageReferenceChipProps = {
  reference: WorkspaceReference;
  asset?: ComposerAssetReference;
  onSelectReference: (reference: ComposerAssetReference) => void;
};

export function MessageReferenceChip({
  reference,
  asset,
  onSelectReference,
}: MessageReferenceChipProps) {
  if (!asset) {
    return (
      <span
        className="message-reference-chip is-unavailable"
        aria-label={`${reference.name}，引用不可用`}
        title="引用已不可用"
      >
        <ReferencePreview reference={reference} />
        <span>{reference.name}</span>
      </span>
    );
  }

  const chip = (
    <button
      className="message-reference-chip"
      type="button"
      aria-label={asset.kind === "text" ? `打开${asset.name}` : `预览${asset.name}`}
      title={asset.kind === "text" ? `打开${asset.name}` : `预览${asset.name}`}
      onClick={asset.kind === "text" ? () => onSelectReference(asset) : undefined}
    >
      <ReferencePreview reference={reference} asset={asset} />
      <span>{asset.name}</span>
    </button>
  );

  if (!asset.previewMedia) return chip;
  return (
    <HoverPreview
      item={{ name: asset.name, media: asset.previewMedia }}
      placement="top"
      openDelayMs={180}
      className="message-reference-hover"
    >
      {chip}
    </HoverPreview>
  );
}

function ReferencePreview({
  reference,
  asset,
}: {
  reference: WorkspaceReference;
  asset?: ComposerAssetReference;
}) {
  if (asset?.thumbnailUrl && (reference.kind === "image" || reference.kind === "video")) {
    return (
      <img
        className="message-reference-chip__preview"
        src={asset.thumbnailUrl}
        alt=""
        width={20}
        height={20}
        decoding="async"
      />
    );
  }
  return (
    <span className={`message-reference-chip__preview is-${reference.kind}`} aria-hidden="true">
      <Icon name={reference.kind === "text" ? "file-text" : reference.kind === "video" ? "film" : "image"} />
    </span>
  );
}
