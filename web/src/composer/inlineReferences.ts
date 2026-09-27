import { referenceMarker } from "./assetMention";
import type { ComposerAssetReference } from "./types";

export type InlineReferenceSegment =
  | { type: "text"; text: string; start: number; end: number }
  | {
      type: "reference";
      marker: string;
      reference: ComposerAssetReference;
      start: number;
      end: number;
    };

export function inlineReferenceSegments(
  value: string,
  references: readonly ComposerAssetReference[],
): InlineReferenceSegment[] {
  const segments: InlineReferenceSegment[] = [];
  let offset = 0;

  while (offset < value.length) {
    const next = nearestReference(value, offset, references);
    if (!next) break;
    if (next.index > offset) {
      segments.push({ type: "text", text: value.slice(offset, next.index), start: offset, end: next.index });
    }
    const end = next.index + next.marker.length;
    segments.push({
      type: "reference",
      marker: next.marker,
      reference: next.reference,
      start: next.index,
      end,
    });
    offset = end;
  }

  if (offset < value.length || segments.length === 0) {
    segments.push({ type: "text", text: value.slice(offset), start: offset, end: value.length });
  }
  return segments;
}

export function removeInlineReference(
  value: string,
  references: readonly ComposerAssetReference[],
  referenceId: string,
) {
  return inlineReferenceSegments(value, references)
    .filter((segment) => segment.type !== "reference" || segment.reference.id !== referenceId)
    .map((segment) => segment.type === "text" ? segment.text : segment.marker)
    .join("");
}

function nearestReference(
  value: string,
  offset: number,
  references: readonly ComposerAssetReference[],
) {
  return references.reduce<{
    index: number;
    marker: string;
    reference: ComposerAssetReference;
  } | null>((closest, reference) => {
    const marker = referenceMarker(reference);
    const index = value.indexOf(marker, offset);
    if (index < 0) return closest;
    if (!closest || index < closest.index || (index === closest.index && marker.length > closest.marker.length)) {
      return { index, marker, reference };
    }
    return closest;
  }, null);
}
