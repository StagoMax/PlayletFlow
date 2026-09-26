import type { Message, Thread } from "../types";
import { isFallbackThreadTitle, threadTitleFromPrompt } from "../threadTitle";
import type { WorkspaceThreadBinding } from "./workspaceThreadClient";

type ThreadTitleReader = {
  threads(): Promise<Thread[]>;
  messages(threadId: string, options?: { limit?: number }): Promise<Message[]>;
};

function messageText(message: Message): string {
  return message.parts
    .filter((part): part is { type: "text"; text: string } => part.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("\n");
}

export async function readRuntimeThreadTitles(client: ThreadTitleReader): Promise<Record<string, string>> {
  const threads = await client.threads();
  return Object.fromEntries(threads.map((thread) => [thread.id, thread.title]));
}

export async function resolveHistoricalThreadTitles(
  bindings: readonly WorkspaceThreadBinding[],
  runtimeTitles: Readonly<Record<string, string>>,
  client: ThreadTitleReader,
): Promise<Record<string, string>> {
  const entries = await Promise.all(bindings.map(async (binding) => {
    const runtimeTitle = runtimeTitles[binding.threadId];
    if (!isFallbackThreadTitle(runtimeTitle)) return [binding.threadId, runtimeTitle] as const;
    try {
      const messages = await client.messages(binding.threadId, { limit: 61 });
      const firstPrompt = messages.find((message) => message.role === "user");
      const title = firstPrompt ? threadTitleFromPrompt(messageText(firstPrompt)) : "";
      return [binding.threadId, title || runtimeTitle] as const;
    } catch {
      return [binding.threadId, runtimeTitle] as const;
    }
  }));
  return Object.fromEntries(entries.filter((entry): entry is readonly [string, string] => Boolean(entry[1])));
}
