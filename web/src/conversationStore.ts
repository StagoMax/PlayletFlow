import { api, cloudMode } from "./api";
import { mergeConversationEvents, mergeConversationMessages } from "./conversationMerge";
import type { AgentEvent, Message } from "./types";

const initialMessageCount = 60;
const streamedEventTypes = [
  "turn_started", "model_request", "provider_request_sent", "provider_request_retried",
  "provider_response_headers_received", "provider_first_token_received",
  "provider_stream_progress", "provider_response_commit_started", "provider_response_received",
  "model_delta", "reasoning_delta", "tool_call_started", "tool_call_finished",
  "assistant_message", "token_usage", "turn_finished", "turn_cancelled", "error",
];
const terminalEventTypes = new Set(["turn_finished", "turn_cancelled", "error"]);

export type ConversationState = {
  messages: Message[];
  /** A local user message shown until the runtime returns its canonical record. */
  pendingMessage: Message | null;
  events: AgentEvent[];
  loading: boolean;
  loadingOlder: boolean;
  hasOlder: boolean;
  /** The send command has not yet been acknowledged by an event/API response. */
  sending: boolean;
  /** A stop request is in flight while the runtime reaches a cancellation point. */
  cancelling: boolean;
  /** The canonical running turn, projected from the same events as OpenTopia. */
  activeTurnId: string | null;
  error: string | null;
  syncError: string | null;
};

