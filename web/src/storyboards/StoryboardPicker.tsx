import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import type { AssetBinding, AssetCopySummary, StoryboardSummary } from "../productApi/generated";
import { Icon } from "../workspace/Icons";
import { CreateStoryboardDialog, type CreateStoryboardInput } from "./CreateStoryboardDialog";

type StoryboardPickerProps = {
  storyboards: StoryboardSummary[];
  currentId: string;
  onSelect: (storyboardId: string) => void;
  loadAssetBindings: (storyboardId: string, signal: AbortSignal) => Promise<AssetBinding[]>;
  onCreate: (sourceStoryboardId: string, input: CreateStoryboardInput) => Promise<AssetCopySummary>;
};

export function StoryboardPicker({ storyboards, currentId, onSelect, loadAssetBindings, onCreate }: StoryboardPickerProps) {
  const menuId = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const optionRefs = useRef(new Map<string, HTMLButtonElement>());
  const [open, setOpen] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const currentIndex = Math.max(0, storyboards.findIndex((item) => item.id === currentId));
  const [highlightedIndex, setHighlightedIndex] = useState(currentIndex);
  const current = storyboards[currentIndex];
  const loadCurrentBindings = useCallback(
    (signal: AbortSignal) => loadAssetBindings(currentId, signal),
    [currentId, loadAssetBindings],
  );

  useLayoutEffect(() => {
    if (!open) return;
    setHighlightedIndex(currentIndex);
    const option = optionRefs.current.get(currentId);
    option?.scrollIntoView({ block: "center" });
    option?.focus({ preventScroll: true });
  }, [currentId, currentIndex, open]);

  useEffect(() => {
    if (!open) return;
    const closeOutside = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", closeOutside);
    return () => document.removeEventListener("pointerdown", closeOutside);
  }, [open]);

  function moveHighlight(nextIndex: number) {
    const index = (nextIndex + storyboards.length) % storyboards.length;
    setHighlightedIndex(index);
    optionRefs.current.get(storyboards[index].id)?.focus();
  }

  function select(storyboardId: string) {
    onSelect(storyboardId);
    setOpen(false);
  }

  return (
    <div className="storyboard-picker" ref={rootRef}>
      <span className="storyboard-current-index">分镜 {current.index}</span>
      <button
        className="storyboard-trigger storyboard-trigger--compact"
        type="button"
        aria-label={`切换分镜，当前分镜 ${current.index}：${current.name}`}
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
        <span className="sr-only">分镜 {current.index} {current.name}</span>
        <Icon name="chevron-down" className="storyboard-chevron" />
      </button>

      {open && (
        <div className="storyboard-menu" id={menuId} role="listbox" aria-label="选择分镜">
          <div className="storyboard-menu-head">
            <span>{storyboards.length} 个分镜</span>
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
                tabIndex={index === highlightedIndex ? 0 : -1}
                className="storyboard-option"
                onClick={() => select(storyboard.id)}
                onFocus={() => setHighlightedIndex(index)}
                onKeyDown={(event) => {
                  if (event.key === "ArrowDown") { event.preventDefault(); moveHighlight(index + 1); }
                  if (event.key === "ArrowUp") { event.preventDefault(); moveHighlight(index - 1); }
                  if (event.key === "Home") { event.preventDefault(); moveHighlight(0); }
                  if (event.key === "End") { event.preventDefault(); moveHighlight(storyboards.length - 1); }
                  if (event.key === "Enter" || event.key === " ") { event.preventDefault(); select(storyboard.id); }
                  if (event.key === "Escape") { event.preventDefault(); setOpen(false); }
                }}
              >
                <span className="storyboard-number">{String(index + 1).padStart(2, "0")}</span>
                <span className="storyboard-option-copy"><strong>{storyboard.name}</strong><small>{storyboard.pendingProposalCount ? `${storyboard.pendingProposalCount} 项待确认` : "已同步"}</small></span>
                {storyboard.id === currentId && <span className="current-indicator" aria-hidden="true" />}
              </button>
            ))}
          </div>
          <button type="button" className="storyboard-create" onClick={() => { setOpen(false); setCreateOpen(true); }}>
            <Icon name="plus" /> 新建分镜
          </button>
        </div>
      )}
      <CreateStoryboardDialog
        open={createOpen}
        defaultName={`分镜 ${storyboards.length + 1}`}
        sourceName={current.name}
        loadBindings={loadCurrentBindings}
        onClose={() => setCreateOpen(false)}
        onCreate={(input) => onCreate(currentId, input)}
      />
    </div>
  );
}
