import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties } from "react";
import { createPortal } from "react-dom";
import { Icon } from "../workspace/Icons";
import type { WorkspaceThreadBinding } from "./workspaceThreadClient";
import { conversationHeaderTitle, displayThreadTitle } from "../threadTitle";

type ThreadSwitcherProps = {
  bindings: WorkspaceThreadBinding[];
  activeThreadId: string | null;
  storyboardName: string;
  threadTitles: Readonly<Record<string, string>>;
  disabled?: boolean;
  onSelect: (threadId: string) => void;
  onDelete: (threadId: string) => void;
};

type MarqueeStyle = CSSProperties & {
  "--thread-title-shift": string;
  "--thread-title-duration": string;
};

type ThreadContextMenu = {
  threadId: string;
  title: string;
  x: number;
  y: number;
  trigger: HTMLButtonElement;
};

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
  threadTitles,
  disabled = false,
  onSelect,
  onDelete,
}: ThreadSwitcherProps) {
  const [open, setOpen] = useState(false);
  const [context, setContext] = useState<ThreadContextMenu | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const contextRef = useRef<HTMLDivElement>(null);
  const contextButtonRef = useRef<HTMLButtonElement>(null);
  const activeBinding = bindings.find((item) => item.threadId === activeThreadId);
  const activeTitle = conversationHeaderTitle(
    displayThreadTitle(
      activeBinding ? threadTitles[activeBinding.threadId] : undefined,
      storyboardName,
    ),
  );

  useEffect(() => {
    if (!open && !context) return;
    const closeFromOutside = (event: PointerEvent) => {
      const target = event.target as Node;
      if (contextRef.current?.contains(target)) return;
      if (!rootRef.current?.contains(target)) setOpen(false);
      setContext(null);
    };
    const closeFromKeyboard = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      if (context) {
        setContext(null);
        context.trigger.focus();
        return;
      }
      setOpen(false);
      triggerRef.current?.focus();
    };
    const closeFromViewportChange = () => setContext(null);
    document.addEventListener("pointerdown", closeFromOutside);
    document.addEventListener("keydown", closeFromKeyboard);
    window.addEventListener("resize", closeFromViewportChange);
    window.addEventListener("scroll", closeFromViewportChange, true);
    return () => {
      document.removeEventListener("pointerdown", closeFromOutside);
      document.removeEventListener("keydown", closeFromKeyboard);
      window.removeEventListener("resize", closeFromViewportChange);
      window.removeEventListener("scroll", closeFromViewportChange, true);
    };
  }, [open, context]);

  useLayoutEffect(() => {
    if (context) contextButtonRef.current?.focus();
  }, [context]);

  useEffect(() => {
    setOpen(false);
    setContext(null);
  }, [storyboardName]);

  useEffect(() => {
    if (disabled) {
      setOpen(false);
      setContext(null);
    }
  }, [disabled]);

  function openContextMenu(threadId: string, title: string, trigger: HTMLButtonElement, x: number, y: number) {
    setContext({
      threadId,
      title,
      trigger,
      x: Math.max(8, Math.min(x, window.innerWidth - 168)),
      y: Math.max(8, Math.min(y, window.innerHeight - 52)),
    });
  }

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
        onClick={() => {
          setContext(null);
          setOpen((current) => !current);
        }}
      >
        <ScrollableTitle title={activeTitle} />
        <Icon name="chevron-down" className="thread-trigger-chevron" />
      </button>
      {open ? (
        <div className="thread-menu" role="menu" aria-label="切换对话">
          {bindings.map((binding) => {
            const title = displayThreadTitle(threadTitles[binding.threadId], storyboardName);
            const selected = binding.threadId === activeThreadId;
            return (
              <button
                key={binding.threadId}
                className="thread-menu-item"
                type="button"
                role="menuitemradio"
                aria-checked={selected}
                aria-haspopup="menu"
                data-thread-id={binding.threadId}
                onContextMenu={(event) => {
                  event.preventDefault();
                  openContextMenu(binding.threadId, title, event.currentTarget, event.clientX, event.clientY);
                }}
                onKeyDown={(event) => {
                  if (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10")) {
                    event.preventDefault();
                    const rect = event.currentTarget.getBoundingClientRect();
                    openContextMenu(binding.threadId, title, event.currentTarget, rect.left + 24, rect.bottom);
                  }
                }}
                onClick={() => {
                  onSelect(binding.threadId);
                  setContext(null);
                  setOpen(false);
                }}
              >
                <span><strong>{title}</strong></span>
                {selected ? <Icon name="check" /> : null}
              </button>
            );
          })}
        </div>
      ) : null}
      {context ? createPortal(
        <div
          ref={contextRef}
          className="thread-context-menu"
          role="menu"
          aria-label={`${context.title}的操作`}
          style={{ left: context.x, top: context.y }}
        >
          <button
            ref={contextButtonRef}
            type="button"
            role="menuitem"
            onClick={() => {
              setContext(null);
              if (!window.confirm(`确定删除会话“${context.title}”？删除后无法恢复。`)) return;
              setOpen(false);
              onDelete(context.threadId);
            }}
          >删除会话</button>
        </div>,
        document.body,
      ) : null}
    </div>
  );
}