export class ConversationStore {
  readonly threadId: string;
  private state: ConversationState = {
    messages: [], pendingMessage: null, events: [], loading: true, loadingOlder: false,
    hasOlder: false, sending: false, cancelling: false,
    activeTurnId: null, error: null, syncError: null,
  };
  private listeners = new Set<() => void>();
  private stream: EventSource | null = null;
  private pendingEvents: AgentEvent[] = [];
  private eventIds = new Set<string>();
  private batchTimer: number | null = null;
  private generation = 0;
  private cloudTurnController: AbortController | null = null;

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
    this.publish({ loading: true, syncError: null });
    try {
      const [messagePage, incomingEvents] = await Promise.all([
        api.messages(this.threadId), api.events(this.threadId),
      ]);
      if (generation !== this.generation) return;
      incomingEvents.forEach((event) => this.rememberEvent(event.id));
      const messages = mergeConversationMessages(
        this.state.messages,
        messagePage.slice(-initialMessageCount),
      );
      const events = mergeConversationEvents(this.state.events, incomingEvents);
      this.publish({
        messages,
        events,
        activeTurnId: projectActiveTurn(events),
        hasOlder: messagePage.length > initialMessageCount,
        loading: false,
      });
      const since = latestEventSeq(events);
      if (cloudMode) return;
      const stream = new EventSource(`/api/threads/${this.threadId}/events/stream?since=${since}`);
      this.stream = stream;
      for (const type of streamedEventTypes) {
        stream.addEventListener(type, (message) => {
          this.receive(JSON.parse((message as MessageEvent).data) as AgentEvent);
        });
      }
      stream.onerror = (event) => {
        // `error` is also a valid persisted AgentEvent kind. Only the native
        // EventSource connection error (which has no message data) means retry.
        if (event instanceof MessageEvent && event.data) return;
        this.publish({ syncError: "实时连接正在重试，历史内容仍可查看。" });
      };
      stream.onopen = () => this.publish({ syncError: null });
    } catch (error) {
      if (generation === this.generation) {
        this.publish({ loading: false, syncError: errorMessage(error) });
      }
    }
  }

  private disconnect() {
    this.generation++;
    this.stream?.close();
    this.stream = null;
    this.cloudTurnController?.abort();
    this.cloudTurnController = null;
    this.flushPendingEvents();
  }

  private receive(event: AgentEvent) {
    if (event.threadId !== this.threadId || this.eventIds.has(event.id)) return;
    this.rememberEvent(event.id);
    this.pendingEvents.push(event);
    // This is the same immediate edge used by OpenTopia: a fast tool must be
    // rendered as running before its result is folded into a later batch.
    if (event.payload.type === "tool_call_started") this.flushPendingEvents();
    if (this.batchTimer === null) {
      this.batchTimer = window.setTimeout(() => this.flushPendingEvents(), 32);
    }
  }

  private flushPendingEvents() {
    if (this.batchTimer !== null) window.clearTimeout(this.batchTimer);
    this.batchTimer = null;
    if (!this.pendingEvents.length) return;
    const incoming = this.pendingEvents;
    this.pendingEvents = [];
    const events = mergeConversationEvents(this.state.events, incoming);
    const messages = mergeConversationMessages(
      this.state.messages,
      incoming
        .filter((event) => event.payload.type === "assistant_message")
        .map((event) => event.payload.message as Message),
    );
    let activeTurnId = this.state.activeTurnId;
    let sending = this.state.sending;
    let cancelling = this.state.cancelling;
    let error = this.state.error;
    for (const event of [...incoming].sort((left, right) => left.seq - right.seq)) {
      if (event.payload.type === "turn_started" && event.turnId) {
        activeTurnId = event.turnId;
        sending = false;
      } else if (
        event.turnId &&
        !terminalEventTypes.has(event.payload.type) &&
        activeTurnId === null
      ) {
        // A bounded catch-up page can begin after `turn_started`; any later
        // non-terminal event still proves that this turn is active.
        activeTurnId = event.turnId;
        sending = false;
      } else if (
        terminalEventTypes.has(event.payload.type) &&
        (!event.turnId || activeTurnId === event.turnId)
      ) {
        activeTurnId = null;
        sending = false;
        cancelling = false;
      }
      if (event.payload.type === "error") {
        error = String(event.payload.message ?? "模型运行失败");
      }
    }
    this.publish({ events, messages, activeTurnId, sending, cancelling, error });
  }

  async send(content: string) {
    if (this.state.sending || this.state.activeTurnId || this.state.cancelling) return;
    const pendingMessage: Message = {
      id: `pending-${crypto.randomUUID()}`,
      threadId: this.threadId,
      role: "user",
      parts: [{ type: "text", text: content }],
      createdAt: new Date().toISOString(),
    };
    this.publish({ pendingMessage, sending: true, cancelling: false, error: null });
    try {
      if (cloudMode) {
        const controller = new AbortController();
        this.cloudTurnController = controller;
        const message: Message = {
          id: crypto.randomUUID(), threadId: this.threadId, role: "user",
          parts: [{ type: "text", text: content }], createdAt: new Date().toISOString(),
        };
        this.publish({
          messages: mergeConversationMessages(this.state.messages, [message]),
          pendingMessage: null,
        });
        await api.turn(this.threadId, message, (event) => this.receive(event), controller.signal);
        if (this.cloudTurnController === controller) this.cloudTurnController = null;
        this.flushPendingEvents();
        this.publish({
          sending: false,
          activeTurnId: projectActiveTurn(this.state.events),
        });
        return;
      }
      const { message, turnId } = await api.send(this.threadId, content);
      this.publish({
        messages: mergeConversationMessages(this.state.messages, [message]),
        pendingMessage: null,
        sending: false,
        activeTurnId: turnIsTerminal(this.state.events, turnId) ? null : turnId,
      });
      if (this.state.cancelling && !turnIsTerminal(this.state.events, turnId)) {
        await api.cancel(this.threadId, turnId);
      }
    } catch (error) {
      this.cloudTurnController = null;
      this.flushPendingEvents();
      this.publish({
        pendingMessage: null,
        sending: false,
        cancelling: false,
        activeTurnId: null,
        error: errorMessage(error),
      });
    }
  }

  async cancel() {
    if ((!this.state.sending && !this.state.activeTurnId) || this.state.cancelling) return;
    this.publish({ cancelling: true, error: null });
    if (cloudMode) {
      this.cloudTurnController?.abort();
      return;
    }
    try {
      const result = await api.cancel(this.threadId, this.state.activeTurnId);
      if (!result.cancelled && !this.state.sending) {
        this.publish({ cancelling: false, activeTurnId: null });
      }
    } catch (error) {
      this.publish({ cancelling: false, error: errorMessage(error) });
    }
  }

  async loadOlder() {
    const oldest = this.state.messages[0];
    if (!oldest || !this.state.hasOlder || this.state.loadingOlder) return;
    this.publish({ loadingOlder: true });
    try {
      const page = await api.messages(this.threadId, { before: oldest });
      let events = this.state.events;
      const firstSeq = events[0]?.seq;
      if (firstSeq !== undefined) {
        const olderEvents = await api.events(this.threadId, { before: firstSeq });
        olderEvents.forEach((event) => this.rememberEvent(event.id));
        events = mergeConversationEvents(events, olderEvents);
      }
      this.publish({
        messages: mergeConversationMessages(this.state.messages, page.slice(-initialMessageCount)),
        events,
        hasOlder: page.length > initialMessageCount,
        loadingOlder: false,
      });
    } catch (error) {
      this.publish({ loadingOlder: false, error: errorMessage(error) });
    }
  }

  private rememberEvent(id: string) {
    this.eventIds.add(id);
    if (this.eventIds.size <= 4096) return;
    const oldest = this.eventIds.values().next().value;
    if (oldest) this.eventIds.delete(oldest);
  }
}

function latestEventSeq(events: AgentEvent[]) {
  return events.reduce((latest, event) => Math.max(latest, event.seq), 0);
}

function projectActiveTurn(events: AgentEvent[]) {
  let active: string | null = null;
  for (const event of [...events].sort((left, right) => left.seq - right.seq)) {
    if (event.payload.type === "turn_started" && event.turnId) active = event.turnId;
    else if (event.turnId && !terminalEventTypes.has(event.payload.type) && active === null) {
      active = event.turnId;
    }
    if (terminalEventTypes.has(event.payload.type) && (!event.turnId || active === event.turnId)) {
      active = null;
    }
  }
  return active;
}

function turnIsTerminal(events: AgentEvent[], turnId: string) {
  return events.some((event) => event.turnId === turnId && terminalEventTypes.has(event.payload.type));
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
