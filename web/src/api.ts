import type { AgentEvent, Message, Thread, ToolResult } from "./types";

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, init);
  if (!response.ok) {
    let message = `${response.status} ${response.statusText}`;
    try {
      const body = (await response.json()) as { error?: string };
      if (body.error) message = body.error;
    } catch { /* The HTTP status remains useful. */ }
    throw new Error(message);
  }
  return response.json() as Promise<T>;
}

export const api = {
  threads: () => request<Thread[]>("/api/threads"),
  createThread: (title = "新会话") =>
    request<Thread>("/api/threads", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title }),
    }),
  messages: (threadId: string, options: { before?: Message; limit?: number } = {}) => {
    const query = new URLSearchParams({ limit: String(options.limit ?? 61) });
    if (options.before) {
      query.set("beforeCreatedAt", options.before.createdAt);
      query.set("beforeId", options.before.id);
    }
    return request<Message[]>(`/api/threads/${threadId}/messages?${query}`);
  },
  events: (threadId: string, options: { since?: number; before?: number; limit?: number } = {}) => {
    const query = new URLSearchParams({ limit: String(options.limit ?? 250) });
    if (options.since !== undefined) query.set("since", String(options.since));
    if (options.before !== undefined) query.set("before", String(options.before));
    return request<AgentEvent[]>(`/api/threads/${threadId}/events?${query}`);
  },
  send: (threadId: string, content: string) =>
    request<{ message: Message; turnId: string }>(`/api/threads/${threadId}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content }),
    }),
  toolResult: (threadId: string, eventId: string) =>
    request<ToolResult>(`/api/threads/${threadId}/events/${eventId}/tool-result`),
};
