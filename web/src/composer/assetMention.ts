import type { ComposerAssetReference } from "./types";

export type AssetMentionQuery = {
  start: number;
  end: number;
  query: string;
};

export function findAssetMentionQuery(value: string, caret: number): AssetMentionQuery | null {
  const beforeCaret = value.slice(0, caret);
  const match = beforeCaret.match(/(?:^|\s)@([^\s@]*)$/u);
  if (!match || match.index === undefined) return null;
  const atOffset = match[0].lastIndexOf("@");
  const start = match.index + atOffset;
  return { start, end: caret, query: match[1] };
}

export function replaceAssetMention(
  value: string,
  mention: AssetMentionQuery,
  asset: ComposerAssetReference,
) {
  const insertion = `@${asset.name} `;
  return {
    value: `${value.slice(0, mention.start)}${insertion}${value.slice(mention.end)}`,
    caret: mention.start + insertion.length,
  };
}

export function filterMentionAssets(
  assets: readonly ComposerAssetReference[],
  query: string,
) {
  const normalized = query.trim().toLocaleLowerCase();
  if (!normalized) return [...assets];
  return assets.filter((asset) => {
    const searchableText = asset.kind === "text"
      ? `${asset.name} ${asset.textPreview ?? ""}`
      : asset.name;
    return searchableText
      .toLocaleLowerCase()
      .includes(normalized);
  });
}

export function referenceMarker(asset: Pick<ComposerAssetReference, "name">) {
  return `@${asset.name}`;
}
