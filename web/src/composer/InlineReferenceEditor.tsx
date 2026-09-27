import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ClipboardEvent,
  type KeyboardEvent,
  type PointerEvent,
  type RefObject,
} from "react";
import { HoverPreviewPortal } from "../preview/HoverPreview";
import {
  editorSelection,
  focusEditorAt,
  readEditorValue,
  replaceEditorSelection,
} from "./contentEditableSelection";
import { inlineReferenceSegments, type InlineReferenceSegment } from "./inlineReferences";
import type { ComposerAssetReference } from "./types";

type InlineReferenceEditorProps = {
  editorRef: RefObject<HTMLDivElement | null>;
  id: string;
  value: string;
  references: readonly ComposerAssetReference[];
  placeholder: string;
  ariaLabel: string;
  ariaDescribedBy?: string;
  ariaControls?: string;
  ariaExpanded?: boolean;
  disabled?: boolean;
  maxLength?: number;
  onChange: (value: string, caret: number, restoredReferences?: readonly ComposerAssetReference[]) => void;
  onHistoryChange?: (canUndo: boolean) => void;
  onKeyDown?: (event: KeyboardEvent<HTMLDivElement>) => void;
};

type ActivePreview = {
  reference: ComposerAssetReference;
  anchor: HTMLElement;
};

type EditorSnapshot = { value: string; caret: number; references: readonly ComposerAssetReference[] };

const PREVIEW_OPEN_DELAY_MS = 180;
const PREVIEW_CLOSE_DELAY_MS = 120;

