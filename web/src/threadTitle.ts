const MAX_THREAD_TITLE_CHARS = 100;
const MAX_CONVERSATION_HEADER_TITLE_CHARS = 50;
const FALLBACK_SCOPE_TITLE = /^(?:分镜|片段) · /u;

function truncateTitle(title: string, maxCharacters: number): string {
  const characters = Array.from(title);
  if (characters.length <= maxCharacters) return title;
  return `${characters.slice(0, maxCharacters - 1).join("")}…`;
}

export function threadTitleFromPrompt(prompt: string): string {
  return truncateTitle(prompt.trim().replace(/\s+/g, " "), MAX_THREAD_TITLE_CHARS);
}

export function conversationHeaderTitle(title: string): string {
  return truncateTitle(title, MAX_CONVERSATION_HEADER_TITLE_CHARS);
}

export function isFallbackThreadTitle(title: string | undefined): boolean {
  const normalized = title?.trim();
  return !normalized
    || normalized === "新会话"
    || FALLBACK_SCOPE_TITLE.test(normalized)
    || /\s*·\s*会话\s+\d+\s*$/u.test(normalized);
}

export function displayThreadTitle(runtimeTitle: string | undefined, storyboardName: string): string {
  const title = runtimeTitle?.trim();
  if (!title || title === "新会话" || FALLBACK_SCOPE_TITLE.test(title)) return storyboardName;

  const legacyTitle = title.replace(/\s*·\s*会话\s+\d+\s*$/u, "").trim();
  return legacyTitle || storyboardName;
}
