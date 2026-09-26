import { useRef, useState } from "react";
import { FitScreenIcon, ZoomInIcon, ZoomOutIcon } from "./PreviewIcons";
import type { KeyboardEvent, PointerEvent, WheelEvent } from "react";

const MIN_ZOOM = 0.25;
const MAX_ZOOM = 4;
const ZOOM_STEP = 0.25;

type Position = { x: number; y: number };
type DragState = Position & { pointerId: number; startX: number; startY: number };

function isToolbarTarget(target: EventTarget | null) {
  return target instanceof Element && target.closest(".media-viewer-toolbar") !== null;
}

export function ImagePreviewSurface({ src, name, onError }: { src: string; name: string; onError: () => void }) {
  const [zoom, setZoom] = useState(1);
  const [position, setPosition] = useState<Position>({ x: 0, y: 0 });
  const drag = useRef<DragState | null>(null);

  const applyZoom = (nextZoom: number) => {
    const clamped = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, nextZoom));
    setZoom(clamped);
    if (clamped <= 1) setPosition({ x: 0, y: 0 });
  };

  const resetView = () => {
    setZoom(1);
    setPosition({ x: 0, y: 0 });
  };

  const onWheel = (event: WheelEvent<HTMLDivElement>) => {
    event.preventDefault();
    applyZoom(zoom + (event.deltaY < 0 ? ZOOM_STEP : -ZOOM_STEP));
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "+" || event.key === "=") applyZoom(zoom + ZOOM_STEP);
    else if (event.key === "-") applyZoom(zoom - ZOOM_STEP);
    else if (event.key === "0") resetView();
    else return;
    event.preventDefault();
  };

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (zoom <= 1 || event.button !== 0 || isToolbarTarget(event.target)) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = { pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, ...position };
  };

  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const active = drag.current;
    if (!active || active.pointerId !== event.pointerId) return;
    setPosition({ x: active.x + event.clientX - active.startX, y: active.y + event.clientY - active.startY });
  };

  const endDrag = (event: PointerEvent<HTMLDivElement>) => {
    if (drag.current?.pointerId !== event.pointerId) return;
    drag.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  };

  const percentage = Math.round(zoom * 100);
  return (
    <div
      className={`media-viewer-image-viewport${zoom > 1 ? " is-zoomed" : ""}`}
      tabIndex={0}
      aria-label={`${name}图片预览，可使用加减键缩放，0 键适应窗口`}
      onWheel={onWheel}
      onKeyDown={onKeyDown}
      onDoubleClick={(event) => {
        if (isToolbarTarget(event.target)) return;
        applyZoom(zoom > 1 ? 1 : 2);
      }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
    >
      <div className="media-viewer-media-stage">
        <img
          className="media-viewer-image"
          src={src}
          alt={name}
          draggable={false}
          onError={onError}
          style={{ transform: `translate3d(${position.x}px, ${position.y}px, 0) scale(${zoom})` }}
        />
      </div>
      <div className="media-viewer-toolbar" role="group" aria-label="图片缩放控制">
        <button type="button" aria-label="缩小图片" title="缩小（-）" disabled={zoom <= MIN_ZOOM} onClick={() => applyZoom(zoom - ZOOM_STEP)}>
          <ZoomOutIcon />
        </button>
        <button type="button" className="media-viewer-zoom-value" aria-label="适应窗口" title="适应窗口（0）" onClick={resetView}>
          <FitScreenIcon /><span>{percentage}%</span>
        </button>
        <button type="button" aria-label="放大图片" title="放大（+）" disabled={zoom >= MAX_ZOOM} onClick={() => applyZoom(zoom + ZOOM_STEP)}>
          <ZoomInIcon />
        </button>
      </div>
    </div>
  );
}
