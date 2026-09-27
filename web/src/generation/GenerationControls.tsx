import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import type {
  GenerationInputSelection,
  GenerationModel,
  GenerationOptions,
  MediaKind,
} from "../productApi/generated";
import { Icon } from "../workspace/Icons";
import { VideoGenerationToolbar } from "./VideoGenerationToolbar";
import "./generation.css";

export type GenerationModelLoader = (signal?: AbortSignal) => Promise<GenerationModel[]>;

export type GenerationMediaOption = {
  id: string;
  name: string;
};

type GenerationControlsProps = {
  loadModels: GenerationModelLoader;
  kind: MediaKind;
  media: GenerationMediaOption[];
  referenceMediaIds?: readonly string[];
  value: GenerationOptions;
  onChange: (value: GenerationOptions) => void;
  disabled?: boolean;
  compact?: boolean;
};

export function GenerationControls({
  loadModels,
  kind,
  media,
  referenceMediaIds = [],
  value,
  onChange,
  disabled = false,
  compact = false,
}: GenerationControlsProps) {
  const [models, setModels] = useState<GenerationModel[]>([]);
  const [catalogError, setCatalogError] = useState("");
  const inputGroup = `generation-input-${useId()}`;

  useEffect(() => {
    const controller = new AbortController();
    void loadModels(controller.signal)
      .then((items) => {
        setModels(items.filter((item) => item.kind === kind));
        setCatalogError("");
      })
      .catch((cause: unknown) => {
        if (!(cause instanceof DOMException && cause.name === "AbortError")) {
          setCatalogError("模型列表暂时不可用，将使用服务端默认模型。");
        }
      });
    return () => controller.abort();
  }, [kind, loadModels]);

  const selectedModel = models.find((model) => model.id === value.model) ?? models[0];
  const inputType = value.input?.type ?? "textOnly";
  const firstLastInput = value.input?.type === "firstLastFrames" ? value.input : null;
  const referenceInput = value.input?.type === "referenceImages" ? value.input : null;
  const canUseFirstLast = kind === "video"
    && (selectedModel?.supportsFirstLastFrames ?? true)
    && media.length > 0;
  const maxReferences = selectedModel?.maxReferenceImages ?? (kind === "video" ? 9 : 14);

  function setInput(type: GenerationInputSelection["type"]) {
    if (type === "textOnly") {
      onChange({ ...value, input: { type: "textOnly" } });
      return;
    }
    if (type === "firstLastFrames") {
      const first = media[0]?.id;
      if (first) {
        onChange({
          ...value,
          input: { type, firstFrameMediaId: first, lastFrameMediaId: null },
          videoRatio: "adaptive",
        });
      }
      return;
    }
    const mediaIds = compact && kind === "video" ? referenceMediaIds : media.slice(0, 1).map((item) => item.id);
    if (mediaIds.length > 0) onChange({ ...value, input: { type, mediaIds: [...mediaIds] } });
  }

  function toggleReference(mediaId: string, checked: boolean) {
    const current = referenceInput?.mediaIds ?? [];
    const mediaIds = checked
      ? [...current, mediaId].slice(0, maxReferences)
      : current.filter((id) => id !== mediaId);
    onChange({ ...value, input: { type: "referenceImages", mediaIds } });
  }

  function moveReference(index: number, direction: -1 | 1) {
    if (!referenceInput) return;
    const nextIndex = index + direction;
    if (nextIndex < 0 || nextIndex >= referenceInput.mediaIds.length) return;
    const mediaIds = [...referenceInput.mediaIds];
    [mediaIds[index], mediaIds[nextIndex]] = [mediaIds[nextIndex], mediaIds[index]];
    onChange({ ...value, input: { type: "referenceImages", mediaIds } });
  }

  const fixedModelName = selectedModel?.label
    ?? (kind === "image" ? "Seedream 5.0 Lite" : "Seedance 2.0 Mini");

  const formatControls = kind === "image" ? (
    <label>
      <span>图片规格</span>
      <select
        value={value.imageSize ?? "2K"}
        disabled={disabled}
        onChange={(event) => onChange({ ...value, imageSize: event.target.value })}
      >
        <option value="2K">2K</option>
        <option value="4K">4K</option>
      </select>
    </label>
  ) : (
    <>
      <label>
        <span>视频清晰度</span>
        <select
          value={value.videoResolution ?? "480p"}
          disabled={disabled}
          onChange={(event) => onChange({ ...value, videoResolution: event.target.value })}
        >
          <option value="480p">480p</option>
          <option value="720p">720p</option>
        </select>
      </label>
      <label>
        <span>时长（秒）</span>
        <input
          type="number"
          min={selectedModel?.minDurationSeconds ?? 4}
          max={selectedModel?.maxDurationSeconds ?? 15}
          value={value.durationSeconds ?? 4}
          disabled={disabled}
          onChange={(event) => onChange({ ...value, durationSeconds: Number(event.target.value) })}
        />
      </label>
      <label>
        <span>画幅</span>
        <select
          value={inputType === "firstLastFrames" ? "adaptive" : (value.videoRatio ?? "16:9")}
          disabled={disabled || inputType === "firstLastFrames"}
          onChange={(event) => onChange({ ...value, videoRatio: event.target.value })}
        >
          <option value="adaptive">自适应</option>
          <option value="16:9">16:9</option>
          <option value="9:16">9:16</option>
          <option value="1:1">1:1</option>
          <option value="4:3">4:3</option>
          <option value="3:4">3:4</option>
        </select>
      </label>
      <label className="generation-controls__check">
        <input
          type="checkbox"
          checked={value.generateAudio ?? false}
          disabled={disabled}
          onChange={(event) => onChange({ ...value, generateAudio: event.target.checked })}
        />
        同步生成声音
      </label>
    </>
  );

  const inputControls = (
    <>
      <fieldset disabled={disabled}>
        <legend>{kind === "video" ? "画面控制" : "参考图片"}</legend>
        <label><input type="radio" name={inputGroup} checked={inputType === "textOnly"} onChange={() => setInput("textOnly")} /> 仅使用提示词</label>
        {kind === "video" ? (
          <label><input type="radio" name={inputGroup} checked={inputType === "firstLastFrames"} disabled={!canUseFirstLast} onChange={() => setInput("firstLastFrames")} /> 锁定首帧 / 尾帧</label>
        ) : null}
        <label><input type="radio" name={inputGroup} checked={inputType === "referenceImages"} disabled={media.length === 0 || maxReferences === 0} onChange={() => setInput("referenceImages")} /> 使用参考关键帧</label>
      </fieldset>

      {firstLastInput ? (
        <div className="generation-controls__grid">
          <label>
            <span>首帧</span>
            <select value={firstLastInput.firstFrameMediaId} disabled={disabled} onChange={(event) => onChange({ ...value, input: { ...firstLastInput, firstFrameMediaId: event.target.value } })}>
              {media.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
            </select>
          </label>
          <label>
            <span>尾帧（可选）</span>
            <select value={firstLastInput.lastFrameMediaId ?? ""} disabled={disabled} onChange={(event) => onChange({ ...value, input: { ...firstLastInput, lastFrameMediaId: event.target.value || null } })}>
              <option value="">不指定</option>
              {media.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
            </select>
          </label>
        </div>
      ) : null}

      {referenceInput ? (
        <div className="generation-controls__references">
          {media.map((item) => (
            <label key={item.id}>
              <input
                type="checkbox"
                checked={referenceInput.mediaIds.includes(item.id)}
                disabled={disabled}
                onChange={(event) => toggleReference(item.id, event.target.checked)}
              />
              {item.name}
            </label>
          ))}
          {referenceInput.mediaIds.length > 0 ? (
            <ol className="generation-controls__reference-order" aria-label="参考图片顺序">
              {referenceInput.mediaIds.map((id, index) => (
                <li key={id}>
                  <span>图片 {index + 1} · {media.find((item) => item.id === id)?.name ?? id}</span>
                  <button type="button" disabled={disabled || index === 0} onClick={() => moveReference(index, -1)} aria-label={`上移图片 ${index + 1}`}>上移</button>
                  <button type="button" disabled={disabled || index === referenceInput.mediaIds.length - 1} onClick={() => moveReference(index, 1)} aria-label={`下移图片 ${index + 1}`}>下移</button>
                </li>
              ))}
            </ol>
          ) : null}
          <small>关键帧会作为 reference_image 发送；它与严格首尾帧模式互斥。最多 {maxReferences} 张。</small>
        </div>
      ) : null}
    </>
  );

  if (compact) {
    if (kind === "image") {
      return (
        <section className="generation-controls is-compact" aria-label="图片生成模型">
          <span className="generation-controls__fixed-model composer-runtime-model">{fixedModelName}</span>
          {catalogError ? <small className="generation-controls__hint">{catalogError}</small> : null}
        </section>
      );
    }
    return <VideoGenerationToolbar value={value} model={selectedModel} modelName={fixedModelName}
      media={media} canUseFirstLast={canUseFirstLast}
      canUseReferences={referenceMediaIds.length > 0 && maxReferences > 0}
      disabled={disabled} catalogError={catalogError} onChange={onChange}
      onSelectInput={setInput} />;
  }

  return (
    <section className="generation-controls" aria-label="生成设置">
      <div className="generation-controls__grid">
        <span className="generation-controls__fixed-model">{fixedModelName}</span>
        {formatControls}
      </div>
      {catalogError ? <small className="generation-controls__hint">{catalogError}</small> : null}
      {inputControls}
    </section>
  );
}

export function GenerationImageSizeControl({
  value,
  onChange,
  disabled = false,
}: Pick<GenerationControlsProps, "value" | "onChange" | "disabled">) {
  const sizes = ["2K", "4K"] as const;
  const selectedSize = value.imageSize === "4K" ? "4K" : "2K";
  const listboxId = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!open) return;
    const frame = requestAnimationFrame(() => optionRefs.current[sizes.indexOf(selectedSize)]?.focus());
    const onPointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener("pointerdown", onPointerDown);
    };
  }, [open, selectedSize]);

  useEffect(() => {
    if (disabled) setOpen(false);
  }, [disabled]);

  function choose(size: typeof sizes[number]) {
    onChange({ ...value, imageSize: size });
    setOpen(false);
    triggerRef.current?.focus();
  }

  function onOptionKeyDown(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    if (event.key === "Escape") {
      event.preventDefault();
      setOpen(false);
      triggerRef.current?.focus();
    } else if (event.key === "ArrowDown" || event.key === "ArrowUp" || event.key === "Home" || event.key === "End") {
      event.preventDefault();
      const nextIndex = event.key === "Home" ? 0 : event.key === "End" ? sizes.length - 1
        : (index + (event.key === "ArrowDown" ? 1 : -1) + sizes.length) % sizes.length;
      optionRefs.current[nextIndex]?.focus();
    }
  }

  return (
    <div className="generation-image-size" ref={rootRef}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node)) setOpen(false);
      }}>
      <button
        ref={triggerRef}
        type="button"
        className="generation-image-size__trigger"
        aria-label={`图片规格，当前 ${selectedSize}`}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listboxId : undefined}
        disabled={disabled}
        onClick={() => setOpen((current) => !current)}
        onKeyDown={(event) => {
          if (event.key === "Escape" && open) {
            event.preventDefault();
            setOpen(false);
          } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            setOpen(true);
          }
        }}
      >
        <span>{selectedSize}</span>
        <Icon name="chevron-down" />
      </button>
      {open ? (
        <div id={listboxId} className="generation-image-size__menu" role="listbox" aria-label="图片规格">
          {sizes.map((size, index) => (
            <button
              key={size}
              ref={(element) => { optionRefs.current[index] = element; }}
              type="button"
              role="option"
              aria-selected={size === selectedSize}
              onClick={() => choose(size)}
              onKeyDown={(event) => onOptionKeyDown(event, index)}
            >
              <span>{size}</span>
              {size === selectedSize ? <Icon name="check" /> : null}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
