import { useEffect, useId, useMemo, useRef, useState } from "react";
import { ComposerDropOverlay } from "../composer/ComposerDropOverlay";
import { ComposerSources } from "../composer/ComposerSources";
import { ComposerToolbar } from "../composer/ComposerToolbar";
import { referenceMarker } from "../composer/assetMention";
import { InlineReferenceEditor } from "../composer/InlineReferenceEditor";
import { inlineReferenceSegments, removeInlineReference } from "../composer/inlineReferences";
import { composeSubmissionText } from "../composer/submission";
import type { ComposerAssetReference } from "../composer/types";
import { useAssetMention } from "../composer/useAssetMention";
import { useComposerAttachments } from "../composer/useComposerAttachments";
import { GenerationControls, GenerationImageSizeControl, type GenerationMediaOption, type GenerationModelLoader } from "../generation/GenerationControls";
import { createDefaultGenerationOptions, imageGenerationInput, type GenerationImageFile } from "../generation/generationOptions";
import type { GenerationInputSelection, GenerationJob, GenerationOptions, MediaKind } from "../productApi/generated";
import type { FormEvent, KeyboardEvent } from "react";
import { inferMediaPromptReferences, parseMediaPromptDraft, reconcileMediaPromptReferences, restoreGenerationInputReferences, sameMediaPromptDraft } from "./mediaPromptDraft";
import { loadMediaPromptDraft, saveMediaPromptDraft } from "./mediaPromptDraftStore";
import "./videoPromptComposer.css";

export type MediaSubmissionState =
  | { status: "idle" }
  | { status: "submitting" }
  | { status: "success"; message: string }
  | { status: "error"; message: string };

export type MediaPromptComposerProps = {
  initialPrompt: string;
  initialGenerationInput?: GenerationInputSelection | null;
  draftKey?: string;
  kind: MediaKind;
  media: GenerationMediaOption[];
  assets: readonly ComposerAssetReference[];
  loadModels: GenerationModelLoader;
  onSubmissionChange?: (state: MediaSubmissionState) => void;
  onUndoPrompt?: () => Promise<void>;
  onGenerate: (
    prompt: string,
    generation: GenerationOptions,
    idempotencyKey: string,
    imageFiles: readonly GenerationImageFile[],
  ) => Promise<GenerationJob>;
};

export function synchronizePromptDraft(
  currentDraft: string,
  previousInitialPrompt: string,
  nextInitialPrompt: string,
) {
  return currentDraft === previousInitialPrompt ? nextInitialPrompt : currentDraft;
}

