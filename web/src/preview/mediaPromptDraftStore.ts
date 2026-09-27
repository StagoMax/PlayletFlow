import { parseMediaPromptDraft, sameMediaPromptDraft, type MediaPromptDraft } from "./mediaPromptDraft";

const storagePrefix = "videoflow:media-prompt-draft:";

type StoredDraft = { basePrompt: string; draft: MediaPromptDraft };

function storage() {
  try { return window.sessionStorage; } catch { return null; }
}

export function loadMediaPromptDraft(key: string | undefined, initialPrompt: string): MediaPromptDraft {
  if (!key) return parseMediaPromptDraft(initialPrompt);
  try {
    const saved = storage()?.getItem(storagePrefix + key);
    if (!saved) return parseMediaPromptDraft(initialPrompt);
    const entry = JSON.parse(saved) as StoredDraft;
    if (typeof entry.basePrompt !== "string" || typeof entry.draft?.text !== "string"
      || !Array.isArray(entry.draft.references)) return parseMediaPromptDraft(initialPrompt);
    return sameMediaPromptDraft(entry.draft, parseMediaPromptDraft(entry.basePrompt))
      ? parseMediaPromptDraft(initialPrompt)
      : entry.draft;
  } catch {
    return parseMediaPromptDraft(initialPrompt);
  }
}

export function saveMediaPromptDraft(key: string | undefined, initialPrompt: string, draft: MediaPromptDraft) {
  if (!key) return;
  const target = storage();
  if (!target) return;
  try {
    if (sameMediaPromptDraft(draft, parseMediaPromptDraft(initialPrompt))) {
      target.removeItem(storagePrefix + key);
    } else {
      target.setItem(storagePrefix + key, JSON.stringify({ basePrompt: initialPrompt, draft } satisfies StoredDraft));
    }
  } catch { /* Editing remains available when browser storage is unavailable. */ }
}
