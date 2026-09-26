import { useCallback, useId, useMemo, useState, type KeyboardEvent, type RefObject } from "react";
import { AssetMentionMenu } from "./AssetMentionMenu";
import {
  filterMentionAssets,
  findAssetMentionQuery,
  replaceAssetMention,
  type AssetMentionQuery,
} from "./assetMention";
import type { ComposerAssetKind, ComposerAssetReference } from "./types";

type UseAssetMentionOptions = {
  value: string;
  assets: readonly ComposerAssetReference[];
  textareaRef: RefObject<HTMLTextAreaElement | null>;
  onChange: (value: string) => void;
  onReference: (asset: ComposerAssetReference) => void;
};

export function useAssetMention({ value, assets, textareaRef, onChange, onReference }: UseAssetMentionOptions) {
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
    const nextMention = findAssetMentionQuery(nextValue, caret);
    setMention(nextMention);
    setKind("all");
    setActiveIndex(0);
  }, []);

  const selectAsset = useCallback((asset: ComposerAssetReference) => {
    if (!mention) return;
    const next = replaceAssetMention(value, mention, asset);
    onChange(next.value);
    onReference(asset);
    setMention(null);
    requestAnimationFrame(() => {
      textareaRef.current?.focus();
      textareaRef.current?.setSelectionRange(next.caret, next.caret);
    });
  }, [mention, onChange, onReference, textareaRef, value]);

  const onKeyDown = useCallback((event: KeyboardEvent<HTMLTextAreaElement>) => {
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

  const openAtCaret = useCallback(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    const start = textarea.selectionStart;
    const end = textarea.selectionEnd;
    const prefix = start === 0 || /\s/u.test(value[start - 1] ?? "") ? "@" : " @";
    const nextValue = `${value.slice(0, start)}${prefix}${value.slice(end)}`;
    const caret = start + prefix.length;
    onChange(nextValue);
    setMention({ start: caret - 1, end: caret, query: "" });
    setKind("all");
    setActiveIndex(0);
    requestAnimationFrame(() => {
      textarea.focus();
      textarea.setSelectionRange(caret, caret);
    });
  }, [onChange, textareaRef, value]);

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
        textareaRef={textareaRef}
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