export function InlineReferenceEditor({
  editorRef,
  id,
  value,
  references,
  placeholder,
  ariaLabel,
  ariaDescribedBy,
  ariaControls,
  ariaExpanded,
  disabled = false,
  maxLength,
  onChange,
  onHistoryChange,
  onKeyDown,
}: InlineReferenceEditorProps) {
  const composing = useRef(false);
  const pendingCaret = useRef<number | null>(null);
  const previewOpenTimer = useRef<number | null>(null);
  const previewCloseTimer = useRef<number | null>(null);
  const [renderRevision, setRenderRevision] = useState(0);
  const [activePreview, setActivePreview] = useState<ActivePreview | null>(null);
  const history = useRef<{ current: EditorSnapshot; undo: EditorSnapshot[]; redo: EditorSnapshot[] }>({
    current: { value, caret: value.length, references }, undo: [], redo: [],
  });
  const segments = useMemo(() => inlineReferenceSegments(value, references), [references, value]);
  const renderSignature = useMemo(() => editorRenderSignature(value, segments), [segments, value]);

  useLayoutEffect(() => {
    const editor = editorRef.current;
    if (!editor) return;
    if (history.current.current.value !== value) {
      history.current = { current: { value, caret: value.length, references }, undo: [], redo: [] };
      onHistoryChange?.(false);
    } else {
      history.current.current.references = references;
    }
    const restoreCaret = pendingCaret.current ?? (
      document.activeElement === editor ? editorSelection(editor).start : null
    );
    if (editor.dataset.renderSignature !== renderSignature || readEditorValue(editor) !== value) {
      renderEditorContent(editor, segments);
      editor.dataset.renderSignature = renderSignature;
    }
    if (restoreCaret !== null && document.activeElement === editor) {
      focusEditorAt(editor, Math.min(restoreCaret, value.length));
    }
    pendingCaret.current = null;
  }, [editorRef, renderRevision, renderSignature, segments, value]);

  const clearPreviewTimers = useCallback(() => {
    if (previewOpenTimer.current !== null) window.clearTimeout(previewOpenTimer.current);
    if (previewCloseTimer.current !== null) window.clearTimeout(previewCloseTimer.current);
    previewOpenTimer.current = null;
    previewCloseTimer.current = null;
  }, []);

  useEffect(() => clearPreviewTimers, [clearPreviewTimers]);

  const commitChange = (nextValue: string, caret: number) => {
    const editHistory = history.current;
    if (nextValue !== editHistory.current.value) {
      editHistory.undo.push(editHistory.current);
      if (editHistory.undo.length > 100) editHistory.undo.shift();
      editHistory.redo = [];
      editHistory.current = { value: nextValue, caret, references };
      onHistoryChange?.(true);
    }
    pendingCaret.current = caret;
    onChange(nextValue, caret);
    setRenderRevision((current) => current + 1);
  };

  const emitDomChange = () => {
    const editor = editorRef.current;
    if (!editor) return;
    const selection = editorSelection(editor);
    const rawValue = readEditorValue(editor);
    const nextValue = maxLength === undefined ? rawValue : rawValue.slice(0, maxLength);
    commitChange(nextValue, Math.min(selection.start, nextValue.length));
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    onKeyDown?.(event);
    if (event.defaultPrevented || event.nativeEvent.isComposing) return;

    if (event.ctrlKey || event.metaKey) {
      const key = event.key.toLowerCase();
      const direction = key === "z" ? (event.shiftKey ? "redo" : "undo")
        : key === "y" && !event.shiftKey ? "redo" : null;
      if (direction && restoreHistory(direction)) {
        event.preventDefault();
        return;
      }
    }

    const editor = editorRef.current;
    if (!editor) return;
    const selection = editorSelection(editor);
    if (selection.start === selection.end && (event.key === "Backspace" || event.key === "Delete")) {
      const adjacent = segments.find((segment) => segment.type === "reference" && (
        (event.key === "Backspace" && segment.end === selection.start)
        || (event.key === "Delete" && segment.start === selection.start)
      ));
      if (adjacent?.type === "reference") {
        event.preventDefault();
        commitChange(`${value.slice(0, adjacent.start)}${value.slice(adjacent.end)}`, adjacent.start);
        return;
      }
    }

    if (event.key === "Enter" && event.shiftKey) {
      event.preventDefault();
      replaceEditorSelection(editor, "\n");
      emitDomChange();
    }
  };

  const handlePaste = (event: ClipboardEvent<HTMLDivElement>) => {
    event.preventDefault();
    replaceEditorSelection(event.currentTarget, event.clipboardData.getData("text/plain"));
    emitDomChange();
  };

  const restoreHistory = (direction: "undo" | "redo") => {
    const editHistory = history.current;
    const source = direction === "undo" ? editHistory.undo : editHistory.redo;
    const target = source.pop();
    if (!target) return false;
    (direction === "undo" ? editHistory.redo : editHistory.undo).push(editHistory.current);
    editHistory.current = target;
    onHistoryChange?.(editHistory.undo.length > 0);
    pendingCaret.current = target.caret;
    onChange(target.value, target.caret, target.references);
    setRenderRevision((current) => current + 1);
    return true;
  };

  const handlePointerOver = (event: PointerEvent<HTMLDivElement>) => {
    if (event.pointerType === "touch") return;
    if (window.matchMedia?.("(hover: hover) and (pointer: fine)").matches === false) return;
    const anchor = closestReference(event.target, event.currentTarget);
    if (!anchor || movedWithin(anchor, event.relatedTarget)) return;
    const reference = references.find((item) => item.id === anchor.dataset.referenceId);
    if (!reference?.previewMedia) return;
    clearPreviewTimers();
    previewOpenTimer.current = window.setTimeout(() => {
      previewOpenTimer.current = null;
      setActivePreview({ reference, anchor });
    }, PREVIEW_OPEN_DELAY_MS);
  };

  const handlePointerOut = (event: PointerEvent<HTMLDivElement>) => {
    const anchor = closestReference(event.target, event.currentTarget);
    if (!anchor || movedWithin(anchor, event.relatedTarget)) return;
    clearPreviewTimers();
    previewCloseTimer.current = window.setTimeout(() => {
      previewCloseTimer.current = null;
      setActivePreview(null);
    }, PREVIEW_CLOSE_DELAY_MS);
  };

  return (
    <>
      <div
        ref={editorRef}
        id={id}
        className={`inline-reference-editor${disabled ? " is-disabled" : ""}`}
        role="textbox"
        aria-label={ariaLabel}
        aria-multiline="true"
        aria-autocomplete="list"
        aria-expanded={ariaExpanded}
        aria-controls={ariaControls}
        aria-describedby={ariaDescribedBy}
        aria-disabled={disabled || undefined}
        data-placeholder={placeholder}
        data-empty={value.length === 0 ? "true" : "false"}
        contentEditable={disabled ? false : "plaintext-only"}
        spellCheck
        onInput={() => { if (!composing.current) emitDomChange(); }}
        onBeforeInput={(event) => {
          const inputType = (event.nativeEvent as InputEvent).inputType;
          if (inputType !== "historyUndo" && inputType !== "historyRedo") return;
          if (restoreHistory(inputType === "historyUndo" ? "undo" : "redo")) event.preventDefault();
        }}
        onCompositionStart={() => { composing.current = true; }}
        onCompositionEnd={() => {
          composing.current = false;
          emitDomChange();
        }}
        onKeyDown={handleKeyDown}
        onPaste={handlePaste}
        onPointerOver={handlePointerOver}
        onPointerOut={handlePointerOut}
      />
      {activePreview?.reference.previewMedia ? (
        <HoverPreviewPortal
          item={{ name: activePreview.reference.name, media: activePreview.reference.previewMedia }}
          anchor={activePreview.anchor}
          placement="top"
        />
      ) : null}
    </>
  );
}

