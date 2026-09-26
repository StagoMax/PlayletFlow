import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties } from "react";
import { Icon } from "../workspace/Icons";
import type { WorkspaceThreadBinding } from "./workspaceThreadClient";

type ThreadSwitcherProps = {
  bindings: WorkspaceThreadBinding[];
  activeThreadId: string | null;
  storyboardName: string;
  disabled?: boolean;
  onSelect: (threadId: string) => void;
};

type MarqueeStyle = CSSProperties & {
  "--thread-title-shift": string;
  "--thread-title-duration": string;
};

function threadTitle(
  binding: WorkspaceThreadBinding | undefined,
  bindings: WorkspaceThreadBinding[],
  storyboardName: string,
) {
  if (!binding) return storyboardName;
  const chronological = [...bindings].sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  const index = chronological.findIndex((item) => item.threadId === binding.threadId);
  return index <= 0 ? storyboardName : `${storyboardName} · 会话 ${index + 1}`;
}

function formatCreatedAt(createdAt: string) {
  const date = new Date(createdAt);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat("zh-CN", {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(date);
}

function ScrollableTitle({ title }: { title: string }) {
  const viewportRef = useRef<HTMLSpanElement>(null);
  const trackRef = useRef<HTMLSpanElement>(null);
  const [overflow, setOverflow] = useState({ active: false, distance: 0 });

  useLayoutEffect(() => {
    const viewport = viewportRef.current;
    const track = trackRef.current;
    if (!viewport || !track) return;
    const measure = () => {
      const distance = Math.max(0, track.scrollWidth - viewport.clientWidth);
      setOverflow((current) => current.active === (distance > 1) && current.distance === distance
        ? current
        : { active: distance > 1, distance });
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(viewport);
    observer.observe(track);
    return () => observer.disconnect();
  }, [title]);

  const style = useMemo<MarqueeStyle>(() => ({
    "--thread-title-shift": `${-overflow.distance}px`,
    "--thread-title-duration": `${Math.max(5, overflow.distance / 18)}s`,
  }), [overflow.distance]);

  return (
    <span ref={viewportRef} className="thread-title-viewport" data-overflow={overflow.active} title={title}>
      <span ref={trackRef} className="thread-title-track" style={style}>{title}</span>
    </span>
  );
}

export function ThreadSwitcher({
  bindings,
  activeThreadId,
  storyboardName,
  disabled = false,
  onSelect,
}: ThreadSwitcherProps) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const activeBinding = bindings.find((item) => item.threadId === activeThreadId);
  const activeTitle = threadTitle(activeBinding, bindings, storyboardName);

  useEffect(() => {
    if (!open) return;
    const closeFromOutside = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const closeFromKeyboard = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setOpen(false);
      triggerRef.current?.focus();
    };
    document.addEventListener("pointerdown", closeFromOutside);
    document.addEventListener("keydown", closeFromKeyboard);
    return () => {
      document.removeEventListener("pointerdown", closeFromOutside);
      document.removeEventListener("keydown", closeFromKeyboard);
    };
  }, [open]);

  useEffect(() => setOpen(false), [storyboardName]);

  return (
    <div ref={rootRef} className="thread-switcher">
      <button
        ref={triggerRef}
        className="thread-trigger"
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`切换对话，当前：${activeTitle}`}
        disabled={disabled || bindings.length === 0}
        onClick={() => setOpen((current) => !current)}
      >
        <ScrollableTitle title={activeTitle} />
        <Icon name="chevron-down" className="thread-trigger-chevron" />
      </button>
      {open ? (
        <div className="thread-menu" role="menu" aria-label="切换对话">
          {bindings.map((binding) => {
            const title = threadTitle(binding, bindings, storyboardName);
            const selected = binding.threadId === activeThreadId;
            return (
              <button
                key={binding.threadId}
                className="thread-menu-item"
                type="button"
                role="menuitemradio"
                aria-checked={selected}
                data-thread-id={binding.threadId}
                onClick={() => {
                  onSelect(binding.threadId);
                  setOpen(false);
                }}
              >
                <span><strong>{title}</strong><small>{formatCreatedAt(binding.createdAt)}</small></span>
                {selected ? <Icon name="check" /> : null}
              </button>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}
