import { useLayoutEffect, useMemo, useRef, useState, type RefObject } from "react";
import { createPortal } from "react-dom";
import { formatDuration } from "../preview/formatMedia";
import { Icon } from "../workspace/Icons";
import type { AssetMentionQuery } from "./assetMention";
import type { ComposerAssetKind, ComposerAssetReference } from "./types";
import "./composer.css";

type MentionMenuProps = {
  id: string;
  textareaRef: RefObject<HTMLTextAreaElement | null>;
  mention: AssetMentionQuery;
  assets: readonly ComposerAssetReference[];
  kind: "all" | ComposerAssetKind;
  activeIndex: number;
  onKindChange: (kind: "all" | ComposerAssetKind) => void;
  onActiveIndexChange: (index: number) => void;
  onSelect: (asset: ComposerAssetReference) => void;
};

type Anchor = { left: number; top: number; bottom: number };
type MenuLayout = {
  main: { left: number; top: number };
  preview: { left: number; top: number } | null;
};

const VIEWPORT_GUTTER = 12;
const PANEL_GAP = 8;
const kindOptions: Array<{ kind: ComposerAssetKind; label: string }> = [
  { kind: "image", label: "图片" },
  { kind: "video", label: "视频" },
  { kind: "text", label: "文本" },
];

export function AssetMentionMenu({
  id,
  textareaRef,
  mention,
  assets,
  kind,
  activeIndex,
  onKindChange,
  onActiveIndexChange,
  onSelect,
}: MentionMenuProps) {
  const mainRef = useRef<HTMLDivElement | null>(null);
  const previewRef = useRef<HTMLDivElement | null>(null);
  const previewCloseTimerRef = useRef<number | null>(null);
  const [anchor, setAnchor] = useState<Anchor | null>(null);
  const [layout, setLayout] = useState<MenuLayout | null>(null);
  const rootAssets = useMemo(
    () => mention.query ? [...assets] : assets.slice(0, 1),
    [assets, mention.query],
  );
  const previewAssets = useMemo(
    () => kind === "all" ? [] : assets.filter((asset) => asset.kind === kind),
    [assets, kind],
  );
  const showCategories = !mention.query;
  const showPreview = showCategories && kind !== "all";
  const activeAssets = showPreview ? previewAssets : rootAssets;

  const cancelPreviewClose = () => {
    if (previewCloseTimerRef.current === null) return;
    window.clearTimeout(previewCloseTimerRef.current);
    previewCloseTimerRef.current = null;
  };

  const openPreview = (nextKind: ComposerAssetKind) => {
    cancelPreviewClose();
    if (kind === nextKind) return;
    onKindChange(nextKind);
    onActiveIndexChange(0);
  };

  const schedulePreviewClose = (pointerType: string) => {
    if (pointerType === "touch" || kind === "all") return;
    cancelPreviewClose();
    previewCloseTimerRef.current = window.setTimeout(() => {
      previewCloseTimerRef.current = null;
      onKindChange("all");
      onActiveIndexChange(0);
    }, 160);
  };

  useLayoutEffect(() => () => cancelPreviewClose(), []);

  useLayoutEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    const update = () => setAnchor(textareaCaretAnchor(textarea, mention.end));
    update();
    textarea.addEventListener("scroll", update);
    window.addEventListener("resize", update);
    window.addEventListener("scroll", update, true);
    return () => {
      textarea.removeEventListener("scroll", update);
      window.removeEventListener("resize", update);
      window.removeEventListener("scroll", update, true);
    };
  }, [mention.end, textareaRef]);

  useLayoutEffect(() => {
    const main = mainRef.current;
    if (!anchor || !main) return;

    const update = () => {
      const next = placePanels(anchor, main, showPreview ? previewRef.current : null, kind);
      setLayout((current) => sameLayout(current, next) ? current : next);
    };
    update();

    const observer = new ResizeObserver(update);
    observer.observe(main);
    if (previewRef.current) observer.observe(previewRef.current);
    return () => observer.disconnect();
  }, [anchor, kind, previewAssets.length, rootAssets.length, showPreview]);

  useLayoutEffect(() => {
    if (activeIndex < activeAssets.length) return;
    onActiveIndexChange(Math.max(0, activeAssets.length - 1));
  }, [activeAssets.length, activeIndex, onActiveIndexChange]);

  if (!anchor) return null;
  const hiddenPosition = { left: 0, top: 0, visibility: "hidden" as const };

  return createPortal(
    <div className="asset-mention-layer" aria-label="引用资产">
      <div
        ref={mainRef}
        className="asset-mention-popover"
        role="dialog"
        aria-label="选择引用资产"
        style={layout ? layout.main : hiddenPosition}
        onMouseDown={(event) => event.preventDefault()}
        onPointerEnter={cancelPreviewClose}
        onPointerLeave={(event) => schedulePreviewClose(event.pointerType)}
      >
        <header>
          <span>{mention.query ? `搜索“${mention.query}”` : "可能 @ 的内容"}</span>
          <kbd>↑↓ · Enter</kbd>
        </header>
        <AssetList
          id={!showPreview ? id : undefined}
          assets={rootAssets}
          activeIndex={!showPreview ? activeIndex : null}
          emptyLabel="没有匹配的资产"
          onActiveIndexChange={onActiveIndexChange}
          onSelect={onSelect}
        />
        {showCategories ? (
          <div className="asset-mention-categories" role="group" aria-label="添加参考">
            <span className="asset-mention-section-label">添加参考</span>
            {kindOptions.map((option) => {
              const count = assets.filter((asset) => asset.kind === option.kind).length;
              const selected = kind === option.kind;
              return (
                <button
                  key={option.kind}
                  type="button"
                  className={selected ? "is-active" : ""}
                  aria-pressed={selected}
                  aria-expanded={selected}
                  aria-controls={selected ? `${id}-preview` : undefined}
                  disabled={count === 0}
                  data-asset-kind={option.kind}
                  onPointerEnter={(event) => {
                    if (event.pointerType !== "touch") openPreview(option.kind);
                  }}
                  onFocus={() => openPreview(option.kind)}
                  onClick={() => openPreview(option.kind)}
                >
                  <span className={`asset-mention-category-icon is-${option.kind}`} aria-hidden="true">
                    {option.kind === "image" ? <Icon name="image" /> : option.kind === "video" ? <Icon name="film" /> : <Icon name="file-text" />}
                  </span>
                  <span>{option.label}</span>
                  <small>{count}</small>
                  <Icon name="chevron-right" />
                </button>
              );
            })}
          </div>
        ) : null}
      </div>

      {showPreview ? (
        <div
          id={`${id}-preview`}
          ref={previewRef}
          className="asset-mention-sidecar"
          style={layout?.preview ?? hiddenPosition}
          onMouseDown={(event) => event.preventDefault()}
          onPointerEnter={cancelPreviewClose}
          onPointerLeave={(event) => schedulePreviewClose(event.pointerType)}
        >
          <header>
            <span>{kindLabel(kind)}</span>
            <small>{previewAssets.length}</small>
          </header>
          <AssetList
            id={id}
            assets={previewAssets}
            activeIndex={activeIndex}
            emptyLabel="当前分类没有资产"
            onActiveIndexChange={onActiveIndexChange}
            onSelect={onSelect}
          />
        </div>
      ) : null}
    </div>,
    document.body,
  );
}

