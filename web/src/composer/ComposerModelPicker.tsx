import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { Icon } from "../workspace/Icons";
import type { ComposerModelOption } from "./types";
import "./composer.css";

type ComposerModelPickerProps = {
  options: readonly ComposerModelOption[];
  value: string | null;
  onChange: (modelId: string | null) => void;
  emptyLabel?: string;
  disabled?: boolean;
  loading?: boolean;
  ariaLabel?: string;
};

export function ComposerModelPicker({
  options,
  value,
  onChange,
  emptyLabel,
  disabled = false,
  loading = false,
  ariaLabel = "选择模型",
}: ComposerModelPickerProps) {
  const listboxId = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const selected = options.find((option) => option.id === value) ?? null;
  const allOptions = useMemo(() => [
    ...(emptyLabel ? [{ id: "", label: emptyLabel, description: "使用服务端推荐配置" }] : []),
    ...options,
  ], [emptyLabel, options]);
  const filtered = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase();
    return normalized
      ? allOptions.filter((option) => `${option.label} ${option.description ?? ""} ${option.id}`.toLocaleLowerCase().includes(normalized))
      : allOptions;
  }, [allOptions, query]);

  useEffect(() => {
    if (!open) return;
    setActiveIndex(0);
    const frame = requestAnimationFrame(() => searchRef.current?.focus());
    const onPointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener("pointerdown", onPointerDown);
    };
  }, [open]);

  useEffect(() => {
    if (disabled) setOpen(false);
  }, [disabled]);

  function select(option: ComposerModelOption) {
    onChange(option.id || null);
    setOpen(false);
    setQuery("");
  }

  function onListKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const direction = event.key === "ArrowDown" ? 1 : -1;
      setActiveIndex((current) => (current + direction + filtered.length) % Math.max(filtered.length, 1));
    } else if (event.key === "Enter" && filtered[activeIndex]) {
      event.preventDefault();
      select(filtered[activeIndex]);
    } else if (event.key === "Escape") {
      event.preventDefault();
      setOpen(false);
    }
  }

  return (
    <div className="composer-model-picker" ref={rootRef}>
      <button
        type="button"
        className="composer-model-trigger"
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listboxId : undefined}
        disabled={disabled || loading}
        onClick={() => setOpen((current) => !current)}
      >
        <span>{loading ? "加载模型…" : selected?.label ?? emptyLabel ?? "选择模型"}</span>
        <Icon name="chevron-down" />
      </button>
      {open ? (
        <div className="composer-model-popover">
          {allOptions.length > 5 ? (
            <label className="composer-model-search">
              <span className="sr-only">搜索模型</span>
              <input
                ref={searchRef}
                value={query}
                placeholder="搜索模型…"
                onChange={(event) => { setQuery(event.target.value); setActiveIndex(0); }}
                onKeyDown={onListKeyDown}
              />
            </label>
          ) : null}
          <div id={listboxId} className="composer-model-list" role="listbox" aria-label={ariaLabel}>
            {filtered.map((option, index) => {
              const optionValue = option.id || null;
              const isSelected = optionValue === value;
              return (
                <button
                  key={option.id || "auto"}
                  type="button"
                  role="option"
                  aria-selected={isSelected}
                  className={index === activeIndex ? "is-active" : ""}
                  onMouseEnter={() => setActiveIndex(index)}
                  onClick={() => select(option)}
                >
                  <span><strong>{option.label}</strong>{option.description ? <small>{option.description}</small> : null}</span>
                  {isSelected ? <Icon name="check" /> : null}
                </button>
              );
            })}
            {filtered.length === 0 ? <p>没有匹配的模型</p> : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}
