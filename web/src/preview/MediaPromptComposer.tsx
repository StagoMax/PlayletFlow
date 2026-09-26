import { useId, useRef, useState } from "react";
import { ComposerDropOverlay } from "../composer/ComposerDropOverlay";
import { ComposerSources } from "../composer/ComposerSources";
import { ComposerToolbar } from "../composer/ComposerToolbar";
import { referenceMarker } from "../composer/assetMention";
import { composeSubmissionText } from "../composer/submission";
import type { ComposerAssetReference } from "../composer/types";
import { useAssetMention } from "../composer/useAssetMention";
import { useComposerAttachments } from "../composer/useComposerAttachments";
import { GenerationControls, type GenerationMediaOption, type GenerationModelLoader } from "../generation/GenerationControls";
import { createDefaultGenerationOptions } from "../generation/generationOptions";
import type { GenerationJob, GenerationOptions, MediaKind } from "../productApi/generated";
import type { FormEvent, KeyboardEvent } from "react";

type SubmissionState =
  | { status: "idle" }
  | { status: "submitting" }
  | { status: "success"; message: string }
  | { status: "error"; message: string };

type MediaPromptComposerProps = {
  initialPrompt: string;
  kind: MediaKind;
  media: GenerationMediaOption[];
  assets: readonly ComposerAssetReference[];
  loadModels: GenerationModelLoader;
  onGenerate: (
    prompt: string,
    generation: GenerationOptions,
    idempotencyKey: string,
  ) => Promise<GenerationJob>;
};

