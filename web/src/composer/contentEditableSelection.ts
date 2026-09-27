type EditorSelection = { start: number; end: number };
export type CaretAnchor = { left: number; top: number; bottom: number };

const REFERENCE_SELECTOR = "[data-reference-marker]";
const BLOCK_ELEMENTS = new Set(["DIV", "P", "LI"]);

export function readEditorValue(editor: HTMLDivElement) {
  return readChildren(editor);
}

export function editorSelection(editor: HTMLDivElement): EditorSelection {
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0) {
    const end = readEditorValue(editor).length;
    return { start: end, end };
  }
  const range = selection.getRangeAt(0);
  if (!editor.contains(range.startContainer) || !editor.contains(range.endContainer)) {
    const end = readEditorValue(editor).length;
    return { start: end, end };
  }
  const anchor = serializedOffset(editor, range.startContainer, range.startOffset);
  const focus = serializedOffset(editor, range.endContainer, range.endOffset);
  return { start: Math.min(anchor, focus), end: Math.max(anchor, focus) };
}

export function focusEditorAt(editor: HTMLDivElement, offset: number) {
  editor.focus({ preventScroll: true });
  const selection = window.getSelection();
  if (!selection) return;
  const range = document.createRange();
  setRangeBoundary(range, editor, offset);
  range.collapse(true);
  selection.removeAllRanges();
  selection.addRange(range);
}

export function replaceEditorSelection(editor: HTMLDivElement, text: string) {
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0) return;
  const range = selection.getRangeAt(0);
  if (!editor.contains(range.commonAncestorContainer)) return;
  range.deleteContents();
  const node = document.createTextNode(text);
  range.insertNode(node);
  range.setStartAfter(node);
  range.collapse(true);
  selection.removeAllRanges();
  selection.addRange(range);
}

export function editorCaretAnchor(editor: HTMLDivElement, offset: number): CaretAnchor {
  const range = document.createRange();
  setRangeBoundary(range, editor, offset);
  range.collapse(true);
  const rect = range.getClientRects()[0] ?? range.getBoundingClientRect();
  const editorRect = editor.getBoundingClientRect();
  const lineHeight = Number.parseFloat(getComputedStyle(editor).lineHeight) || 20;
  if (rect && (rect.width > 0 || rect.height > 0)) {
    return {
      left: rect.left,
      top: rect.top,
      bottom: rect.bottom || rect.top + lineHeight,
    };
  }
  return {
    left: editorRect.left + 7,
    top: editorRect.top + 5,
    bottom: editorRect.top + 5 + lineHeight,
  };
}

function readNode(node: Node): string {
  if (node.nodeType === Node.TEXT_NODE) return node.textContent ?? "";
  if (!(node instanceof HTMLElement)) return "";
  const marker = node.dataset.referenceMarker;
  if (marker !== undefined) return marker;
  if (node.tagName === "BR") return "\n";
  const content = readChildren(node);
  return BLOCK_ELEMENTS.has(node.tagName) && content === "\n" ? "" : content;
}

function readChildren(parent: Node) {
  let value = "";
  for (const child of parent.childNodes) {
    if (child instanceof HTMLElement && BLOCK_ELEMENTS.has(child.tagName)
      && value.length > 0 && !value.endsWith("\n")) {
      value += "\n";
    }
    value += readNode(child);
  }
  return value;
}

function serializedLength(node: Node): number {
  return readNode(node).length;
}

function serializedOffset(root: HTMLElement, container: Node, offset: number) {
  const range = document.createRange();
  range.setStart(root, 0);
  range.setEnd(container, offset);
  const holder = document.createElement("div");
  holder.append(range.cloneContents());
  return readEditorValue(holder).length;
}

function setRangeBoundary(range: Range, root: HTMLElement, requestedOffset: number) {
  const target = Math.max(0, requestedOffset);
  let consumed = 0;
  let placed = false;

  const visit = (node: Node) => {
    if (placed) return;
    if (node instanceof HTMLElement && node.matches(REFERENCE_SELECTOR)) {
      const length = serializedLength(node);
      if (target <= consumed + length) {
        if (target - consumed < length / 2) range.setStartBefore(node);
        else range.setStartAfter(node);
        placed = true;
      } else {
        consumed += length;
      }
      return;
    }
    if (node.nodeType === Node.TEXT_NODE) {
      const length = node.textContent?.length ?? 0;
      if (target <= consumed + length) {
        range.setStart(node, Math.max(0, Math.min(length, target - consumed)));
        placed = true;
      } else {
        consumed += length;
      }
      return;
    }
    if (node instanceof HTMLBRElement) {
      if (target <= consumed + 1) {
        range.setStartAfter(node);
        placed = true;
      } else {
        consumed += 1;
      }
      return;
    }
    node.childNodes.forEach(visit);
  };

  root.childNodes.forEach(visit);
  if (!placed) {
    range.selectNodeContents(root);
    range.collapse(false);
  }
}
