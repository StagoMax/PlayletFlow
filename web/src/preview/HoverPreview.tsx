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
import { formatAspectRatio, formatDuration, isAccessExpired } from "./formatMedia";
import type { PreviewItem } from "./types";
import { useReducedMotion } from "./useReducedMotion";
import "./preview.css";

const OPEN_DELAY_MS = 300;
const CLOSE_DELAY_MS = 120;
const PANEL_GAP = 12;
const VIEWPORT_GUTTER = 16;

type HoverPreviewProps = {
  item: PreviewItem;
  children: ReactNode;
};

type PanelPosition = {
  top: number;
  left: number;
  width: number;
  placement: "left" | "right";
};

export function HoverPreview({ item, children }: HoverPreviewProps) {
  const anchorRef = useRef<HTMLDivElement>(null);
  const openTimer = useRef<number | null>(null);
  const closeTimer = useRef<number | null>(null);
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<PanelPosition>({
    top: VIEWPORT_GUTTER,
    left: VIEWPORT_GUTTER,
    width: 360,
    placement: "right",
  });

  const clearTimers = useCallback(() => {
    if (openTimer.current !== null) window.clearTimeout(openTimer.current);
    if (closeTimer.current !== null) window.clearTimeout(closeTimer.current);
    openTimer.current = null;
    closeTimer.current = null;
  }, []);

  const showAfterDelay = useCallback(() => {
    clearTimers();
    openTimer.current = window.setTimeout(() => setOpen(true), OPEN_DELAY_MS);
  }, [clearTimers]);

  const showImmediately = useCallback(() => {
    clearTimers();
    setOpen(true);
  }, [clearTimers]);

  const hideAfterDelay = useCallback(() => {
    clearTimers();
    closeTimer.current = window.setTimeout(() => setOpen(false), CLOSE_DELAY_MS);
  }, [clearTimers]);

  const updatePosition = useCallback(() => {
    const anchor = anchorRef.current;
    if (!anchor) return;
    const rect = anchor.getBoundingClientRect();
    const width = Math.min(400, Math.max(260, window.innerWidth - VIEWPORT_GUTTER * 2));
    const estimatedHeight = Math.min(330, Math.max(220, width * 0.72));
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
      window.innerHeight - estimatedHeight - VIEWPORT_GUTTER,
    );
    const top = Math.min(
      maxTop,
      Math.max(VIEWPORT_GUTTER, rect.top + rect.height / 2 - estimatedHeight / 2),
    );
    setPosition({ top, left, width, placement });
  }, []);

  useLayoutEffect(() => {
    if (!open) return undefined;
    updatePosition();
    window.addEventListener("resize", updatePosition);
    window.addEventListener("scroll", updatePosition, true);
    return () => {
      window.removeEventListener("resize", updatePosition);
      window.removeEventListener("scroll", updatePosition, true);
    };
  }, [open, updatePosition]);

  useEffect(() => {
    if (!open) return undefined;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [open]);

  useEffect(() => clearTimers, [clearTimers]);

  const onPointerEnter = (event: PointerEvent<HTMLDivElement>) => {
    if (event.pointerType === "touch") return;
    if (window.matchMedia?.("(hover: hover) and (pointer: fine)").matches === false) return;
    showAfterDelay();
  };

  const onFocus = () => showImmediately();
  const onBlur = (event: FocusEvent<HTMLDivElement>) => {
    if (event.currentTarget.contains(event.relatedTarget)) return;
    hideAfterDelay();
  };

  return (
    <div
      ref={anchorRef}
      className="hover-preview-anchor"
      onPointerEnter={onPointerEnter}
      onPointerLeave={hideAfterDelay}
      onFocusCapture={onFocus}
      onBlurCapture={onBlur}
    >
      {children}
      {open && typeof document !== "undefined"
        ? createPortal(
            <HoverPreviewPanel item={item} position={position} />,
            document.body,
          )
        : null}
    </div>
  );
}

function HoverPreviewPanel({ item, position }: { item: PreviewItem; position: PanelPosition }) {
  const reducedMotion = useReducedMotion();
  const { media } = item;
  const preview = media.preview && !isAccessExpired(media.preview) ? media.preview : null;
  const thumbnail = media.thumbnail && !isAccessExpired({ ...media.thumbnail, mimeType: media.mimeType })
    ? media.thumbnail
    : null;
  const imageSource = preview?.mimeType.startsWith("image/") ? preview.url : thumbnail?.url;
  const videoSource = preview?.mimeType.startsWith("video/") ? preview.url : null;

  return (
    <aside
      className="hover-preview-panel"
      data-placement={position.placement}
      style={{ top: position.top, left: position.left, width: position.width }}
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
      <div className="hover-preview-caption">
        <div><strong>{item.name}</strong><span>{item.label}</span></div>
        <small>{formatAspectRatio(media)}{formatDuration(media.durationMs) ? ` · ${formatDuration(media.durationMs)}` : ""}</small>
      </div>
    </aside>
  );
}