export function MediaPromptComposer({
  initialPrompt,
  kind,
  media,
  assets,
  loadModels,
  onGenerate,
}: MediaPromptComposerProps) {
  const inputId = useId();
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const idempotencyKey = useRef<string | null>(null);
  const [prompt, setPrompt] = useState(initialPrompt);
  const [references, setReferences] = useState<ComposerAssetReference[]>([]);
  const [generation, setGeneration] = useState(() => createDefaultGenerationOptions(kind));
  const [submission, setSubmission] = useState<SubmissionState>({ status: "idle" });
  const attachments = useComposerAttachments();
  const mediaLabel = kind === "video" ? "视频" : "图片";
  const isSubmitting = submission.status === "submitting";
  const hasValidInputs = generation.input?.type !== "referenceImages"
    || generation.input.mediaIds.length > 0;
  const canSubmit = prompt.trim().length > 0 && hasValidInputs && !isSubmitting;

  const mentions = useAssetMention({
    value: prompt,
    assets,
    textareaRef,
    onChange: (value) => {
      setPrompt(value);
      resetIntent();
    },
    onReference: (asset) => {
      setReferences((current) => current.some((item) => item.id === asset.id) ? current : [...current, asset]);
      const mediaId = asset.mediaId;
      if (asset.kind === "image" && mediaId) {
        setGeneration((current) => current.input?.type === "firstLastFrames"
          ? current
          : {
              ...current,
              input: {
                type: "referenceImages",
                mediaIds: [...new Set([
                  ...(current.input?.type === "referenceImages" ? current.input.mediaIds : []),
                  mediaId,
                ])],
              },
            });
      }
    },
  });

  function resetIntent() {
    idempotencyKey.current = null;
    if (submission.status !== "idle") setSubmission({ status: "idle" });
  }

  function removeReference(id: string) {
    const reference = references.find((item) => item.id === id);
    setReferences((current) => current.filter((item) => item.id !== id));
    if (!reference) return;
    setPrompt((current) => current.replaceAll(referenceMarker(reference), "").replace(/ {2,}/gu, " "));
    if (reference.mediaId) {
      setGeneration((current) => {
        if (current.input?.type !== "referenceImages") return current;
        const mediaIds = current.input.mediaIds.filter((mediaId) => mediaId !== reference.mediaId);
        return { ...current, input: mediaIds.length > 0 ? { type: "referenceImages", mediaIds } : { type: "textOnly" } };
      });
    }
    resetIntent();
  }

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const nextPrompt = prompt.trim();
    if (!nextPrompt || isSubmitting) return;
    const requestKey = idempotencyKey.current ?? crypto.randomUUID();
    idempotencyKey.current = requestKey;
    setSubmission({ status: "submitting" });
    try {
      await onGenerate(
        composeSubmissionText(nextPrompt, references, attachments.attachments),
        generation,
        requestKey,
      );
      idempotencyKey.current = null;
      setPrompt(nextPrompt);
      setReferences([]);
      attachments.clearAttachments();
      mentions.close();
      setSubmission({ status: "success", message: `${mediaLabel}生成任务已提交` });
    } catch (error) {
      setSubmission({
        status: "error",
        message: error instanceof Error ? error.message : "生成任务提交失败，请稍后重试。",
      });
    }
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.nativeEvent.isComposing || mentions.onKeyDown(event)) return;
    if (event.key !== "Enter" || event.shiftKey) return;
    event.preventDefault();
    event.currentTarget.form?.requestSubmit();
  };

  return (
    <form
      className="media-prompt-composer composer-focus-surface"
      aria-label={`${mediaLabel}生成提示词编辑器`}
      {...attachments.dragHandlers}
      onSubmit={submit}
    >
      {attachments.dragging ? <ComposerDropOverlay /> : null}
      <input
        ref={attachments.inputRef}
        type="file"
        accept="image/*,video/*,text/*,.md,.markdown,.json,.csv,.tsv,.srt,.vtt"
        multiple
        hidden
        onChange={(event) => {
          void attachments.addFiles(Array.from(event.target.files ?? []));
          event.target.value = "";
        }}
      />
      <label className="sr-only" htmlFor={inputId}>生成提示词</label>
      <ComposerSources
        references={references}
        attachments={attachments.attachments}
        onRemoveReference={removeReference}
        onRemoveAttachment={attachments.removeAttachment}
      />
      {attachments.error ? <p role="alert" className="shared-composer-error">{attachments.error}</p> : null}
      <div className="media-prompt-composer-input">
        <textarea
          ref={textareaRef}
          id={inputId}
          placeholder={`描述你想生成的${mediaLabel}…`}
          value={prompt}
          rows={4}
          maxLength={10_000}
          disabled={isSubmitting}
          aria-describedby={`${inputId}-status`}
          aria-autocomplete="list"
          aria-expanded={mentions.isOpen}
          aria-controls={mentions.isOpen ? mentions.listboxId : undefined}
          onChange={(event) => {
            const next = event.target.value;
            setPrompt(next);
            setReferences((current) => current.filter((reference) => next.includes(referenceMarker(reference))));
            mentions.onTextChange(next, event.target.selectionStart);
            resetIntent();
          }}
          onKeyDown={onKeyDown}
        />
      </div>
      {mentions.menu}
      <ComposerToolbar
        onAttach={attachments.openFilePicker}
        onMention={mentions.openAtCaret}
        controls={(
          <GenerationControls
            compact
            loadModels={loadModels}
            kind={kind}
            media={media}
            value={generation}
            onChange={(next) => {
              setGeneration(next);
              resetIntent();
            }}
            disabled={isSubmitting}
          />
        )}
        action={{
          type: "submit",
          icon: "send",
          label: `发送并生成${mediaLabel}`,
          disabled: !canSubmit,
        }}
      />
      <div className="media-prompt-composer-meta">
        <span
          id={`${inputId}-status`}
          className={`media-prompt-composer-status is-${submission.status}`}
          role={submission.status === "error" ? "alert" : "status"}
        >
          {submission.status === "submitting"
            ? `正在提交${mediaLabel}生成…`
            : submission.status === "success" || submission.status === "error"
              ? submission.message
              : ""}
        </span>
      </div>
    </form>
  );
}