type AssetListProps = {
  id?: string;
  assets: readonly ComposerAssetReference[];
  activeIndex: number | null;
  emptyLabel: string;
  onActiveIndexChange: (index: number) => void;
  onSelect: (asset: ComposerAssetReference) => void;
};

function AssetList({
  id,
  assets,
  activeIndex,
  emptyLabel,
  onActiveIndexChange,
  onSelect,
}: AssetListProps) {
  const isActiveList = activeIndex !== null;
  return (
    <div id={id} className="asset-mention-list" role={isActiveList ? "listbox" : undefined} aria-label={isActiveList ? "可引用资产" : undefined}>
      {assets.map((asset, index) => (
        <button
          key={asset.id}
          type="button"
          role={isActiveList ? "option" : undefined}
          aria-selected={isActiveList ? index === activeIndex : undefined}
          className={isActiveList && index === activeIndex ? "is-active" : ""}
          onMouseEnter={() => { if (isActiveList) onActiveIndexChange(index); }}
          onClick={() => onSelect(asset)}
        >
          <AssetPreview asset={asset} />
          <span className="asset-mention-copy">
            <strong>{asset.name}</strong>
          </span>
        </button>
      ))}
      {assets.length === 0 ? <p>{emptyLabel}</p> : null}
    </div>
  );
}

function AssetPreview({ asset }: { asset: ComposerAssetReference }) {
  if (asset.thumbnailUrl) {
    return (
      <span className={`asset-mention-preview is-${asset.kind}`}>
        <img src={asset.thumbnailUrl} alt="" />
        {asset.kind === "video" ? <span className="asset-mention-play"><Icon name="play" /></span> : null}
        {asset.kind === "video" && asset.durationMs ? <em>{formatDuration(asset.durationMs)}</em> : null}
      </span>
    );
  }
  return (
    <span className={`asset-mention-preview is-${asset.kind}`} aria-hidden="true">
      {asset.kind === "image" ? <Icon name="image" /> : asset.kind === "video" ? <Icon name="film" /> : <Icon name="file-text" />}
    </span>
  );
}

