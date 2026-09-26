import { useEffect, useId, useState } from "react";
import { ComposerModelPicker } from "../composer/ComposerModelPicker";
import type {
  GenerationInputSelection,
  GenerationModel,
  GenerationOptions,
  MediaKind,
} from "../productApi/generated";
import { Icon } from "../workspace/Icons";
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
  value: GenerationOptions;
  onChange: (value: GenerationOptions) => void;
  disabled?: boolean;
  compact?: boolean;
};

export function GenerationControls({
  loadModels,
  kind,
  media,
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

  const selectedModel = models.find((model) => model.id === value.model);
  const inputType = value.input?.type ?? "textOnly";
  const firstLastInput = value.input?.type === "firstLastFrames" ? value.input : null;
  const referenceInput = value.input?.type === "referenceImages" ? value.input : null;
  const canUseFirstLast = kind === "video"
    && (selectedModel?.supportsFirstLastFrames ?? true)
    && media.length > 0;
  const maxReferences = selectedModel?.maxReferenceImages ?? (kind === "video" ? 30 : 14);

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
    const first = media[0]?.id;
    if (first) onChange({ ...value, input: { type, mediaIds: [first] } });
  }

  function toggleReference(mediaId: string, checked: boolean) {
    const current = referenceInput?.mediaIds ?? [];
    const mediaIds = checked
      ? [...current, mediaId].slice(0, maxReferences)
      : current.filter((id) => id !== mediaId);
    onChange({ ...value, input: { type: "referenceImages", mediaIds } });
  }

  function selectModel(modelId: string | null) {
    const model = models.find((item) => item.id === modelId);
    const incompatibleFirstLast = inputType === "firstLastFrames" && model?.supportsFirstLastFrames === false;
    const incompatibleReferences = inputType === "referenceImages" && model?.maxReferenceImages === 0;
    onChange({
      ...value,
      model: modelId,
      input: incompatibleFirstLast || incompatibleReferences ? { type: "textOnly" } : value.input,
    });
  }

  const modelPicker = (
    <ComposerModelPicker
      ariaLabel={`选择${kind === "image" ? "图片" : "视频"}生成模型`}
      options={models.map((model) => ({
        id: model.id,
        label: model.label,
        description: kind === "image"
          ? `最多 ${model.maxReferenceImages} 张参考图`
          : `${model.minDurationSeconds ?? 4}–${model.maxDurationSeconds ?? 30} 秒`,
      }))}
      value={value.model ?? null}
      emptyLabel="自动选择推荐模型"
      onChange={selectModel}
      disabled={disabled}
    />
  );

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
          <option value="1080p">1080p</option>
        </select>
      </label>
      <label>
        <span>时长（秒）</span>
        <input
          type="number"
          min={selectedModel?.minDurationSeconds ?? 4}
          max={selectedModel?.maxDurationSeconds ?? 30}
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
          <small>关键帧会作为 reference_image 发送；它与严格首尾帧模式互斥。最多 {maxReferences} 张。</small>
        </div>
      ) : null}
    </>
  );

  if (compact) {
    return (
      <section className="generation-controls is-compact" aria-label="生成设置">
        {modelPicker}
        <details className="generation-controls__disclosure">
          <summary aria-label="打开生成设置" title="生成设置">
            <Icon name="more" />
            <span>设置</span>
          </summary>
          <div className="generation-controls__panel">
            <div className="generation-controls__grid">{formatControls}</div>
            {inputControls}
          </div>
        </details>
        {catalogError ? <small className="generation-controls__hint">{catalogError}</small> : null}
      </section>
    );
  }

  return (
    <section className="generation-controls" aria-label="生成设置">
      <div className="generation-controls__grid">
        <div className="generation-controls__model">
          <span>生成模型</span>
          {modelPicker}
        </div>
        {formatControls}
      </div>
      {catalogError ? <small className="generation-controls__hint">{catalogError}</small> : null}
      {inputControls}
    </section>
  );
}
