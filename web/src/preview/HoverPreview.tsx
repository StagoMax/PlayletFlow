import { createPortal } from "react-dom";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type FocusEvent,
  type PointerEvent,
  type ReactNode,
} from "react";
import { Icon } from "../workspace/Icons";
import { isAccessExpired } from "./formatMedia";
import type { HoverPreviewItem, HoverPreviewMedia } from "./types";
import { useReducedMotion } from "./useReducedMotion";
import "./preview.css";

const OPEN_DELAY_MS = 300;
const CLOSE_DELAY_MS = 120;
const PANEL_GAP = 12;
const VIEWPORT_GUTTER = 16;
const MAX_PANEL_WIDTH = 267;
const DEFAULT_ASPECT_RATIO = 16 / 10;

type HoverPreviewProps = {
  item: HoverPreviewItem;
  children: ReactNode;
  disabled?: boolean;
  placement?: "side" | "top";
  openDelayMs?: number;
  className?: string;
  panelClassName?: string;
};

type PanelPosition = {
  top: number;
  left: number;
  width: number;
  height: number;
  placement: "left" | "right" | "top" | "bottom";
};

export function hoverPreviewSize(media: HoverPreviewMedia, viewportWidth: number, viewportHeight: number) {
  const dimensions = [media.preview, media, media.thumbnail].find(
    (source) => Number.isFinite(source?.width) && Number.isFinite(source?.height)
      && (source?.width ?? 0) > 0 && (source?.height ?? 0) > 0,
  );
  const ratio = dimensions ? dimensions.width! / dimensions.height! : DEFAULT_ASPECT_RATIO;
  const availableWidth = Math.max(1, viewportWidth - VIEWPORT_GUTTER * 2);
  const availableHeight = Math.max(1, viewportHeight - VIEWPORT_GUTTER * 2);
  const width = Math.min(MAX_PANEL_WIDTH, availableWidth, availableHeight * ratio);
  return { width, height: width / ratio };
}

