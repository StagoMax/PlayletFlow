import { useEffect, useRef, useState } from "react";
import { Icon } from "../workspace/Icons";
import type { ComposerAssetKind, ComposerAssetReference, ComposerAttachment } from "./types";

type ComposerSourcesProps = {
  attachments: readonly ComposerAttachment[];
  references: readonly ComposerAssetReference[];
  assets: readonly ComposerAssetReference[];
  selectedMediaIds?: readonly string[];
  showAddControl?: boolean;
  onAddAsset: () => void;
  onAttach: () => void;
  onRemoveReference: (id: string) => void;
  onRemoveSelectedMedia?: (mediaId: string) => void;
  onRemoveAttachment: (id: string) => void;
  disabled?: boolean;
};

type DisplaySource = {
  key: string;
  type: "reference" | "selected" | "attachment";
  kind: ComposerAssetKind;
  name: string;
  thumbnailUrl?: string;
  referenceId?: string;
  mediaId?: string;
  attachment?: ComposerAttachment;
  label: string;
};

export function ComposerSources({
  attachments,
  references,
  assets,
  selectedMediaIds = [],
  showAddControl = true,
  onAddAsset,
  onAttach,
  onRemoveReference,
  onRemoveSelectedMedia,
  onRemoveAttachment,
  disabled = false,
}: ComposerSourcesProps) {
  const addRef = useRef<HTMLDivElement>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [menuAlignRight, setMenuAlignRight] = useState(false);
  useEffect(() => {
    if (!addOpen) return;
    const closeOnOutsideClick = (event: PointerEvent) => {
      if (!addRef.current?.contains(event.target as Node)) setAddOpen(false);
    };
    const closeOnEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") setAddOpen(false);
    };
    document.addEventListener("pointerdown", closeOnOutsideClick);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOnOutsideClick);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [addOpen]);
  useEffect(() => { if (disabled) setAddOpen(false); }, [disabled]);
  const sources: DisplaySource[] = [];
  const shownAssets = new Set<string>();
  const assetsByMediaId = new Map(assets.flatMap((asset) =>
    asset.mediaId ? [[asset.mediaId, asset] as const] : []));

  for (const reference of references) {
    const key = reference.mediaId ?? reference.id;
    if (shownAssets.has(key)) continue;
    shownAssets.add(key);
    sources.push({
      key: `reference:${key}`,
      type: "reference",
      kind: reference.kind,
      name: reference.name,
      thumbnailUrl: reference.thumbnailUrl,
      referenceId: reference.id,
      label: `已引用资产：${reference.name}`,
    });
  }
  for (const mediaId of selectedMediaIds) {
    if (shownAssets.has(mediaId)) continue;
    shownAssets.add(mediaId);
    const asset = assetsByMediaId.get(mediaId);
    sources.push({
      key: `selected:${mediaId}`,
      type: "selected",
      kind: "image",
      name: asset?.name ?? mediaId,
      thumbnailUrl: asset?.thumbnailUrl,
      mediaId,
      label: `已选参考图片：${asset?.name ?? mediaId}`,
    });
  }
  for (const attachment of attachments) {
    sources.push({
      key: `attachment:${attachment.id}`,
      type: "attachment",
      kind: attachment.kind,
      name: attachment.name,
      thumbnailUrl: attachment.previewUrl,
      attachment,
      label: `已添加附件：${attachment.name}`,
    });
  }

  if (sources.length === 0 && !showAddControl) return null;

  return (
    <div className="shared-composer-sources" aria-label="已使用的资产">
      {sources.length > 0 ? <div className="shared-composer-sources__list" role="list">
        {sources.map((source) => (
          <div className={`shared-composer-source is-${source.type}`} role="listitem" aria-label={source.label} title={source.name} key={source.key}>
            <SourcePreview source={source} />
            {source.attachment || source.referenceId || (source.mediaId && onRemoveSelectedMedia) ? (
              <button
                type="button"
                className="shared-composer-source__remove"
                disabled={disabled}
                onClick={() => {
                  if (source.attachment) onRemoveAttachment(source.attachment.id);
                  else if (source.referenceId) onRemoveReference(source.referenceId);
                  else if (source.mediaId) onRemoveSelectedMedia?.(source.mediaId);
                }}
                aria-label={`${source.attachment ? "移除附件" : source.referenceId ? "移除资产引用" : "移除参考图片"} ${source.name}`}
                title={`${source.attachment ? "移除附件" : source.referenceId ? "移除资产引用" : "移除参考图片"} ${source.name}`}
              >×</button>
            ) : null}
          </div>
        ))}
      </div> : null}
      {showAddControl ? <div className="shared-composer-sources__add-wrap" ref={addRef}>
        <button
          type="button"
          className="shared-composer-sources__add"
          onClick={() => {
            const button = addRef.current?.getBoundingClientRect();
            const surface = addRef.current?.closest(".composer-surface")?.getBoundingClientRect();
            if (button && surface) setMenuAlignRight(button.left + 174 > surface.right - 8);
            setAddOpen((current) => !current);
          }}
          disabled={disabled}
          aria-label="添加资产或附件"
          aria-haspopup="menu"
          aria-expanded={addOpen}
          title="添加资产或附件"
        >
          <Icon name="plus" />
        </button>
        {addOpen ? (
          <div className={`shared-composer-sources__menu${menuAlignRight ? " is-right" : ""}`} role="menu" aria-label="添加资产或附件">
            <button type="button" role="menuitem" onClick={() => { setAddOpen(false); onAddAsset(); }}>引用工作区资产</button>
            <button type="button" role="menuitem" onClick={() => { setAddOpen(false); onAttach(); }}>上传附件</button>
          </div>
        ) : null}
      </div> : null}
    </div>
  );
}

function SourcePreview({ source }: { source: DisplaySource }) {
  if (source.thumbnailUrl && (source.kind === "image" || source.kind === "video")) {
    if (source.attachment?.kind === "video") {
      return <video src={source.thumbnailUrl} muted playsInline preload="metadata" aria-hidden="true" />;
    }
    return <img src={source.thumbnailUrl} alt="" loading="lazy" decoding="async" draggable={false} />;
  }
  return (
    <span className="shared-composer-source__fallback" aria-hidden="true">
      <Icon name={source.kind === "image" ? "image" : source.kind === "video" ? "film" : "file-text"} />
    </span>
  );
}
