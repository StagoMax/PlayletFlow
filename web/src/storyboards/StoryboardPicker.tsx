import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import type { StoryboardSummary } from "../productApi/generated";
import { Icon } from "../workspace/Icons";
import { CreateStoryboardDialog } from "./CreateStoryboardDialog";

type StoryboardPickerProps = {
  storyboards: StoryboardSummary[];
  currentId: string;
  onSelect: (storyboardId: string) => void;
  onCreate: (sourceStoryboardId: string, name: string) => Promise<void>;
  onDuplicate: (storyboardId: string) => Promise<void>;
  onReorder: (storyboardId: string, targetId: string, placement: "before" | "after") => Promise<void>;
};

export function StoryboardPicker({ storyboards, currentId, onSelect, onCreate, onDuplicate, onReorder }: StoryboardPickerProps) {
  const menuId = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const contextButtonRef = useRef<HTMLButtonElement>(null);
  const focusedIdRef = useRef<string | null>(null);
  const optionRefs = useRef(new Map<string, HTMLButtonElement>());
  const [open, setOpen] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [context, setContext] = useState<{ id: string; x: number; y: number } | null>(null);
  const [draggedId, setDraggedId] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<{ id: string; placement: "before" | "after" } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const currentIndex = Math.max(0, storyboards.findIndex((item) => item.id === currentId));
  const [highlightedIndex, setHighlightedIndex] = useState(currentIndex);
  const current = storyboards[currentIndex];

  useLayoutEffect(() => {
    if (!open) { focusedIdRef.current = null; return; }
    if (focusedIdRef.current === currentId) return;
    focusedIdRef.current = currentId;
    setHighlightedIndex(currentIndex);
    const option = optionRefs.current.get(currentId);
    option?.scrollIntoView({ block: "center" });
    option?.focus({ preventScroll: true });
  }, [currentId, currentIndex, open]);

  useEffect(() => {
    if (!open) return;
    const closeOutside = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) { setOpen(false); setContext(null); }
    };
    document.addEventListener("pointerdown", closeOutside);
    return () => document.removeEventListener("pointerdown", closeOutside);
  }, [open]);
  useLayoutEffect(() => {
    if (context) contextButtonRef.current?.focus();
  }, [context]);
  useEffect(() => {
    if (!context) return;
    const close = (event: KeyboardEvent) => {
      if (event.key === "Escape") { setContext(null); event.preventDefault(); }
    };
    document.addEventListener("keydown", close);
    return () => document.removeEventListener("keydown", close);
  }, [context]);

  function moveHighlight(nextIndex: number) {
    const index = (nextIndex + storyboards.length) % storyboards.length;
    setHighlightedIndex(index);
    optionRefs.current.get(storyboards[index].id)?.focus();
  }

  function select(storyboardId: string) {
    onSelect(storyboardId);
    setOpen(false);
  }

  async function duplicate(storyboardId: string) {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      await onDuplicate(storyboardId);
      setContext(null);
      setOpen(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "复制片段失败，请重试。");
      setContext(null);
    } finally {
      setBusy(false);
    }
  }

  async function reorder(storyboardId: string, targetId: string, placement: "before" | "after") {
    if (busy || storyboardId === targetId) return;
    setBusy(true);
    setError("");
    try {
      await onReorder(storyboardId, targetId, placement);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "调整片段顺序失败，请重试。");
    } finally {
      setBusy(false);
      setDraggedId(null);
      setDropTarget(null);
    }
  }

  return (
    <div className="storyboard-picker" ref={rootRef}>
      <span className="storyboard-current-index">片段 {current.index}</span>
      <button
        className="storyboard-trigger storyboard-trigger--compact"
        type="button"
        aria-label={`切换片段，当前片段 ${current.index}：${current.name}`}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={menuId}
        onClick={() => setOpen((value) => !value)}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            setOpen(true);
          }
        }}
      >
        <span className="sr-only">片段 {current.index} {current.name}</span>
        <Icon name="chevron-down" className="storyboard-chevron" />
      </button>

      {open && (
        <div className="storyboard-menu" id={menuId} role="listbox" aria-label="选择片段">
          <div className="storyboard-menu-head">
            <span>{storyboards.length} 个片段</span>
            <span className="icon-button" aria-hidden="true"><Icon name="more" /></span>
          </div>
          <div className="storyboard-options">
            {storyboards.map((storyboard, index) => (
              <button
                key={storyboard.id}
                ref={(element) => {
                  if (element) optionRefs.current.set(storyboard.id, element);
                  else optionRefs.current.delete(storyboard.id);
                }}
                type="button"
                role="option"
                aria-selected={storyboard.id === currentId}
                aria-description="拖拽排序，右键复制；也可按 Alt 加上下方向键排序"
                tabIndex={index === highlightedIndex ? 0 : -1}
                className="storyboard-option"
                title="拖拽排序 · 右键复制"
                data-storyboard-id={storyboard.id}
                draggable={!busy}
                data-dragging={draggedId === storyboard.id}
                data-drop={dropTarget?.id === storyboard.id ? dropTarget.placement : undefined}
                onContextMenu={(event) => {
                  event.preventDefault();
                  setContext({ id: storyboard.id, x: event.clientX, y: event.clientY });
                }}
                onDragStart={(event) => {
                  setContext(null);
                  setDraggedId(storyboard.id);
                  event.dataTransfer.effectAllowed = "move";
                  event.dataTransfer.setData("text/plain", storyboard.id);
                }}
                onDragOver={(event) => {
                  if (!draggedId || draggedId === storyboard.id || busy) return;
                  event.preventDefault();
                  event.dataTransfer.dropEffect = "move";
                  const placement = event.clientY < event.currentTarget.getBoundingClientRect().top + event.currentTarget.offsetHeight / 2 ? "before" : "after";
                  setDropTarget((current) =>
                    current?.id === storyboard.id && current.placement === placement
                      ? current
                      : { id: storyboard.id, placement });
                }}
                onDrop={(event) => {
                  event.preventDefault();
                  const sourceId = event.dataTransfer.getData("text/plain") || draggedId;
                  const placement = event.clientY < event.currentTarget.getBoundingClientRect().top + event.currentTarget.offsetHeight / 2 ? "before" : "after";
                  if (sourceId) void reorder(sourceId, storyboard.id, placement);
                }}
                onDragEnd={() => { setDraggedId(null); setDropTarget(null); }}
                onClick={() => select(storyboard.id)}
                onFocus={() => setHighlightedIndex(index)}
                onKeyDown={(event) => {
                  if (event.altKey && (event.key === "ArrowUp" || event.key === "ArrowDown")) {
                    event.preventDefault();
                    const target = storyboards[index + (event.key === "ArrowUp" ? -1 : 1)];
                    if (target) void reorder(storyboard.id, target.id, event.key === "ArrowUp" ? "before" : "after");
                    return;
                  }
                  if (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10")) {
                    event.preventDefault();
                    const rect = event.currentTarget.getBoundingClientRect();
                    setContext({ id: storyboard.id, x: rect.left + 32, y: rect.bottom });
                    return;
                  }
                  if (event.key === "ArrowDown") { event.preventDefault(); moveHighlight(index + 1); }
                  if (event.key === "ArrowUp") { event.preventDefault(); moveHighlight(index - 1); }
                  if (event.key === "Home") { event.preventDefault(); moveHighlight(0); }
                  if (event.key === "End") { event.preventDefault(); moveHighlight(storyboards.length - 1); }
                  if (event.key === "Enter" || event.key === " ") { event.preventDefault(); select(storyboard.id); }
                  if (event.key === "Escape") { event.preventDefault(); setOpen(false); }
                }}
              >
                <span className="storyboard-number">{String(index + 1).padStart(2, "0")}</span>
                <span className="storyboard-option-copy"><strong>{storyboard.name}</strong>{storyboard.pendingProposalCount > 0 ? <span className="ui-badge" data-tone="pending">{storyboard.pendingProposalCount} 项待确认</span> : null}</span>
                {storyboard.id === currentId && <span className="current-indicator" aria-hidden="true" />}
              </button>
            ))}
          </div>
          {error && <p className="storyboard-action-error" role="alert">{error}</p>}
          <button type="button" className="storyboard-create" onClick={() => { setOpen(false); setCreateOpen(true); }}>
            <Icon name="plus" /> 新建片段
          </button>
        </div>
      )}
      {context && (
        <div className="storyboard-context-menu" role="menu" style={{ left: Math.min(context.x, window.innerWidth - 156), top: Math.min(context.y, window.innerHeight - 54) }}>
          <button ref={contextButtonRef} type="button" role="menuitem" disabled={busy} onClick={() => void duplicate(context.id)}>
            复制片段
          </button>
        </div>
      )}
      <CreateStoryboardDialog
        open={createOpen}
        defaultName={`片段 ${storyboards.length + 1}`}
        sourceName={current.name}
        onClose={() => setCreateOpen(false)}
        onCreate={(name) => onCreate(currentId, name)}
      />
    </div>
  );
}
