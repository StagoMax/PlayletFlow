import { useMemo, useState } from "react";
import type { AssetBinding, AssetSection } from "../productApi/generated";
import { buildAssetSectionTree, type AssetSectionNode } from "./assetTree";
import { AssetBindingCard } from "./AssetBindingCard";
import type { AssetPreviewRenderer } from "./assetPreview";
import { assetKindLabel } from "./assetWorkspaceClient";
import "./assets.css";

type AssetSectionTreeProps = {
  sections: AssetSection[];
  bindings: AssetBinding[];
  selectedBindingId?: string | null;
  pendingByBindingId?: Readonly<Record<string, number>>;
  onSelectBinding?: (binding: AssetBinding) => void;
  onAddAsset?: (section: AssetSection) => void;
  onCreateSection?: (parent: AssetSection | null) => void;
  renderPreview?: AssetPreviewRenderer;
};

export function AssetSectionTree(props: AssetSectionTreeProps) {
  const tree = useMemo(() => buildAssetSectionTree(props.sections), [props.sections]);
  const bySection = useMemo(() => {
    const result = new Map<string, AssetBinding[]>();
    for (const binding of props.bindings) {
      const items = result.get(binding.sectionId) ?? [];
      items.push(binding);
      result.set(binding.sectionId, items);
    }
    return result;
  }, [props.bindings]);

  if (tree.length === 0) {
    return (
      <div className="asset-empty" role="status">
        <strong>还没有资产分区</strong>
        <p>先创建角色、场景或道具分区，再从共享资产库添加引用。</p>
        <button type="button" onClick={() => props.onCreateSection?.(null)}>创建分区</button>
      </div>
    );
  }

  return (
    <div className="asset-section-tree" aria-label="资产分区">
      {tree.map((node) => (
        <SectionBranch key={node.id} node={node} bySection={bySection} {...props} />
      ))}
      <button className="asset-section-tree__new" type="button" onClick={() => props.onCreateSection?.(null)}>
        ＋ 新建资产分区
      </button>
    </div>
  );
}

function SectionBranch({
  node,
  bySection,
  ...props
}: AssetSectionTreeProps & { node: AssetSectionNode; bySection: Map<string, AssetBinding[]> }) {
  const [expanded, setExpanded] = useState(true);
  const bindings = bySection.get(node.id) ?? [];
  const contentId = `asset-section-${node.id}`;
  return (
    <section className={`asset-section asset-section--${node.parentId ? "child" : "root"}`}>
      <header className="asset-section__header">
        <button
          type="button"
          className="asset-section__toggle"
          aria-expanded={expanded}
          aria-controls={contentId}
          onClick={() => setExpanded((value) => !value)}
        >
          <span aria-hidden="true">{expanded ? "▾" : "▸"}</span>
          <strong>{node.name}</strong>
          <small>{assetKindLabel(node.kind)} · {bindings.length}</small>
        </button>
        <button type="button" className="asset-section__add" onClick={() => props.onAddAsset?.(node)} aria-label={`向${node.name}添加资产`}>
          ＋
        </button>
      </header>
      {expanded ? (
        <div id={contentId} className="asset-section__content">
          {bindings.length > 0 ? bindings.map((binding) => (
            <AssetBindingCard
              key={binding.id}
              binding={binding}
              selected={binding.id === props.selectedBindingId}
              pendingCount={props.pendingByBindingId?.[binding.id] ?? 0}
              onSelect={props.onSelectBinding}
              renderPreview={props.renderPreview}
            />
          )) : <p className="asset-section__empty">此分区暂无资产引用</p>}
          {node.children.map((child) => (
            <SectionBranch key={child.id} node={child} bySection={bySection} {...props} />
          ))}
          {!node.parentId ? (
            <button className="asset-section__new-child" type="button" onClick={() => props.onCreateSection?.(node)}>
              ＋ 新建子分区
            </button>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