export function MediaPromptComposer({
  initialPrompt,
  initialGenerationInput = null,
  draftKey,
  kind,
  media,
  assets,
  loadModels,
  onSubmissionChange,
  onUndoPrompt,
  onGenerate,
}: MediaPromptComposerProps) {
  const inputId = useId();
  const editorRef = useRef<HTMLDivElement>(null);
  const idempotencyKey = useRef<string | null>(null);
  const [draft, setDraft] = useState(() => loadMediaPromptDraft(draftKey, initialPrompt));
  const initialDraft = useMemo(() => restoreGenerationInputReferences(initialPrompt, initialGenerationInput, assets),
    [assets, initialGenerationInput, initialPrompt]);
  const previousInitialDraft = useRef(initialDraft);
  useEffect(() => {
    const previous = previousInitialDraft.current;
    if (sameMediaPromptDraft(previous, initialDraft)) return;
    previousInitialDraft.current = initialDraft;
    setDraft((current) => sameMediaPromptDraft(current, previous) ? initialDraft : current);
  }, [initialDraft]);
  useEffect(() => saveMediaPromptDraft(draftKey, initialPrompt, draft, initialDraft),
    [draft, draftKey, initialDraft, initialPrompt]);
  const prompt = draft.text;
  const savedReferences = useMemo(() => reconcileMediaPromptReferences(draft.references, assets), [assets, draft.references]);
  useEffect(() => {
    if (savedReferences === draft.references) return;
    setDraft((current) => {
      const next = reconcileMediaPromptReferences(current.references, assets);
      return next === current.references ? current : { ...current, references: next };
    });
  }, [assets, draft.references, savedReferences]);
  const resolvedSavedReferences = useMemo(() => {
    const byId = new Map(assets.map((asset) => [asset.id, asset]));
    return savedReferences.flatMap((saved) => {
      const asset = byId.get(saved.id);
      return asset && asset.kind === saved.kind
        ? [{ ...asset, name: saved.name }]
        : [];
    });
  }, [assets, savedReferences]);
  const references = useMemo(() => {
    const seen = new Set(resolvedSavedReferences.map((reference) => reference.id));
    return [
      ...resolvedSavedReferences,
      ...inferMediaPromptReferences(prompt, assets).filter((reference) => !seen.has(reference.id)),
    ];
  }, [assets, prompt, resolvedSavedReferences]);
  const missingReferences = savedReferences.length !== resolvedSavedReferences.length;
  const [generation, setGeneration] = useState(() => createDefaultGenerationOptions(kind));
  const [useLatestInput, setUseLatestInput] = useState(false);
  const generationInputEdited = useRef(false);
  useEffect(() => {
    if (!initialGenerationInput || generationInputEdited.current) return;
    setGeneration((current) => ({ ...current, input: initialGenerationInput }));
    setUseLatestInput(true);
  }, [initialGenerationInput]);
  const [submission, setSubmission] = useState<MediaSubmissionState>({ status: "idle" });
  const [undoing, setUndoing] = useState(false);
  const [canUndoLocalEdit, setCanUndoLocalEdit] = useState(false);
  const [undoError, setUndoError] = useState("");
  const attachments = useComposerAttachments();
  const mediaLabel = kind === "video" ? "视频" : "图片";
  const isSubmitting = submission.status === "submitting";
  const referencedImageIds = [...new Set(inlineReferenceSegments(prompt, references).flatMap((segment) =>
    segment.type === "reference" && segment.reference.kind === "image" && segment.reference.mediaId
      ? [segment.reference.mediaId]
      : []))];
  const currentGeneration: GenerationOptions = kind === "video" && !useLatestInput && generation.input?.type !== "firstLastFrames"
    ? { ...generation, input: referencedImageIds.length > 0
      ? { type: "referenceImages", mediaIds: referencedImageIds }
      : { type: "textOnly" } }
    : generation;
  const canSubmit = prompt.trim().length > 0 && !missingReferences && !isSubmitting;
  const selectedMediaIds = currentGeneration.input?.type === "referenceImages"
    ? currentGeneration.input.mediaIds
    : currentGeneration.input?.type === "firstLastFrames"
      ? [currentGeneration.input.firstFrameMediaId, currentGeneration.input.lastFrameMediaId].filter((id): id is string => Boolean(id))
      : [];
  const isPristine = sameMediaPromptDraft(draft, initialDraft);

  function reportSubmission(state: MediaSubmissionState) {
    setSubmission(state);
    onSubmissionChange?.(state);
  }

  const mentions = useAssetMention({
    value: prompt,
    assets,
    references,
    editorRef,
    onChange: (value) => {
      setDraft((current) => ({ ...current, text: value }));
      resetIntent();
    },
    onReference: (asset) => {
      generationInputEdited.current = true;
      setUseLatestInput(false);
      setDraft((current) => current.references.some((item) => item.id === asset.id)
        ? current
        : { ...current, references: [...current.references, { id: asset.id, name: asset.name, kind: asset.kind }] });
    },
  });

  function resetIntent() {
    idempotencyKey.current = null;
    setUndoError("");
    if (submission.status !== "idle") setSubmission({ status: "idle" });
  }

  function removeGenerationMedia(mediaIdsToRemove: readonly string[]) {
    if (mediaIdsToRemove.length === 0) return;
    generationInputEdited.current = true;
    setGeneration((current) => {
      if (current.input?.type === "firstLastFrames") {
        if (mediaIdsToRemove.includes(current.input.firstFrameMediaId)) {
          return { ...current, input: { type: "textOnly" } };
        }
        if (current.input.lastFrameMediaId && mediaIdsToRemove.includes(current.input.lastFrameMediaId)) {
          return { ...current, input: { ...current.input, lastFrameMediaId: null } };
        }
      }
      if (current.input?.type === "referenceImages") {
        const mediaIds = current.input.mediaIds.filter((id) => !mediaIdsToRemove.includes(id));
        return { ...current, input: mediaIds.length > 0
          ? { type: "referenceImages", mediaIds }
          : { type: "textOnly" } };
      }
      return current;
    });
  }

  function retainPromptReferences(
    nextPrompt: string,
    removedReferenceId?: string,
    restoredReferences?: readonly ComposerAssetReference[],
  ) {
    const previousImageIds = referencedImageIds;
    const nextImageIds = [...new Set(inlineReferenceSegments(nextPrompt, references).flatMap((segment) =>
      segment.type === "reference" && segment.reference.kind === "image" && segment.reference.mediaId
        ? [segment.reference.mediaId] : []))];
    if (previousImageIds.join("\u0000") !== nextImageIds.join("\u0000")) {
      generationInputEdited.current = true;
      setUseLatestInput(false);
    }
    const removedMediaIds = references
      .filter((reference) => reference.id === removedReferenceId || !nextPrompt.includes(referenceMarker(reference)))
      .flatMap((reference) => reference.mediaId ? [reference.mediaId] : []);
    setDraft((current) => ({
      text: nextPrompt,
      references: (restoredReferences?.map(({ id, name, kind }) => ({ id, name, kind })) ?? current.references).filter((reference) =>
        reference.id !== removedReferenceId && nextPrompt.includes(referenceMarker(reference))),
    }));
    removeGenerationMedia(removedMediaIds);
  }

  function removeReference(id: string) {
    retainPromptReferences(removeInlineReference(prompt, references, id), id);
    mentions.close();
    resetIntent();
  }

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const nextPrompt = prompt.trim();
    if (!nextPrompt || isSubmitting) return;
    if (missingReferences) {
      reportSubmission({ status: "error", message: "引用的素材已不可用，请移除或重新选择。" });
      return;
    }
    const imageFiles = kind === "image"
      ? attachments.attachments.filter((item) => item.kind === "image")
        .map((item) => ({ id: item.id, file: item.file }))
      : [];
    let nextGeneration = currentGeneration;
    if (kind === "image") {
      try {
        const selectedImageIds = useLatestInput && generation.input?.type === "referenceImages"
          ? generation.input.mediaIds
          : references.filter((item) => item.kind === "image").map((item) => item.mediaId);
        if (selectedImageIds.some((id) => !id || !media.some((option) => option.id === id))) {
          throw new Error("引用的图片尚未就绪，请选择可用图片。");
        }
        const input = imageGenerationInput(
          selectedImageIds as string[],
          imageFiles,
        );
        nextGeneration = { ...generation, input };
      } catch (error) {
        reportSubmission({ status: "error", message: error instanceof Error ? error.message : "参考图片不可用。" });
        return;
      }
    }
    if (kind === "video" && nextGeneration.input?.type !== "firstLastFrames") {
      const referencedImages = references.filter((item) => item.kind === "image");
      if (referencedImages.some((item) => !item.mediaId || !media.some((option) => option.id === item.mediaId))) {
        reportSubmission({ status: "error", message: "引用的图片尚未就绪，请选择可用图片。" });
        return;
      }
    }
    const requestKey = idempotencyKey.current ?? crypto.randomUUID();
    idempotencyKey.current = requestKey;
    reportSubmission({ status: "submitting" });
    try {
      const submittedPrompt = composeSubmissionText(nextPrompt, references, attachments.attachments);
      await onGenerate(
        submittedPrompt,
        nextGeneration,
        requestKey,
        imageFiles,
      );
      idempotencyKey.current = null;
      setDraft(parseMediaPromptDraft(submittedPrompt));
      if (kind === "video") {
        attachments.clearAttachments();
      }
      mentions.close();
      reportSubmission({ status: "success", message: `${mediaLabel}生成任务已提交` });
    } catch (error) {
      reportSubmission({
        status: "error",
        message: error instanceof Error ? error.message : "生成任务提交失败，请稍后重试。",
      });
    }
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.nativeEvent.isComposing) return;
    if (event.key.toLowerCase() === "z" && (event.ctrlKey || event.metaKey) && !event.shiftKey
      && isPristine && !canUndoLocalEdit && onUndoPrompt && !undoing) {
      event.preventDefault();
      setUndoing(true);
      setUndoError("");
      void onUndoPrompt()
        .catch((cause: unknown) => setUndoError(cause instanceof Error ? cause.message : "无法撤销提示词。"))
        .finally(() => setUndoing(false));
      return;
    }
    if (mentions.onKeyDown(event)) return;
    if (event.key !== "Enter" || event.shiftKey) return;
    if (kind === "video" && !event.ctrlKey && !event.metaKey) return;
    event.preventDefault();
    event.currentTarget.closest("form")?.requestSubmit();
  };

  return (
    <form
      className={`media-prompt-composer composer-surface composer-focus-surface${kind === "video" ? " is-video" : ""}`}
      aria-label={`${mediaLabel}生成提示词编辑器`}
      {...attachments.dragHandlers}
      onDrop={(event) => {
        attachments.dragHandlers.onDrop(event);
        resetIntent();
      }}
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
          resetIntent();
          void attachments.addFiles(Array.from(event.target.files ?? []));
          event.target.value = "";
        }}
      />
      <ComposerSources
        attachments={attachments.attachments}
        references={references}
        assets={assets}
        selectedMediaIds={selectedMediaIds}
        showAddControl={kind === "video"}
        onAddAsset={() => mentions.openAtCaret(kind === "video" ? "image" : "all")}
        onAttach={attachments.openFilePicker}
        disabled={isSubmitting}
        onRemoveReference={removeReference}
        onRemoveSelectedMedia={(mediaId) => {
          generationInputEdited.current = true;
          removeGenerationMedia([mediaId]);
          resetIntent();
        }}
        onRemoveAttachment={(id) => {
          attachments.removeAttachment(id);
          resetIntent();
        }}
      />
      {attachments.error ? <p role="alert" className="shared-composer-error">{attachments.error}</p> : null}
      {undoError ? <p role="alert" className="shared-composer-error">{undoError}</p> : null}
      {missingReferences ? <p role="alert" className="shared-composer-error">引用的素材已不可用，请移除或重新选择。</p> : null}
      <div className="media-prompt-composer-input">
        <InlineReferenceEditor
          editorRef={editorRef}
          id={inputId}
          placeholder={`描述你想生成的${mediaLabel}…`}
          value={prompt}
          references={references}
          maxLength={10_000}
          disabled={isSubmitting}
          ariaLabel="生成提示词"
          ariaDescribedBy={onSubmissionChange ? undefined : `${inputId}-status`}
          ariaExpanded={mentions.isOpen}
          ariaControls={mentions.isOpen ? mentions.listboxId : undefined}
          onChange={(next, caret, restoredReferences) => {
            retainPromptReferences(next, undefined, restoredReferences);
            mentions.onTextChange(next, caret);
            resetIntent();
          }}
          onKeyDown={onKeyDown}
          onHistoryChange={setCanUndoLocalEdit}
        />
      </div>
      {mentions.menu}
      <ComposerToolbar
        onAttach={kind === "image" ? attachments.openFilePicker : undefined}
        onMention={mentions.openAtCaret}
        leadingControls={kind === "image" ? (
          <GenerationImageSizeControl
            value={currentGeneration}
            onChange={(next) => {
              if (JSON.stringify(next.input) !== JSON.stringify(currentGeneration.input)) generationInputEdited.current = true;
              setGeneration(next);
              resetIntent();
            }}
            disabled={isSubmitting}
          />
        ) : (
          <GenerationControls
            compact
            loadModels={loadModels}
            kind={kind}
            media={media}
            referenceMediaIds={referencedImageIds}
            value={currentGeneration}
            onChange={(next) => {
              setGeneration(next);
              resetIntent();
            }}
            disabled={isSubmitting}
          />
        )}
        controls={kind === "image" ? (
          <GenerationControls compact loadModels={loadModels} kind={kind} media={media}
            value={generation} onChange={(next) => {
              if (JSON.stringify(next.input) !== JSON.stringify(generation.input)) generationInputEdited.current = true;
              setGeneration(next);
              resetIntent();
            }}
            disabled={isSubmitting} />
        ) : undefined}
        action={{
          type: "submit",
          icon: kind === "video" ? "arrow-up" : "send",
          label: `发送并生成${mediaLabel}`,
          title: kind === "video" ? "发送并生成视频（Ctrl/⌘+Enter）" : undefined,
          disabled: !canSubmit,
        }}
      />
      {!onSubmissionChange ? <div className="media-prompt-composer-meta">
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
      </div> : null}
    </form>
  );
}
