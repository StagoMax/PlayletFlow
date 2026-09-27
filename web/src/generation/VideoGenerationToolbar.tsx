import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import type { GenerationInputSelection, GenerationOptions, GenerationModel } from "../productApi/generated";
import { Icon } from "../workspace/Icons";
import type { GenerationMediaOption } from "./GenerationControls";
import "./videoGenerationToolbar.css";

type Menu = "format" | "reference" | "duration";

type VideoGenerationToolbarProps = {
  value: GenerationOptions;
  model?: GenerationModel;
  modelName: string;
  media: GenerationMediaOption[];
  canUseFirstLast: boolean;
  canUseReferences: boolean;
  disabled: boolean;
  catalogError: string;
  onChange: (value: GenerationOptions) => void;
  onSelectInput: (type: Exclude<GenerationInputSelection["type"], "textOnly">) => void;
};

const ratios = ["adaptive", "21:9", "16:9", "4:3", "1:1", "3:4", "9:16"] as const;

export function VideoGenerationToolbar({
  value, model, modelName, media, canUseFirstLast, canUseReferences, disabled, catalogError,
  onChange, onSelectInput,
}: VideoGenerationToolbarProps) {
  const [open, setOpen] = useState<Menu | null>(null);
  const rootRef = useRef<HTMLElement>(null);
  const referenceMenuRef = useRef<HTMLDivElement>(null);
  const menuId = useId();
  const inputName = useId();
  const inputType = value.input?.type ?? "textOnly";
  const firstLastInput = value.input?.type === "firstLastFrames" ? value.input : null;
  const ratio = firstLastInput ? "adaptive" : (value.videoRatio ?? "16:9");
  const ratioLabel = ratio === "adaptive" ? "自适应" : ratio;
  const resolution = value.videoResolution ?? "480p";
  const minDuration = model?.minDurationSeconds ?? 4;
  const maxDuration = model?.maxDurationSeconds ?? 15;
  const duration = value.durationSeconds ?? minDuration;
  const [durationDraft, setDurationDraft] = useState(String(duration));

  useEffect(() => setDurationDraft(String(duration)), [duration]);
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(null);
    };
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      rootRef.current?.querySelector<HTMLButtonElement>(`[data-menu-trigger="${open}"]`)?.focus();
      setOpen(null);
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);
  useEffect(() => { if (disabled) setOpen(null); }, [disabled]);
  useLayoutEffect(() => {
    if (open !== "reference") return;
    const menu = referenceMenuRef.current;
    const item = menu?.parentElement;
    if (!menu || !item) return;
    const position = () => {
      const itemLeft = item.getBoundingClientRect().left;
      const availableRight = window.innerWidth - 12 - itemLeft - menu.offsetWidth;
      menu.style.left = `${Math.max(12 - itemLeft, Math.min(0, availableRight))}px`;
    };
    position();
    window.addEventListener("resize", position);
    return () => window.removeEventListener("resize", position);
  }, [open, inputType]);

  function setDuration(next: number) {
    const safe = Math.max(minDuration, Math.min(maxDuration, Math.round(next)));
    onChange({ ...value, durationSeconds: safe });
    setDurationDraft(String(safe));
  }

  function commitDuration() {
    const parsed = Number(durationDraft);
    setDuration(Number.isFinite(parsed) && durationDraft.trim() ? parsed : duration);
  }

  function trigger(menu: Menu, label: string, content: React.ReactNode) {
    return (
      <div className={`video-generation-toolbar__item is-${menu}`}>
        <button type="button" className="video-generation-toolbar__trigger"
          data-menu-trigger={menu} aria-label={label} aria-haspopup="dialog"
          aria-expanded={open === menu} aria-controls={open === menu ? `${menuId}-${menu}` : undefined}
          disabled={disabled} onClick={() => setOpen((current) => current === menu ? null : menu)}>
          {menu === "format" ? `${ratioLabel} · ${resolution}` : menu === "reference"
            ? inputType === "firstLastFrames" ? "首尾帧" : inputType === "referenceImages" ? "全能参考" : "画面参考"
            : `${duration}s`}
          <Icon name="chevron-down" />
        </button>
        {open === menu ? (
          <div ref={menu === "reference" ? referenceMenuRef : undefined}
            id={`${menuId}-${menu}`} role="dialog" aria-label={label}
            className={`video-generation-toolbar__popover is-${menu}`}>
            {content}
          </div>
        ) : null}
      </div>
    );
  }

  return (
    <section ref={rootRef} className="video-generation-toolbar" aria-label="视频生成设置"
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node)) setOpen(null);
      }}>
      <span className="video-generation-toolbar__model" title={modelName}>{modelName}</span>
      {trigger("format", "画幅与清晰度", <>
        <span className="video-generation-toolbar__label">画幅</span>
        <div className="video-generation-toolbar__ratios" role="group" aria-label="画幅">
          {ratios.map((item) => (
            <button key={item} type="button" aria-pressed={ratio === item}
              disabled={firstLastInput !== null && item !== "adaptive"}
              onClick={() => onChange({ ...value, videoRatio: item })}>
              <span className={`video-generation-toolbar__ratio-icon ratio-${item.replace(":", "-")}`} aria-hidden="true" />
              <span>{item === "adaptive" ? "自适应" : item}</span>
            </button>
          ))}
        </div>
        {firstLastInput ? <small>首尾帧模式自动使用自适应画幅</small> : null}
        <span className="video-generation-toolbar__label">清晰度</span>
        <div className="video-generation-toolbar__segments" role="group" aria-label="视频清晰度">
          {["480p", "720p"].map((item) => (
            <button key={item} type="button" aria-pressed={resolution === item}
              onClick={() => onChange({ ...value, videoResolution: item })}>{item}</button>
          ))}
        </div>
        <label className="video-generation-toolbar__audio">
          <input type="checkbox" checked={value.generateAudio ?? false}
            onChange={(event) => onChange({ ...value, generateAudio: event.target.checked })} />
          同步生成声音
        </label>
      </>)}
      {trigger("reference", "画面参考方式", <>
        <span className="video-generation-toolbar__label">画面参考</span>
        <div className="video-generation-toolbar__modes" role="radiogroup" aria-label="画面参考方式">
          <label><input type="radio" name={inputName} checked={inputType === "firstLastFrames"}
            disabled={!canUseFirstLast} onChange={() => onSelectInput("firstLastFrames")} />首尾帧</label>
          <label><input type="radio" name={inputName} checked={inputType === "referenceImages"}
            disabled={!canUseReferences}
            onChange={() => onSelectInput("referenceImages")} />全能参考</label>
        </div>
        {firstLastInput ? (
          <div className="video-generation-toolbar__frames">
            <label>首帧<select value={firstLastInput.firstFrameMediaId}
              onChange={(event) => onChange({ ...value, input: { ...firstLastInput, firstFrameMediaId: event.target.value } })}>
              {media.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
            </select></label>
            <label>尾帧<select value={firstLastInput.lastFrameMediaId ?? ""}
              onChange={(event) => onChange({ ...value, input: { ...firstLastInput, lastFrameMediaId: event.target.value || null } })}>
              <option value="">不指定</option>
              {media.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
            </select></label>
            <small>此模式只发送首帧和尾帧作为图片输入。</small>
          </div>
        ) : null}
      </>)}
      {trigger("duration", "视频生成时长", <>
        <span className="video-generation-toolbar__label">视频时长</span>
        <div className="video-generation-toolbar__duration">
          <input type="range" min={minDuration} max={maxDuration} value={duration}
            aria-label="视频时长滑块" onChange={(event) => setDuration(Number(event.target.value))} />
          <label><input type="number" min={minDuration} max={maxDuration} value={durationDraft}
            aria-label="视频时长（秒）" onChange={(event) => setDurationDraft(event.target.value)}
            onBlur={commitDuration} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); commitDuration(); } }} />秒</label>
        </div>
        <div className="video-generation-toolbar__duration-scale"><span>{minDuration}s</span><span>{maxDuration}s</span></div>
      </>)}
      {catalogError ? <small className="video-generation-toolbar__hint">{catalogError}</small> : null}
    </section>
  );
}