function placePanels(
  anchor: Anchor,
  main: HTMLDivElement,
  preview: HTMLDivElement | null,
  kind: "all" | ComposerAssetKind,
): MenuLayout {
  const viewportWidth = window.innerWidth;
  const viewportHeight = window.innerHeight;
  const mainRect = main.getBoundingClientRect();
  const aboveTop = anchor.top - mainRect.height - PANEL_GAP;
  const belowTop = anchor.bottom + PANEL_GAP;
  const preferredMainTop = aboveTop >= VIEWPORT_GUTTER
    ? aboveTop
    : belowTop + mainRect.height <= viewportHeight - VIEWPORT_GUTTER
      ? belowTop
      : aboveTop;
  const mainTop = clamp(preferredMainTop, VIEWPORT_GUTTER, viewportHeight - mainRect.height - VIEWPORT_GUTTER);
  const mainLeft = clamp(anchor.left, VIEWPORT_GUTTER, viewportWidth - mainRect.width - VIEWPORT_GUTTER);

  if (!preview || kind === "all") return { main: { left: mainLeft, top: mainTop }, preview: null };

  const previewRect = preview.getBoundingClientRect();
  const leftCandidate = mainLeft - previewRect.width - PANEL_GAP;
  const rightCandidate = mainLeft + mainRect.width + PANEL_GAP;
  const fitsLeft = leftCandidate >= VIEWPORT_GUTTER;
  const fitsRight = rightCandidate + previewRect.width <= viewportWidth - VIEWPORT_GUTTER;
  const category = main.querySelector<HTMLElement>(`[data-asset-kind="${kind}"]`);
  const categoryOffset = category ? category.getBoundingClientRect().top - mainRect.top : 0;

  if (fitsLeft || fitsRight) {
    return {
      main: { left: mainLeft, top: mainTop },
      preview: {
        left: fitsLeft ? leftCandidate : rightCandidate,
        top: clamp(mainTop + categoryOffset, VIEWPORT_GUTTER, viewportHeight - previewRect.height - VIEWPORT_GUTTER),
      },
    };
  }

  const stackedAbove = mainTop - previewRect.height - PANEL_GAP;
  const stackedBelow = mainTop + mainRect.height + PANEL_GAP;
  const previewTop = stackedAbove >= VIEWPORT_GUTTER
    ? stackedAbove
    : stackedBelow + previewRect.height <= viewportHeight - VIEWPORT_GUTTER
      ? stackedBelow
      : clamp(anchor.top - previewRect.height - PANEL_GAP, VIEWPORT_GUTTER, viewportHeight - previewRect.height - VIEWPORT_GUTTER);
  return {
    main: { left: mainLeft, top: mainTop },
    preview: {
      left: clamp(anchor.left, VIEWPORT_GUTTER, viewportWidth - previewRect.width - VIEWPORT_GUTTER),
      top: previewTop,
    },
  };
}

function sameLayout(current: MenuLayout | null, next: MenuLayout) {
  return current?.main.left === next.main.left
    && current.main.top === next.main.top
    && current.preview?.left === next.preview?.left
    && current.preview?.top === next.preview?.top;
}

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), Math.max(min, max));
}

function kindLabel(kind: ComposerAssetKind) {
  return kind === "image" ? "图片" : kind === "video" ? "视频" : "文本";
}

function textareaCaretAnchor(textarea: HTMLTextAreaElement, caret: number): Anchor {
  const style = getComputedStyle(textarea);
  const rect = textarea.getBoundingClientRect();
  const mirror = document.createElement("div");
  const properties = [
    "fontFamily", "fontSize", "fontWeight", "fontStyle", "letterSpacing", "lineHeight",
    "paddingTop", "paddingRight", "paddingBottom", "paddingLeft",
    "borderTopWidth", "borderRightWidth", "borderBottomWidth", "borderLeftWidth",
    "boxSizing", "wordSpacing", "textIndent", "textTransform", "tabSize",
  ] as const;
  mirror.style.position = "fixed";
  mirror.style.left = `${rect.left}px`;
  mirror.style.top = `${rect.top}px`;
  mirror.style.width = `${rect.width}px`;
  mirror.style.height = `${rect.height}px`;
  mirror.style.visibility = "hidden";
  mirror.style.whiteSpace = "pre-wrap";
  mirror.style.overflowWrap = "break-word";
  mirror.style.overflow = "hidden";
  for (const property of properties) mirror.style[property] = style[property];
  mirror.textContent = textarea.value.slice(0, caret);
  const marker = document.createElement("span");
  marker.textContent = textarea.value.slice(caret) || "\u200b";
  mirror.append(marker);
  document.body.append(mirror);
  mirror.scrollTop = textarea.scrollTop;
  mirror.scrollLeft = textarea.scrollLeft;
  const markerRect = marker.getBoundingClientRect();
  mirror.remove();
  const lineHeight = Number.parseFloat(style.lineHeight) || 18;
  return {
    left: markerRect.left,
    top: markerRect.top,
    bottom: markerRect.top + Math.max(markerRect.height, lineHeight),
  };
}
