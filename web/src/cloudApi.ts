import type { AgentEvent, Message, Thread, ToolResult } from "./types";

const threadListKey = "videoflow:threads:v1";
const conversationKey = (threadId: string) => `videoflow:conversation:v1:${threadId}`;
type Conversation = { messages: Message[]; events: AgentEvent[] };

function read<T>(key: string, fallback: T): T {
  try {
    const value = localStorage.getItem(key);
    return value ? JSON.parse(value) as T : fallback;
  } catch {
    return fallback;
  }
}

function conversation(threadId: string): Conversation {
  return read<Conversation>(conversationKey(threadId), { messages: [], events: [] });
}

function save(threadId: string, value: Conversation) {
  localStorage.setItem(conversationKey(threadId), JSON.stringify({
    messages: value.messages.slice(-200),
    events: value.events.slice(-1000),
  }));
}

function page<T>(items: T[], limit: number, before: (item: T) => boolean): T[] {
  return items.filter(before).slice(-limit);
}

export const cloudApi = {
  threads: async () => read<Thread[]>(threadListKey, []),
  createThread: async (title = "新会话") => {
    const now = new Date().toISOString();
    const thread: Thread = { id: crypto.randomUUID(), title, createdAt: now, updatedAt: now };
    localStorage.setItem(threadListKey, JSON.stringify([thread, ...read<Thread[]>(threadListKey, [])]));
    save(thread.id, { messages: [], events: [] });
    return thread;
  },
  messages: async (threadId: string, options: { before?: Message; limit?: number } = {}) => {
    const items = conversation(threadId).messages;
    const before = options.before;
    return page(items, options.limit ?? 61, (item) => !before ||
      item.createdAt < before.createdAt || (item.createdAt === before.createdAt && item.id < before.id));
  },
  events: async (threadId: string, options: { since?: number; before?: number; limit?: number } = {}) => {
    const items = conversation(threadId).events;
    return page(items, options.limit ?? 250, (item) =>
      (options.since === undefined || item.seq > options.since) &&
      (options.before === undefined || item.seq < options.before));
  },
  toolResult: async (threadId: string, eventId: string) => {
    const event = conversation(threadId).events.find((item) => item.id === eventId);
    if (event?.payload.type !== "tool_call_finished") throw new Error("工具结果不存在");
    return event.payload.result as ToolResult;
  },
  turn: async (threadId: string, message: Message): Promise<AgentEvent[]> => {
    const prior = conversation(threadId);
    const response = await fetch("/api/turn/stream", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        threadId,
        message,
        messages: prior.messages.slice(-40),
        events: prior.events.slice(-160),
      }),
    });
    if (!response.ok) {
      const body = await response.json().catch(() => ({})) as { error?: string };
      throw new Error(body.error || `${response.status} ${response.statusText}`);
    }
    if (!response.body) throw new Error("浏览器无法读取对话流");
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let pending = "";
    let result: { message: Message; events: AgentEvent[] } | undefined;
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      pending += decoder.decode(value, { stream: true });
      for (let end = pending.indexOf("\n\n"); end !== -1; end = pending.indexOf("\n\n")) {
        const frame = pending.slice(0, end);
        pending = pending.slice(end + 2);
        const kind = frame.match(/^event: (.+)$/m)?.[1];
        const data = frame.match(/^data: (.+)$/m)?.[1];
        if (kind === "error") {
          const body = data ? JSON.parse(data) as { error?: string } : {};
          throw new Error(body.error || "模型请求失败");
        }
        if (kind === "result" && data) result = JSON.parse(data) as { message: Message; events: AgentEvent[] };
      }
    }
    if (!result) throw new Error("对话连接中断，请重试");
    if (result.message.id !== message.id) throw new Error("会话响应与请求不匹配");
    save(threadId, {
      messages: [...prior.messages, message, ...result.events
        .filter((event) => event.payload.type === "assistant_message")
        .map((event) => event.payload.message as Message)],
      events: [...prior.events, ...result.events],
    });
    return result.events;
  },
};