function renderEditorContent(editor: HTMLDivElement, segments: readonly InlineReferenceSegment[]) {
  const content = document.createDocumentFragment();
  for (const segment of segments) {
    if (segment.type === "text") {
      content.append(document.createTextNode(segment.text));
      continue;
    }
    content.append(createReferenceToken(segment));
  }
  editor.replaceChildren(content);
}

function createReferenceToken(segment: Extract<InlineReferenceSegment, { type: "reference" }>) {
  const { reference, marker } = segment;
  const atomic = document.createElement("span");
  atomic.className = "inline-reference-atomic";
  atomic.dataset.referenceMarker = marker;
  atomic.dataset.referenceId = reference.id;
  atomic.contentEditable = "false";
  atomic.setAttribute("role", "img");
  atomic.setAttribute("aria-label", `引用素材：${reference.name}`);
  atomic.title = reference.name;

  const token = document.createElement("span");
  token.className = "inline-reference-token";
  const preview = createReferencePreview(reference);
  const label = document.createElement("span");
  label.className = "inline-reference-token__label";
  label.textContent = reference.name;
  label.setAttribute("aria-hidden", "true");
  token.append(preview, label);
  atomic.append(token);
  return atomic;
}

function createReferencePreview(reference: ComposerAssetReference) {
  if (reference.thumbnailUrl && (reference.kind === "image" || reference.kind === "video")) {
    const image = document.createElement("img");
    image.className = "inline-reference-token__preview";
    image.src = reference.thumbnailUrl;
    image.alt = "";
    image.width = 22;
    image.height = 22;
    image.decoding = "async";
    image.draggable = false;
    return image;
  }
  const fallback = document.createElement("span");
  fallback.className = `inline-reference-token__preview is-${reference.kind}`;
  fallback.textContent = reference.kind === "image" ? "图" : reference.kind === "video" ? "视" : "文";
  fallback.setAttribute("aria-hidden", "true");
  return fallback;
}

function editorRenderSignature(value: string, segments: readonly InlineReferenceSegment[]) {
  const references = segments.flatMap((segment) => segment.type === "reference"
    ? [`${segment.start}:${segment.reference.id}:${segment.reference.thumbnailUrl ?? ""}`]
    : []);
  return `${value}\u0000${references.join("|")}`;
}

function closestReference(target: EventTarget, editor: HTMLDivElement) {
  if (!(target instanceof Element)) return null;
  const reference = target.closest<HTMLElement>(".inline-reference-atomic");
  return reference && editor.contains(reference) ? reference : null;
}

function movedWithin(anchor: HTMLElement, relatedTarget: EventTarget | null) {
  return relatedTarget instanceof Node && anchor.contains(relatedTarget);
}
