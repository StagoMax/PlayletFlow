import { useCallback, useEffect, useRef, useState, type DragEvent } from "react";
import type { ComposerAssetKind, ComposerAttachment } from "./types";

const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;
const TEXT_EXTENSIONS = new Set(["txt", "md", "markdown", "json", "csv", "tsv", "srt", "vtt"]);

export function useComposerAttachments(maxCount = 8) {
  const inputRef = useRef<HTMLInputElement>(null);
  const attachmentsRef = useRef<ComposerAttachment[]>([]);
  const [attachments, setAttachments] = useState<ComposerAttachment[]>([]);
  const [error, setError] = useState("");
  const [dragging, setDragging] = useState(false);
  const dragDepth = useRef(0);

  useEffect(() => {
    attachmentsRef.current = attachments;
  }, [attachments]);

  useEffect(() => () => {
    for (const attachment of attachmentsRef.current) revokePreview(attachment);
  }, []);

  const addFiles = useCallback(async (files: readonly File[]) => {
    const accepted: ComposerAttachment[] = [];
    const rejected: string[] = [];
    const existing = new Set(
      attachmentsRef.current.map((item) => `${item.name}:${item.bytes}:${item.file.lastModified}`),
    );
    for (const file of files) {
      if (attachmentsRef.current.length + accepted.length >= maxCount) {
        rejected.push(`最多添加 ${maxCount} 个附件`);
        break;
      }
      if (file.size > MAX_ATTACHMENT_BYTES) {
        rejected.push(`${file.name} 超过 25 MB`);
        continue;
      }
      const kind = fileKind(file);
      if (!kind) {
        rejected.push(`${file.name} 不是支持的图片、视频或文本文件`);
        continue;
      }
      const fingerprint = `${file.name}:${file.size}:${file.lastModified}`;
      if (existing.has(fingerprint)) continue;
      existing.add(fingerprint);
      accepted.push({
        id: crypto.randomUUID(),
        kind,
        name: file.name,
        mimeType: file.type || fallbackMimeType(kind),
        bytes: file.size,
        previewUrl: kind === "image" || kind === "video" ? URL.createObjectURL(file) : undefined,
        textPreview: kind === "text" ? await readTextPreview(file) : undefined,
        file,
      });
    }
    if (accepted.length > 0) {
      setAttachments((current) => [...current, ...accepted]);
    }
    setError([...new Set(rejected)].join("；"));
  }, [maxCount]);

  const removeAttachment = useCallback((id: string) => {
    setAttachments((current) => {
      const removed = current.find((item) => item.id === id);
      if (removed) revokePreview(removed);
      return current.filter((item) => item.id !== id);
    });
    setError("");
  }, []);

  const clearAttachments = useCallback(() => {
    setAttachments((current) => {
      current.forEach(revokePreview);
      return [];
    });
    setError("");
  }, []);

  const dragHandlers = {
    onDragEnter(event: DragEvent<HTMLElement>) {
      if (!hasFiles(event)) return;
      event.preventDefault();
      dragDepth.current += 1;
      setDragging(true);
    },
    onDragOver(event: DragEvent<HTMLElement>) {
      if (!hasFiles(event)) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = "copy";
    },
    onDragLeave() {
      dragDepth.current = Math.max(0, dragDepth.current - 1);
      if (dragDepth.current === 0) setDragging(false);
    },
    onDrop(event: DragEvent<HTMLElement>) {
      if (!hasFiles(event)) return;
      event.preventDefault();
      dragDepth.current = 0;
      setDragging(false);
      void addFiles(Array.from(event.dataTransfer.files));
    },
  };

  return {
    inputRef,
    attachments,
    error,
    dragging,
    addFiles,
    removeAttachment,
    clearAttachments,
    openFilePicker: () => inputRef.current?.click(),
    dragHandlers,
  };
}

function fileKind(file: File): ComposerAssetKind | null {
  if (file.type.startsWith("image/")) return "image";
  if (file.type.startsWith("video/")) return "video";
  if (file.type.startsWith("text/") || TEXT_EXTENSIONS.has(file.name.split(".").pop()?.toLocaleLowerCase() ?? "")) {
    return "text";
  }
  return null;
}

function fallbackMimeType(kind: ComposerAssetKind) {
  return kind === "text" ? "text/plain" : `${kind}/*`;
}

async function readTextPreview(file: File) {
  const text = await file.slice(0, 4096).text();
  const compact = text.replace(/\s+/gu, " ").trim();
  return compact.length > 160 ? `${compact.slice(0, 160)}…` : compact;
}

function revokePreview(attachment: ComposerAttachment) {
  if (attachment.previewUrl?.startsWith("blob:")) URL.revokeObjectURL(attachment.previewUrl);
}

function hasFiles(event: DragEvent<HTMLElement>) {
  return Array.from(event.dataTransfer.types).includes("Files");
}
