import { api, cloudMode } from "./api";
import type { AgentEvent, Message } from "./types";

const initialMessageCount = 60;
const streamedEventTypes = [
  "turn_started", "model_delta", "tool_call_started", "tool_call_finished",
  "assistant_message", "turn_finished", "error",
];

export type ConversationState = {
  messages: Message[];
  events: AgentEvent[];
  loading: boolean;
  loadingOlder: boolean;
  hasOlder: boolean;
  sending: boolean;
  error: string | null;
};

export class ConversationStore {
  readonly threadId: string;
  private state: ConversationState = {
    messages: [], events: [], loading: true, loadingOlder: false,
    hasOlder: false, sending: false, error: null,
  };
  private listeners = new Set<() => void>();
  private stream: EventSource | null = null;
  private batch: AgentEvent[] = [];
  private batchTimer: number | null = null;
  private generation = 0;

  constructor(threadId: string) { this.threadId = threadId; }
  getSnapshot = () => this.state;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    if (this.listeners.size === 1) void this.connect();
    return () => {
      this.listeners.delete(listener);
      if (this.listeners.size === 0) this.disconnect();
    };
  };

  private publish(patch: Partial<ConversationState>) {
    this.state = { ...this.state, ...patch };
    this.listeners.forEach((listener) => listener());
  }

  private async connect() {
    const generation = ++this.generation;
    this.publish({ loading: true, error: null });
    try {
      const [messagePage, events] = await Promise.all([
        api.messages(this.threadId), api.events(this.threadId),
      ]);
      if (generation !== this.generation) return;
      this.publish({
        messages: messagePage.slice(-initialMessageCount),
        events,
        hasOlder: messagePage.length > initialMessageCount,
        loading: false,
      });
      const since = events.at(-1)?.seq ?? 0;
      if (cloudMode) return;
      const stream = new EventSource(`/api/threads/${this.threadId}/events/stream?since=${since}`);
      this.stream = stream;
      for (const type of streamedEventTypes) {
        stream.addEventListener(type, (message) => {
          const event = JSON.parse((message as MessageEvent).data) as AgentEvent;
          this.receive(event);
        });
      }
      stream.onerror = () => this.publish({ error: "实时连接正在重试，历史内容仍可查看。" });
      stream.onopen = () => this.publish({ error: null });
    } catch (error) {
      if (generation === this.generation) {
        this.publish({ loading: false, error: String(error) });
      }
    }
  }

  private disconnect() {
    this.generation++;
    this.stream?.close();
    this.stream = null;
    this.flush();
  }

  private receive(event: AgentEvent) {
    if (event.threadId !== this.threadId || event.seq <= (this.state.events.at(-1)?.seq ?? 0)) return;
    if (this.batch.some((pending) => pending.id === event.id)) return;
    this.batch.push(event);
    if (event.payload.type === "tool_call_started" || event.payload.type === "assistant_message") {
      this.flush();
    } else if (this.batchTimer === null) {
      this.batchTimer = window.setTimeout(() => this.flush(), 32);
    }
  }

  private flush() {
    if (this.batchTimer !== null) window.clearTimeout(this.batchTimer);
    this.batchTimer = null;
    if (!this.batch.length) return;
    const next = this.batch;
    this.batch = [];
    const ids = new Set(this.state.events.map((event) => event.id));
    const events = [...this.state.events, ...next.filter((event) => !ids.has(event.id))];
    const messages = [...this.state.messages];
    const messageIds = new Set(messages.map((message) => message.id));
    for (const event of next) {
      if (event.payload.type === "assistant_message") {
        const message = event.payload.message as Message;
        if (message && !messageIds.has(message.id)) {
          messages.push(message);
          messageIds.add(message.id);
        }
      }
    }
    this.publish({ events, messages });
  }

  async send(content: string) {
    if (this.state.sending) return;
    this.publish({ sending: true, error: null });
    try {
      if (cloudMode) {
        const message: Message = {
          id: crypto.randomUUID(), threadId: this.threadId, role: "user",
          parts: [{ type: "text", text: content }], createdAt: new Date().toISOString(),
        };
        this.publish({ messages: [...this.state.messages, message] });
        const events = await api.turn(this.threadId, message);
        for (const event of events) this.receive(event);
        this.flush();
        this.publish({ sending: false });
        return;
      }
      const { message } = await api.send(this.threadId, content);
      if (!this.state.messages.some((item) => item.id === message.id)) {
        this.publish({ messages: [...this.state.messages, message], sending: false });
      } else {
        this.publish({ sending: false });
      }
    } catch (error) {
      this.publish({ sending: false, error: String(error) });
    }
  }

  async loadOlder() {
    const oldest = this.state.messages[0];
    if (!oldest || !this.state.hasOlder || this.state.loadingOlder) return;
    this.publish({ loadingOlder: true });
    try {
      const page = await api.messages(this.threadId, { before: oldest });
      const known = new Set(this.state.messages.map((message) => message.id));
      const messages = [...page.slice(-initialMessageCount).filter((message) => !known.has(message.id)), ...this.state.messages];
      let events = this.state.events;
      const firstSeq = events[0]?.seq;
      if (firstSeq !== undefined) {
        const olderEvents = await api.events(this.threadId, { before: firstSeq });
        const eventIds = new Set(events.map((event) => event.id));
        events = [...olderEvents.filter((event) => !eventIds.has(event.id)), ...events];
      }
      this.publish({ messages, events, hasOlder: page.length > initialMessageCount, loadingOlder: false });
    } catch (error) {
      this.publish({ loadingOlder: false, error: String(error) });
    }
  }
}