export function HoverPreview({
  item,
  children,
  disabled = false,
  placement: preferredPlacement = "side",
  openDelayMs = OPEN_DELAY_MS,
  className,
  panelClassName,
}: HoverPreviewProps) {
  const anchorRef = useRef<HTMLDivElement>(null);
  const openTimer = useRef<number | null>(null);
  const closeTimer = useRef<number | null>(null);
  const [open, setOpen] = useState(false);

  const clearTimers = useCallback(() => {
    if (openTimer.current !== null) window.clearTimeout(openTimer.current);
    if (closeTimer.current !== null) window.clearTimeout(closeTimer.current);
    openTimer.current = null;
    closeTimer.current = null;
  }, []);

  const showAfterDelay = useCallback(() => {
    clearTimers();
    openTimer.current = window.setTimeout(() => setOpen(true), openDelayMs);
  }, [clearTimers, openDelayMs]);

  const showImmediately = useCallback(() => {
    clearTimers();
    setOpen(true);
  }, [clearTimers]);

  const hideAfterDelay = useCallback(() => {
    clearTimers();
    closeTimer.current = window.setTimeout(() => setOpen(false), CLOSE_DELAY_MS);
  }, [clearTimers]);

  useEffect(() => {
    if (!open) return undefined;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [open]);

  useEffect(() => clearTimers, [clearTimers]);

  useEffect(() => {
    if (!disabled) return;
    clearTimers();
    setOpen(false);
  }, [clearTimers, disabled]);

  const onPointerEnter = (event: PointerEvent<HTMLDivElement>) => {
    if (disabled) return;
    if (event.pointerType === "touch") return;
    if (window.matchMedia?.("(hover: hover) and (pointer: fine)").matches === false) return;
    showAfterDelay();
  };

  const onFocus = () => { if (!disabled) showImmediately(); };
  const onBlur = (event: FocusEvent<HTMLDivElement>) => {
    if (event.currentTarget.contains(event.relatedTarget)) return;
    hideAfterDelay();
  };

  return (
    <div
      ref={anchorRef}
      className={`hover-preview-anchor${className ? ` ${className}` : ""}`}
      onPointerEnter={onPointerEnter}
      onPointerLeave={hideAfterDelay}
      onFocusCapture={onFocus}
      onBlurCapture={onBlur}
    >
      {children}
      {open && !disabled && anchorRef.current ? (
        <HoverPreviewPortal item={item} anchor={anchorRef.current} placement={preferredPlacement} className={panelClassName} />
      ) : null}
    </div>
  );
}

export function HoverPreviewPortal({
  item,
  anchor,
  placement: preferredPlacement = "side",
  className,
}: {
  item: HoverPreviewItem;
  anchor: HTMLElement;
  placement?: "side" | "top";
  className?: string;
}) {
  const [position, setPosition] = useState<PanelPosition>({
    top: VIEWPORT_GUTTER,
    left: VIEWPORT_GUTTER,
    width: 360,
    height: 225,
    placement: "right",
  });

  const updatePosition = useCallback(() => {
    const rect = anchor.getBoundingClientRect();
    const { width, height } = hoverPreviewSize(item.media, window.innerWidth, window.innerHeight);
    if (preferredPlacement === "top") {
      const preferredLeft = rect.left + rect.width / 2 - width / 2;
      const left = Math.min(
        window.innerWidth - width - VIEWPORT_GUTTER,
        Math.max(VIEWPORT_GUTTER, preferredLeft),
      );
      const aboveTop = rect.top - height - PANEL_GAP;
      const belowTop = rect.bottom + PANEL_GAP;
      const fitsAbove = aboveTop >= VIEWPORT_GUTTER;
      const fitsBelow = belowTop + height <= window.innerHeight - VIEWPORT_GUTTER;
      const top = fitsAbove
        ? aboveTop
        : fitsBelow
          ? belowTop
          : Math.min(
              Math.max(VIEWPORT_GUTTER, aboveTop),
              Math.max(VIEWPORT_GUTTER, window.innerHeight - height - VIEWPORT_GUTTER),
            );
      setPosition({ top, left, width, height, placement: fitsAbove || !fitsBelow ? "top" : "bottom" });
      return;
    }
    const rightLeft = rect.right + PANEL_GAP;
    const fitsRight = rightLeft + width <= window.innerWidth - VIEWPORT_GUTTER;
    const placement = fitsRight ? "right" : "left";
    const preferredLeft = fitsRight ? rightLeft : rect.left - width - PANEL_GAP;
    const left = Math.min(
      window.innerWidth - width - VIEWPORT_GUTTER,
      Math.max(VIEWPORT_GUTTER, preferredLeft),
    );
    const maxTop = Math.max(
      VIEWPORT_GUTTER,
      window.innerHeight - height - VIEWPORT_GUTTER,
    );
    const top = Math.min(
      maxTop,
      Math.max(VIEWPORT_GUTTER, rect.top + rect.height / 2 - height / 2),
    );
    setPosition({ top, left, width, height, placement });
  }, [anchor, item.media, preferredPlacement]);

  useLayoutEffect(() => {
    updatePosition();
    window.addEventListener("resize", updatePosition);
    window.addEventListener("scroll", updatePosition, true);
    return () => {
      window.removeEventListener("resize", updatePosition);
      window.removeEventListener("scroll", updatePosition, true);
    };
  }, [updatePosition]);

  return typeof document !== "undefined"
    ? createPortal(<HoverPreviewPanel item={item} position={position} className={className} />, document.body)
    : null;
}

function HoverPreviewPanel({ item, position, className }: { item: HoverPreviewItem; position: PanelPosition; className?: string }) {
  const reducedMotion = useReducedMotion();
  const { media } = item;
  const preview = media.preview && !isAccessExpired(media.preview) ? media.preview : null;
  const thumbnail = media.thumbnail && !isAccessExpired({ ...media.thumbnail, mimeType: media.mimeType })
    ? media.thumbnail
    : null;
  const imageSource = media.kind === "image"
    ? preview?.url || thumbnail?.url
    : preview?.mimeType.startsWith("image/") ? preview.url : thumbnail?.url;
  const videoSource = preview?.mimeType.startsWith("video/") ? preview.url : null;

  return (
    <aside
      className={`hover-preview-panel${className ? ` ${className}` : ""}`}
      data-placement={position.placement}
      style={{ top: position.top, left: position.left, width: position.width, height: position.height }}
      role="tooltip"
      aria-label={`${item.name}大预览`}
    >
      <div className="hover-preview-media">
        {media.status === "ready" && videoSource ? (
          <video
            src={videoSource}
            poster={thumbnail?.url}
            autoPlay={!reducedMotion}
            muted
            loop
            playsInline
            preload="metadata"
          />
        ) : media.status === "ready" && imageSource ? (
          <img src={imageSource} alt="" decoding="async" />
        ) : (
          <div className="hover-preview-fallback">
            {media.kind === "video" ? <Icon name="play" /> : <Icon name="image" />}
            <span>{media.status === "processing" ? "正在生成预览" : "暂无可用预览"}</span>
          </div>
        )}
      </div>
    </aside>
  );
}
