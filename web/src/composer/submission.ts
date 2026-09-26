import type { ComposerAssetReference, ComposerAttachment } from "./types";
import { referenceMarker } from "./assetMention";

export type ConversationSubmissionPart =
  | { type: "text"; text: string }
  | { type: "asset_ref"; reference: ComposerAssetReference };

export type ConversationSubmission = {
  contentParts: ConversationSubmissionPart[];
  plainText: string;
};

export function composeConversationSubmission(
  text: string,
  references: readonly ComposerAssetReference[],
  attachments: readonly ComposerAttachment[],
): ConversationSubmission {
  const content = composeSubmissionText(text, [], attachments).trim();
  const contentParts = interleaveReferenceParts(content, references);
  return {
    contentParts,
    plainText: contentParts
      .flatMap((part) => part.type === "text" ? [part.text] : [])
      .join("")
      .trim(),
  };
}

export function composeSubmissionText(
  text: string,
  references: readonly ComposerAssetReference[],
  attachments: readonly ComposerAttachment[],
) {
  const sections: string[] = [];
  if (references.length > 0) {
    sections.push([
      "引用资产：",
      ...references.map((asset) => `- ${kindLabel(asset.kind)}「${asset.name}」(${asset.id})`),
    ].join("\n"));
  }
  if (attachments.length > 0) {
    sections.push([
      "附件：",
      ...attachments.map((attachment) => {
        const preview = attachment.kind === "text" && attachment.textPreview
          ? `\n  内容预览：${attachment.textPreview}`
          : "";
        return `- ${kindLabel(attachment.kind)}「${attachment.name}」${preview}`;
      }),
    ].join("\n"));
  }
  const body = text.trim();
  return sections.length > 0 ? `${body}\n\n${sections.join("\n\n")}` : body;
}

function kindLabel(kind: ComposerAssetReference["kind"]) {
  return kind === "image" ? "图片" : kind === "video" ? "视频" : "文本";
}

function interleaveReferenceParts(
  text: string,
  references: readonly ComposerAssetReference[],
): ConversationSubmissionPart[] {
  const parts: ConversationSubmissionPart[] = [];
  const referenced = new Set<string>();
  let offset = 0;
  while (offset < text.length) {
    const next = references.reduce<{
      index: number;
      marker: string;
      reference: ComposerAssetReference;
    } | null>((closest, reference) => {
      const marker = referenceMarker(reference);
      const index = text.indexOf(marker, offset);
      if (index < 0) return closest;
      if (!closest || index < closest.index || (index === closest.index && marker.length > closest.marker.length)) {
        return { index, marker, reference };
      }
      return closest;
    }, null);
    if (!next) break;
    pushText(parts, text.slice(offset, next.index));
    parts.push({ type: "asset_ref", reference: next.reference });
    referenced.add(next.reference.id);
    offset = next.index + next.marker.length;
  }
  pushText(parts, text.slice(offset));
  for (const reference of references) {
    if (!referenced.has(reference.id)) parts.push({ type: "asset_ref", reference });
  }
  return parts;
}

function pushText(parts: ConversationSubmissionPart[], text: string) {
  if (!text) return;
  const previous = parts.at(-1);
  if (previous?.type === "text") previous.text += text;
  else parts.push({ type: "text", text });
}
