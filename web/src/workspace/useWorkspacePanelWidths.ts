import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";

const STORAGE_KEY = "videoflow.workspace-panel-widths";
const DEFAULT_WIDTHS = { navigator: 264, assistant: 360 };
const MIN_WIDTHS = { navigator: 220, assistant: 300, canvas: 360 };
const MAX_WIDTHS = { navigator: 420, assistant: 600 };
const KEYBOARD_STEP = 16;

type Panel = "navigator" | "assistant";
type PanelWidths = { navigator: number; assistant: number };

function clamp(value: number, minimum: number, maximum: number) {
  return Math.min(Math.max(value, minimum), Math.max(minimum, maximum));
}

function readWidths(): PanelWidths {
  try {
    const stored = JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? "null");
    if (stored && Number.isFinite(stored.navigator) && Number.isFinite(stored.assistant)) {
      return {
        navigator: clamp(stored.navigator, MIN_WIDTHS.navigator, MAX_WIDTHS.navigator),
        assistant: clamp(stored.assistant, MIN_WIDTHS.assistant, MAX_WIDTHS.assistant),
      };
    }
  } catch {
    // The layout remains adjustable when browser storage is unavailable.
  }
  return DEFAULT_WIDTHS;
}

function persistWidths(widths: PanelWidths) {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(widths));
  } catch {
    // Persistence is optional.
  }
}

function fitWidths(preferred: PanelWidths, available: number, assistantOpen: boolean): PanelWidths {
  const assistant = assistantOpen
    ? clamp(preferred.assistant, MIN_WIDTHS.assistant,
      Math.min(MAX_WIDTHS.assistant, available - MIN_WIDTHS.navigator - MIN_WIDTHS.canvas))
    : preferred.assistant;
  const navigator = clamp(preferred.navigator, MIN_WIDTHS.navigator,
    Math.min(MAX_WIDTHS.navigator, available - (assistantOpen ? assistant : 0) - MIN_WIDTHS.canvas));
  return { navigator, assistant };
}

export function useWorkspacePanelWidths(assistantOpen: boolean) {
  const shellRef = useRef<HTMLDivElement>(null);
  const [preferred, setPreferred] = useState(readWidths);
  const preferredRef = useRef(preferred);
  const [available, setAvailable] = useState(() => window.innerWidth);
  const [dragging, setDragging] = useState<Panel | null>(null);
  const dragRef = useRef<{ panel: Panel; pointerId: number } | null>(null);
  const widths = fitWidths(preferred, available, assistantOpen);

  useEffect(() => {
    const shell = shellRef.current;
    if (!shell) return;
    const observer = new ResizeObserver(() => setAvailable(shell.clientWidth));
    observer.observe(shell);
    setAvailable(shell.clientWidth);
    return () => observer.disconnect();
  }, []);

  useEffect(() => () => document.body.classList.remove("workspace-resizing"), []);

  const limits = (panel: Panel) => {
    const currentAvailable = shellRef.current?.clientWidth ?? available;
    const current = fitWidths(preferredRef.current, currentAvailable, assistantOpen);
    return panel === "navigator"
      ? { min: MIN_WIDTHS.navigator, max: Math.max(MIN_WIDTHS.navigator,
        Math.min(MAX_WIDTHS.navigator, currentAvailable - (assistantOpen ? current.assistant : 0) - MIN_WIDTHS.canvas)) }
      : { min: MIN_WIDTHS.assistant, max: Math.max(MIN_WIDTHS.assistant,
        Math.min(MAX_WIDTHS.assistant, currentAvailable - current.navigator - MIN_WIDTHS.canvas)) };
  };

  const setWidth = (panel: Panel, value: number, persist: boolean) => {
    const { min, max } = limits(panel);
    const next = { ...preferredRef.current, [panel]: Math.round(clamp(value, min, max)) };
    preferredRef.current = next;
    setPreferred(next);
    if (persist) persistWidths(next);
  };

  const onPointerDown = (panel: Panel, event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || dragRef.current) return;
    event.preventDefault();
    dragRef.current = { panel, pointerId: event.pointerId };
    event.currentTarget.setPointerCapture(event.pointerId);
    document.body.classList.add("workspace-resizing");
    setDragging(panel);
  };

  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    const shell = shellRef.current;
    if (!drag || drag.pointerId !== event.pointerId || !shell) return;
    const bounds = shell.getBoundingClientRect();
    setWidth(drag.panel, drag.panel === "navigator"
      ? event.clientX - bounds.left
      : bounds.right - event.clientX, false);
  };

  const onPointerEnd = (event: PointerEvent<HTMLDivElement>) => {
    if (dragRef.current?.pointerId !== event.pointerId) return;
    dragRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    document.body.classList.remove("workspace-resizing");
    setDragging(null);
    persistWidths(preferredRef.current);
  };

  const onKeyDown = (panel: Panel, event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    const direction = event.key === "ArrowRight" ? 1 : -1;
    const current = fitWidths(preferredRef.current, shellRef.current?.clientWidth ?? available, assistantOpen);
    setWidth(panel, current[panel] + direction * KEYBOARD_STEP * (panel === "assistant" ? -1 : 1), true);
  };

  return { shellRef, widths, dragging, limits, onPointerDown, onPointerMove, onPointerEnd, onKeyDown };
}
