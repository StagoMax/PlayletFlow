import { useCallback, useId, useMemo, useState, type KeyboardEvent, type RefObject } from "react";
import { AssetMentionMenu } from "./AssetMentionMenu";
import {
  filterMentionAssets,
  findAssetMentionQuery,
  replaceAssetMention,
  type AssetMentionQuery,
} from "./assetMention";
import { editorSelection, focusEditorAt } from "./contentEditableSelection";
import { inlineReferenceSegments } from "./inlineReferences";
import type { ComposerAssetKind, ComposerAssetReference } from "./types";

type UseAssetMentionOptions = {
  value: string;
  assets: readonly ComposerAssetReference[];
  references: readonly ComposerAssetReference[];
  editorRef: RefObject<HTMLDivElement | null>;
  onChange: (value: string) => void;
  onReference: (asset: ComposerAssetReference) => void;
};

export function useAssetMention({ value, assets, references, editorRef, onChange, onReference }: UseAssetMentionOptions) {
  const listboxId = useId();
  const [mention, setMention] = useState<AssetMentionQuery | null>(null);
  const [kind, setKind] = useState<"all" | ComposerAssetKind>("all");
  const [activeIndex, setActiveIndex] = useState(0);
  const queryAssets = useMemo(
    () => mention ? filterMentionAssets(assets, mention.query) : [],
    [assets, mention],
  );
  const visibleAssets = useMemo(
    () => {
      const filtered = kind === "all" ? queryAssets : queryAssets.filter((asset) => asset.kind === kind);
      return kind === "all" && !mention?.query ? filtered.slice(0, 1) : filtered;
    },
    [kind, mention?.query, queryAssets],
  );

  const close = useCallback(() => setMention(null), []);

  const onTextChange = useCallback((nextValue: string, caret: number) => {
    const atomicRanges = inlineReferenceSegments(nextValue, references)
      .filter((segment) => segment.type === "reference")
      .map((segment) => ({ start: segment.start, end: segment.end }));
    const nextMention = findAssetMentionQuery(nextValue, caret, atomicRanges);
    setMention(nextMention);
    setKind("all");
    setActiveIndex(0);
  }, [references]);

  const selectAsset = useCallback((asset: ComposerAssetReference) => {
    if (!mention) return;
    const next = replaceAssetMention(value, mention, asset);
    onChange(next.value);
    onReference(asset);
    setMention(null);
    requestAnimationFrame(() => {
      if (editorRef.current) focusEditorAt(editorRef.current, next.caret);
    });
  }, [editorRef, mention, onChange, onReference, value]);

  const onKeyDown = useCallback((event: KeyboardEvent<HTMLDivElement>) => {
    if (!mention) return false;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const direction = event.key === "ArrowDown" ? 1 : -1;
      setActiveIndex((current) => (current + direction + visibleAssets.length) % Math.max(visibleAssets.length, 1));
      return true;
    }
    if (event.key === "Enter" && visibleAssets[activeIndex]) {
      event.preventDefault();
      selectAsset(visibleAssets[activeIndex]);
      return true;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      setMention(null);
      return true;
    }
    return false;
  }, [activeIndex, mention, selectAsset, visibleAssets]);

  const openAtCaret = useCallback((initialKind: "all" | ComposerAssetKind = "all") => {
    const editor = editorRef.current;
    if (!editor) return;
    const { start, end } = editorSelection(editor);
    const nextValue = `${value.slice(0, start)}@${value.slice(end)}`;
    const caret = start + 1;
    onChange(nextValue);
    setMention({ start: caret - 1, end: caret, query: "" });
    setKind(initialKind);
    setActiveIndex(0);
    requestAnimationFrame(() => {
      if (editorRef.current) focusEditorAt(editorRef.current, caret);
    });
  }, [editorRef, onChange, value]);

  return {
    isOpen: mention !== null,
    listboxId,
    close,
    onTextChange,
    onKeyDown,
    openAtCaret,
    menu: mention ? (
      <AssetMentionMenu
        id={listboxId}
        editorRef={editorRef}
        mention={mention}
        assets={queryAssets}
        kind={kind}
        activeIndex={activeIndex}
        onKindChange={setKind}
        onActiveIndexChange={setActiveIndex}
        onSelect={selectAsset}
      />
    ) : null,
  };
}
