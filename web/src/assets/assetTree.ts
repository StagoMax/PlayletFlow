import type { AssetSection } from "../productApi/generated";

export type AssetSectionNode = AssetSection & { children: AssetSectionNode[] };

export function buildAssetSectionTree(sections: AssetSection[]): AssetSectionNode[] {
  const nodes = new Map<string, AssetSectionNode>(
    sections.map((section) => [section.id, { ...section, children: [] }]),
  );
  const roots: AssetSectionNode[] = [];
  for (const section of sections) {
    const node = nodes.get(section.id)!;
    const parent = section.parentId ? nodes.get(section.parentId) : undefined;
    if (parent && parent.parentId === null) parent.children.push(node);
    else roots.push(node);
  }
  const byPosition = (left: AssetSectionNode, right: AssetSectionNode) =>
    left.position.localeCompare(right.position) || left.name.localeCompare(right.name, "zh-CN");
  roots.sort(byPosition);
  for (const root of roots) root.children.sort(byPosition);
  return roots;
}
