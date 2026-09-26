import type { Message, MessagePart } from "../types";

const REFERENCE_PREFIX = "videoflow-ref:";

export type WorkspaceReference = {
  id: string;
  name: string;
  kind: "image" | "video" | "text";
};

export function workspaceReferencePart(reference: WorkspaceReference): MessagePart {
  const payload = new TextEncoder().encode(JSON.stringify(reference));
  let binary = "";
  for (const byte of payload) binary += String.fromCharCode(byte);
  const encoded = btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
  return { type: "file_ref", path: `${REFERENCE_PREFIX}${encoded}` };
}

export function workspaceReferenceFromPart(part: MessagePart): WorkspaceReference | null {
  if (part.type !== "file_ref" || typeof part.path !== "string") return null;
  const encoded = part.path.startsWith(REFERENCE_PREFIX)
    ? part.path.slice(REFERENCE_PREFIX.length)
    : null;
  if (!encoded) return null;
  try {
    const normalized = encoded.replaceAll("-", "+").replaceAll("_", "/");
    const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
    const binary = atob(padded);
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    const value = JSON.parse(new TextDecoder().decode(bytes)) as Partial<WorkspaceReference>;
    if (
      typeof value.id !== "string"
      || typeof value.name !== "string"
      || (value.kind !== "text" && value.kind !== "image" && value.kind !== "video")
    ) return null;
    return { id: value.id, name: value.name, kind: value.kind };
  } catch {
    return null;
  }
}

export function messagePartText(part: MessagePart) {
  return part.type === "text" && typeof part.text === "string" ? part.text : null;
}

export function migrateLegacyMessageReferences(message: Message): Message {
  if (message.role !== "user" || message.parts.length !== 1) return message;
  const text = messagePartText(message.parts[0]);
  const header = "\n\n引用资产：\n";
  const headerIndex = text?.lastIndexOf(header) ?? -1;
  if (!text || headerIndex < 0) return message;
  const suffix = text.slice(headerIndex + header.length);
  const attachmentHeader = "\n\n附件：";
  const attachmentIndex = suffix.indexOf(attachmentHeader);
  const referenceBlock = attachmentIndex >= 0 ? suffix.slice(0, attachmentIndex) : suffix;
  const attachmentSuffix = attachmentIndex >= 0 ? suffix.slice(attachmentIndex) : "";
  const references = referenceBlock
    .split("\n")
    .filter(Boolean)
    .map(parseLegacyReference);
  if (references.length === 0 || references.some((reference) => reference === null)) return message;
  const content = `${text.slice(0, headerIndex)}${attachmentSuffix}`;
  return {
    ...message,
    parts: interleaveLegacyReferences(content, references as WorkspaceReference[]),
  };
}

function parseLegacyReference(line: string): WorkspaceReference | null {
  const match = /^- (文本|图片|视频)「(.+)」\((.+)\)$/u.exec(line);
  if (!match) return null;
  return {
    id: match[3],
    name: match[2],
    kind: match[1] === "文本" ? "text" : match[1] === "图片" ? "image" : "video",
  };
}

function interleaveLegacyReferences(text: string, references: WorkspaceReference[]): MessagePart[] {
  const parts: MessagePart[] = [];
  const included = new Set<string>();
  let offset = 0;
  while (offset < text.length) {
    const next = references.reduce<{ index: number; marker: string; reference: WorkspaceReference } | null>(
      (closest, reference) => {
        const marker = `@${reference.name}`;
        const index = text.indexOf(marker, offset);
        if (index < 0) return closest;
        return !closest || index < closest.index || (index === closest.index && marker.length > closest.marker.length)
          ? { index, marker, reference }
          : closest;
      },
      null,
    );
    if (!next) break;
    pushMessageText(parts, text.slice(offset, next.index));
    parts.push(workspaceReferencePart(next.reference));
    included.add(next.reference.id);
    offset = next.index + next.marker.length;
  }
  pushMessageText(parts, text.slice(offset));
  references.forEach((reference) => {
    if (!included.has(reference.id)) parts.push(workspaceReferencePart(reference));
  });
  return parts;
}

function pushMessageText(parts: MessagePart[], text: string) {
  if (!text) return;
  const previous = parts.at(-1);
  if (previous?.type === "text" && typeof previous.text === "string") previous.text += text;
  else parts.push({ type: "text", text });
}
