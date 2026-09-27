import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import { Icon } from "./Icons";

const STORAGE_KEY = "videoflow.assistant-launcher-position";
const LAUNCHER_HEIGHT = 48;
const VIEWPORT_MARGIN = 16;
const DEFAULT_POSITION_RATIO = 0.9;
const DRAG_THRESHOLD = 5;
const KEYBOARD_STEP = 24;

type AssistantLauncherProps = {
  onOpen: () => void;
};

type DragState = {
  pointerId: number;
  startClientY: number;
  startTop: number;
  moved: boolean;
};

function maxTop() {
  return Math.max(VIEWPORT_MARGIN, window.innerHeight - LAUNCHER_HEIGHT - VIEWPORT_MARGIN);
}

function clampTop(top: number) {
  return Math.min(Math.max(top, VIEWPORT_MARGIN), maxTop());
}

function topFromRatio(ratio: number) {
  const available = maxTop() - VIEWPORT_MARGIN;
  return VIEWPORT_MARGIN + available * Math.min(Math.max(ratio, 0), 1);
}

function positionRatio(top: number) {
  const available = maxTop() - VIEWPORT_MARGIN;
  return available > 0 ? (clampTop(top) - VIEWPORT_MARGIN) / available : 0;
}

function readInitialRatio() {
  try {
    const storedValue = window.localStorage.getItem(STORAGE_KEY);
    if (storedValue !== null) {
      const stored = Number(storedValue);
      if (Number.isFinite(stored)) return Math.min(Math.max(stored, 0), 1);
    }
  } catch {
    // Storage can be unavailable in privacy-restricted browser contexts.
  }
  return DEFAULT_POSITION_RATIO;
}

function persistRatio(ratio: number) {
  try {
    window.localStorage.setItem(STORAGE_KEY, String(ratio));
  } catch {
    // Position persistence is an enhancement; dragging still works without it.
  }
}

export function AssistantLauncher({ onOpen }: AssistantLauncherProps) {
  const ratio = useRef(readInitialRatio());
  const [top, setTop] = useState(() => topFromRatio(ratio.current));
  const [dragging, setDragging] = useState(false);
  const dragState = useRef<DragState | null>(null);
  const suppressClick = useRef(false);

  useEffect(() => {
    const handleResize = () => setTop(topFromRatio(ratio.current));
    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, []);

  const moveWithKeyboard = useCallback((next: (current: number) => number) => {
    setTop((current) => {
      const adjusted = clampTop(next(current));
      ratio.current = positionRatio(adjusted);
      persistRatio(ratio.current);
      return adjusted;
    });
  }, []);

  const handleKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key === "ArrowUp") {
      event.preventDefault();
      moveWithKeyboard((current) => current - KEYBOARD_STEP);
    } else if (event.key === "ArrowDown") {
      event.preventDefault();
      moveWithKeyboard((current) => current + KEYBOARD_STEP);
    } else if (event.key === "Home") {
      event.preventDefault();
      moveWithKeyboard(() => VIEWPORT_MARGIN);
    } else if (event.key === "End") {
      event.preventDefault();
      moveWithKeyboard(() => maxTop());
    }
  };

  const handlePointerDown = (event: PointerEvent<HTMLButtonElement>) => {
    if (event.button !== 0) return;
    suppressClick.current = false;
    dragState.current = {
      pointerId: event.pointerId,
      startClientY: event.clientY,
      startTop: top,
      moved: false,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const handlePointerMove = (event: PointerEvent<HTMLButtonElement>) => {
    const currentDrag = dragState.current;
    if (!currentDrag || currentDrag.pointerId !== event.pointerId) return;
    const delta = event.clientY - currentDrag.startClientY;
    if (!currentDrag.moved && Math.abs(delta) < DRAG_THRESHOLD) return;
    currentDrag.moved = true;
    setDragging(true);
    setTop(clampTop(currentDrag.startTop + delta));
  };

  const finishDrag = (event: PointerEvent<HTMLButtonElement>, cancelled = false) => {
    const currentDrag = dragState.current;
    if (!currentDrag || currentDrag.pointerId !== event.pointerId) return;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    if (currentDrag.moved) {
      const nextTop = clampTop(currentDrag.startTop + event.clientY - currentDrag.startClientY);
      setTop(nextTop);
      ratio.current = positionRatio(nextTop);
      persistRatio(ratio.current);
      suppressClick.current = !cancelled;
    }
    dragState.current = null;
    setDragging(false);
  };

  return (
    <>
      <button
        className={`assistant-launcher${dragging ? " is-dragging" : ""}`}
        type="button"
        style={{ top }}
        aria-label="与 AI 对话"
        aria-describedby="assistant-launcher-help"
        aria-controls="workspace-assistant-panel"
        aria-expanded="false"
        title="拖动调整位置，点击打开 AI 对话"
        autoFocus
        onClick={(event) => {
          if (suppressClick.current) {
            suppressClick.current = false;
            event.preventDefault();
            return;
          }
          onOpen();
        }}
        onKeyDown={handleKeyDown}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={(event) => finishDrag(event)}
        onPointerCancel={(event) => finishDrag(event, true)}
      >
        <Icon name="sparkles" />
        <span>与 AI 对话</span>
      </button>
      <span id="assistant-launcher-help" className="sr-only">
        拖动或使用上下方向键调整入口位置，按回车键打开 AI 对话。
      </span>
    </>
  );
}
