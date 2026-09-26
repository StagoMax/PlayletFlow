import { Icon } from "../workspace/Icons";
import type { ComposerAssetReference, ComposerAttachment } from "./types";

type ComposerSourcesProps = {
  references: readonly ComposerAssetReference[];
  attachments: readonly ComposerAttachment[];
  onRemoveReference: (id: string) => void;
  onRemoveAttachment: (id: string) => void;
};

export function ComposerSources({
  references,
  attachments,
  onRemoveReference,
  onRemoveAttachment,
}: ComposerSourcesProps) {
  if (references.length === 0 && attachments.length === 0) return null;
  return (
    <div className="shared-composer-sources" aria-label="已添加的资产和附件">
      {references.map((reference) => (
        <span className="shared-composer-source is-reference" key={`reference:${reference.id}`}>
          <SourcePreview source={reference} />
          <span className="shared-composer-source__copy">
            <strong>@{reference.name}</strong>
            <small>{kindLabel(reference.kind)}资产</small>
          </span>
          <button type="button" onClick={() => onRemoveReference(reference.id)} aria-label={`移除资产引用 ${reference.name}`}>×</button>
        </span>
      ))}
      {attachments.map((attachment) => (
        <span className="shared-composer-source" key={`attachment:${attachment.id}`}>
          <SourcePreview source={attachment} />
          <span className="shared-composer-source__copy">
            <strong>{attachment.name}</strong>
            <small>{kindLabel(attachment.kind)} · {formatBytes(attachment.bytes)}</small>
          </span>
          <button type="button" onClick={() => onRemoveAttachment(attachment.id)} aria-label={`移除附件 ${attachment.name}`}>×</button>
        </span>
      ))}
    </div>
  );
}

function SourcePreview({ source }: { source: ComposerAssetReference | ComposerAttachment }) {
  const previewUrl = "file" in source ? source.previewUrl : source.thumbnailUrl;
  if (source.kind === "image" && previewUrl) {
    return <img className="shared-composer-source__preview" src={previewUrl} alt="" />;
  }
  return (
    <span className={`shared-composer-source__preview is-${source.kind}`} aria-hidden="true">
      {source.kind === "image" ? <Icon name="image" /> : source.kind === "video" ? <Icon name="film" /> : <Icon name="file-text" />}
    </span>
  );
}

function kindLabel(kind: ComposerAssetReference["kind"]) {
  return kind === "image" ? "图片" : kind === "video" ? "视频" : "文本";
}

function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
