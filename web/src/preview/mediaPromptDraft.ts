import { inlineReferenceSegments } from "../composer/inlineReferences";
import type { ComposerAssetKind, ComposerAssetReference } from "../composer/types";
import type { GenerationInputSelection } from "../productApi/generated";

export type SavedPromptReference = { id: string; name: string; kind: ComposerAssetKind };
export type MediaPromptDraft = { text: string; references: SavedPromptReference[] };

const referenceHeader = "\n\n引用资产：\n";
const referenceLine = /^- (图片|视频|文本)「([^」\n]+)」\(([^()\n]+)\)$/u;

// Generation prompts currently persist reference IDs in the text footer. Read that
// footer back into editor state so an existing @mention remains a real reference.
export function parseMediaPromptDraft(prompt: string): MediaPromptDraft {
  let text = prompt;
  let references: SavedPromptReference[] = [];
  while (true) {
    const parsed = parseLastReferenceFooter(text);
    if (!parsed) break;
    text = parsed.text;
    references = [...parsed.references, ...references];
  }
  const seen = new Set<string>();
  return { text, references: references.filter((reference) => {
    if (seen.has(reference.id)) return false;
    seen.add(reference.id);
    return true;
  }) };
}

function parseLastReferenceFooter(prompt: string): MediaPromptDraft | null {
  const start = prompt.lastIndexOf(referenceHeader);
  if (start < 0) return null;

  const tail = prompt.slice(start + referenceHeader.length);
  const blockEnd = tail.indexOf("\n\n");
  const block = blockEnd < 0 ? tail : tail.slice(0, blockEnd);
  const suffix = blockEnd < 0 ? "" : tail.slice(blockEnd);
  if (suffix && !suffix.startsWith("\n\n附件：\n")) {
    return null;
  }

  const lines = block.split("\n");
  const references: SavedPromptReference[] = [];
  for (const line of lines) {
    const match = referenceLine.exec(line);
    if (!match) return null;
    references.push({
      id: match[3],
      name: match[2],
      kind: match[1] === "图片" ? "image" : match[1] === "视频" ? "video" : "text",
    });
  }
  return { text: prompt.slice(0, start) + suffix, references };
}

export function remapMediaPromptReferenceIds(prompt: string, ids: ReadonlyMap<string, string>): string {
  const start = prompt.lastIndexOf(referenceHeader);
  if (start < 0) return prompt;
  const blockStart = start + referenceHeader.length;
  const tail = prompt.slice(blockStart);
  const blockEnd = tail.indexOf("\n\n");
  const block = blockEnd < 0 ? tail : tail.slice(0, blockEnd);
  const lines = block.split("\n");
  if (lines.some((line) => !referenceLine.test(line))) return prompt;
  const mapped = lines.map((line) => {
    const match = referenceLine.exec(line)!;
    const id = ids.get(match[3]);
    return id ? line.slice(0, -match[3].length - 1) + id + ")" : line;
  });
  return prompt.slice(0, blockStart) + mapped.join("\n") + (blockEnd < 0 ? "" : tail.slice(blockEnd));
}

export function reconcileMediaPromptReferences(
  references: readonly SavedPromptReference[],
  assets: readonly { id: string; name: string; kind: ComposerAssetKind }[],
): SavedPromptReference[] {
  const byId = new Map(assets.map((asset) => [asset.id, asset]));
  let changed = false;
  const next = references.map((reference) => {
    if (byId.get(reference.id)?.kind === reference.kind) return reference;
    const matches = assets.filter((asset) => asset.name === reference.name && asset.kind === reference.kind);
    if (matches.length !== 1) return reference;
    changed = true;
    return { ...reference, id: matches[0].id };
  });
  return changed ? next : references as SavedPromptReference[];
}

// Legacy AI prompts sometimes contain only @name text. Resolve unique names
// against the visible storyboard assets so those prompts render as references
// before the next save persists their IDs.
export function inferMediaPromptReferences(
  text: string,
  assets: readonly ComposerAssetReference[],
): ComposerAssetReference[] {
  const variants = assets.flatMap((asset) =>
    [...new Set([asset.name, ...(asset.aliases ?? [])])].map((name) => ({ ...asset, name })));
  const nameCounts = new Map<string, number>();
  variants.forEach((asset) => nameCounts.set(asset.name, (nameCounts.get(asset.name) ?? 0) + 1));
  const unambiguous = variants.filter((asset) => nameCounts.get(asset.name) === 1);
  const seen = new Set<string>();
  return inlineReferenceSegments(text, unambiguous).flatMap((segment) => {
    if (segment.type !== "reference" || seen.has(segment.reference.id)) return [];
    seen.add(segment.reference.id);
    return [segment.reference];
  });
}

// Older tool proposals stored the generation input separately from the prompt.
// Recover those stable IDs from the matching generation job when no reference
// footer was saved, so the editor can display and resubmit the actual sources.
export function restoreGenerationInputReferences(
  prompt: string,
  input: GenerationInputSelection | null,
  assets: readonly ComposerAssetReference[],
): MediaPromptDraft {
  const draft = parseMediaPromptDraft(prompt);
  if (!input || input.type === "textOnly") return draft;
  const ids = input.type === "referenceImages"
    ? input.mediaIds
    : [input.firstFrameMediaId, input.lastFrameMediaId].filter((id): id is string => Boolean(id));
  const byMediaId = new Map(assets.flatMap((asset) =>
    asset.kind === "image" && asset.mediaId ? [[asset.mediaId, asset] as const] : []));
  let text = draft.text;
  const references: SavedPromptReference[] = [...draft.references];
  for (const id of new Set(ids)) {
    const asset = byMediaId.get(id);
    if (!asset || references.some((reference) => reference.id === asset.id)) continue;
    const name = [asset.name, ...(asset.aliases ?? [])].find((candidate) => text.includes(`@${candidate}`)) ?? asset.name;
    if (!text.includes(`@${name}`)) text += `${text ? " " : ""}@${name}`;
    references.push({ id: asset.id, name, kind: "image" });
  }
  return { text, references };
}

function sameSavedReferences(a: readonly SavedPromptReference[], b: readonly SavedPromptReference[]) {
  return a.length === b.length && a.every((reference, index) =>
    reference.id === b[index].id && reference.name === b[index].name && reference.kind === b[index].kind);
}

export function sameMediaPromptDraft(a: MediaPromptDraft, b: MediaPromptDraft) {
  return a.text === b.text && sameSavedReferences(a.references, b.references);
}

export function synchronizeMediaPromptDraft(
  current: MediaPromptDraft,
  previousInitialPrompt: string,
  nextInitialPrompt: string,
): MediaPromptDraft {
  const previous = parseMediaPromptDraft(previousInitialPrompt);
  return sameMediaPromptDraft(current, previous)
    ? parseMediaPromptDraft(nextInitialPrompt)
    : current;
}
