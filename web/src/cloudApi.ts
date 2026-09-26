import type { AgentEvent, Message, Thread, ToolResult } from "./types";
import { mergeConversationEvents, mergeConversationMessages } from "./conversationMerge";
import { threadTitleFromPrompt } from "./threadTitle";
import { migrateLegacyMessageReferences } from "./chat/workspaceReference";

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
  const stored = read<Conversation>(conversationKey(threadId), { messages: [], events: [] });
  const messages = stored.messages.map(migrateLegacyMessageReferences);
  if (messages.some((message, index) => message !== stored.messages[index])) {
    const migrated = { ...stored, messages };
    save(threadId, migrated);
    return migrated;
  }
  return stored;
}

function save(threadId: string, value: Conversation) {
  localStorage.setItem(conversationKey(threadId), JSON.stringify({
    messages: value.messages.slice(-200),
    events: value.events.slice(-1000),
  }));
}

function saveTurn(
  threadId: string,
  prior: Conversation,
  userMessage: Message,
  events: AgentEvent[],
) {
  const assistantMessages = events
    .filter((event) => event.payload.type === "assistant_message")
    .map((event) => event.payload.message as Message);
  save(threadId, {
    messages: mergeConversationMessages(prior.messages, [userMessage, ...assistantMessages]),
    events: mergeConversationEvents(prior.events, events),
  });
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
  generateThreadTitle: async (threadId: string, prompt: string, expectedTitle: string) => {
    const threads = read<Thread[]>(threadListKey, []);
    const current = threads.find((thread) => thread.id === threadId);
    if (!current) throw new Error("会话不存在");
    if (current.title !== expectedTitle) return { thread: current, updated: false };
    const nextTitle = threadTitleFromPrompt(prompt);
    if (!nextTitle) throw new Error("会话标题不能为空");
    const updated = { ...current, title: nextTitle, updatedAt: new Date().toISOString() };
    localStorage.setItem(threadListKey, JSON.stringify(
      threads.map((thread) => thread.id === threadId ? updated : thread),
    ));
    return { thread: updated, updated: true };
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
  turn: async (
    threadId: string,
    message: Message,
    onEvent?: (event: AgentEvent) => void,
    signal?: AbortSignal,
  ): Promise<AgentEvent[]> => {
    const prior = conversation(threadId);
    const received: AgentEvent[] = [];
    const receivedIds = new Set<string>();
    const acceptEvent = (event: AgentEvent) => {
      if (event.threadId !== threadId || receivedIds.has(event.id)) return;
      receivedIds.add(event.id);
      received.push(event);
      onEvent?.(event);
    };
    const finishCancelled = () => {
      const last = received.at(-1);
      const turnId = last?.turnId ?? null;
      const nextSeq = Math.max(last?.seq ?? 0, ...prior.events.map((event) => event.seq)) + 1;
      const createdAt = new Date().toISOString();
      acceptEvent({
        id: crypto.randomUUID(),
        threadId,
        turnId,
        seq: nextSeq,
        createdAt,
        payload: { type: "turn_cancelled", reason: "用户已停止运行" },
      });
      acceptEvent({
        id: crypto.randomUUID(),
        threadId,
        turnId,
        seq: nextSeq + 1,
        createdAt,
        payload: { type: "turn_finished", summary: "用户已停止运行" },
      });
      const events = mergeConversationEvents([], received);
      saveTurn(threadId, prior, message, events);
      return events;
    };
    try {
      const response = await fetch("/api/turn", {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
        body: JSON.stringify({
          threadId,
          message,
          messages: prior.messages.slice(-40),
          events: prior.events.slice(-160),
        }),
        signal,
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
        pending += decoder.decode(value, { stream: true }).replaceAll("\r\n", "\n");
        for (let end = pending.indexOf("\n\n"); end !== -1; end = pending.indexOf("\n\n")) {
          const frame = pending.slice(0, end);
          pending = pending.slice(end + 2);
          const kind = frame.match(/^event: (.+)$/m)?.[1];
          const data = frame.match(/^data: (.+)$/m)?.[1];
          if (kind === "error") {
            const body = data ? JSON.parse(data) as { error?: string; threadId?: string } : {};
            if (body.threadId) {
              acceptEvent(body as AgentEvent);
              continue;
            }
            throw new Error(body.error || "模型请求失败");
          }
          if (kind === "result" && data) {
            result = JSON.parse(data) as { message: Message; events: AgentEvent[] };
            result.events.forEach(acceptEvent);
          } else if (kind !== "started" && data) {
            acceptEvent(JSON.parse(data) as AgentEvent);
          }
        }
      }
      if (!result && signal?.aborted) return finishCancelled();
      if (!result) throw new Error("对话连接中断，请重试");
      if (result.message.id !== message.id) throw new Error("会话响应与请求不匹配");
      const events = mergeConversationEvents([], received);
      saveTurn(threadId, prior, message, events);
      return events;
    } catch (error) {
      if (signal?.aborted) return finishCancelled();
      // Preserve the visible partial turn just like OpenTopia's durable event
      // projection, including a user message whose provider request failed.
      saveTurn(threadId, prior, message, mergeConversationEvents([], received));
      throw error;
    }
  },
};
