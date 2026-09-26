import type { ComposerAssetReference, ComposerAttachment } from "./types";

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
