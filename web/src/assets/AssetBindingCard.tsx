import type { AssetBinding } from "../productApi/generated";
import { assetKindLabel, primaryRepresentation } from "./assetWorkspaceClient";
import type { AssetPreviewRenderer } from "./assetPreview";
import "./assets.css";

type AssetBindingCardProps = {
  binding: AssetBinding;
  selected?: boolean;
  checked?: boolean;
  pendingCount?: number;
  onSelect?: (binding: AssetBinding) => void;
  onCheckedChange?: (bindingId: string, checked: boolean) => void;
  renderPreview?: AssetPreviewRenderer;
};

export function AssetBindingCard({
  binding,
  selected = false,
  checked,
  pendingCount = 0,
  onSelect,
  onCheckedChange,
  renderPreview,
}: AssetBindingCardProps) {
  const representation = primaryRepresentation(binding.asset);
  const preview = representation?.mediaId && renderPreview
    ? renderPreview(binding.asset, representation.mediaId)
    : representation ? representation.label.slice(0, 2) : assetKindLabel(binding.asset.type).slice(0, 1);
  const stateClass = pendingCount > 0 ? " asset-binding-card--pending" : "";
  return (
    <div className={`asset-binding-card${selected ? " is-selected" : ""}${stateClass}`}>
      {checked !== undefined ? (
        <label className="asset-binding-card__check">
          <input
            type="checkbox"
            checked={checked}
            onChange={(event) => onCheckedChange?.(binding.id, event.target.checked)}
          />
          <span className="sr-only">选择 {binding.asset.name}</span>
        </label>
      ) : null}
      <button
        type="button"
        className="asset-binding-card__body"
        aria-pressed={checked ?? selected}
        onClick={() => {
          if (onSelect) onSelect(binding);
          else if (checked !== undefined) onCheckedChange?.(binding.id, !checked);
        }}
      >
        <span className="asset-binding-card__preview" aria-hidden="true">
          {preview}
        </span>
        <span className="asset-binding-card__copy">
          <strong>{binding.asset.name}</strong>
          <small>{representation?.label ?? assetKindLabel(binding.asset.type)}</small>
        </span>
        {pendingCount > 0 ? <span className="asset-pending-badge">待确认 {pendingCount}</span> : null}
      </button>
    </div>
  );
}
