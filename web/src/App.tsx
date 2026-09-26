import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { api } from "./api";
import { ConversationStore } from "./conversationStore";
import type { AgentEvent, Message, Thread, ToolCall, ToolResult } from "./types";

const stores = new Map<string, ConversationStore>();
function getStore(threadId: string) {
  let store = stores.get(threadId);
  if (!store) {
    store = new ConversationStore(threadId);
    stores.set(threadId, store);
  }
  return store;
}

function useConversation(threadId: string) {
  const store = useMemo(() => getStore(threadId), [threadId]);
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  return { store, state };
}

export default function App() {
  const [threads, setThreads] = useState<Thread[]>([]);
  const [threadId, setThreadId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    let live = true;
    void (async () => {
      try {
        let items = await api.threads();
        if (items.length === 0) items = [await api.createThread()];
        if (!live) return;
        setThreads(items);
        setThreadId(items[0].id);
      } catch (cause) {
        if (live) setError(String(cause));
      }
    })();
    return () => { live = false; };
  }, []);

  async function createThread() {
    if (creating) return;
    setCreating(true);
    try {
      const thread = await api.createThread();
      setThreads((current) => [thread, ...current]);
      setThreadId(thread.id);
      setError(null);
    } catch (cause) {
      setError(String(cause));
    } finally {
      setCreating(false);
    }
  }

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand"><span className="brand-mark">V</span><span>Videoflow Runtime</span></div>
        <button className="new-thread" onClick={() => void createThread()} disabled={creating}>
          ＋ 新会话
        </button>
        <nav aria-label="会话列表" className="thread-list">
          {threads.map((thread) => (
            <button
              key={thread.id}
              className={`thread-row ${threadId === thread.id ? "selected" : ""}`}
              onClick={() => setThreadId(thread.id)}
            >
              {thread.title || "新会话"}
            </button>
          ))}
        </nav>
        <p className="sidebar-note">模型与工具在服务端运行。此页面用于验证 Runtime 闭环。</p>
      </aside>
      <main className="main-panel">
        {error && <div role="alert" className="global-error">{error}</div>}
        {threadId ? <Conversation key={threadId} threadId={threadId} /> : <div className="center-note">正在连接 Runtime…</div>}
      </main>
    </div>
  );
}

function Conversation({ threadId }: { threadId: string }) {
  const { store, state } = useConversation(threadId);
  const [draft, setDraft] = useState("");
  const scrollRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const pinnedRef = useRef(true);
  const beforeOlderHeight = useRef<number | null>(null);
  const wasLoadingOlder = useRef(false);

  const turns = useMemo(() => {
    const byUser = new Map<string, string>();
    const byTurn = new Map<string, AgentEvent[]>();
    for (const event of state.events) {
      if (event.payload.type === "turn_started" && event.turnId) {
        byUser.set(String(event.payload.user_message_id), event.turnId);
      }
      if (event.turnId) {
        const items = byTurn.get(event.turnId) ?? [];
        items.push(event);
        byTurn.set(event.turnId, items);
      }
    }
    return { byUser, byTurn };
  }, [state.events]);

  useLayoutEffect(() => {
    const element = scrollRef.current;
    if (!element) return;
    if (wasLoadingOlder.current && !state.loadingOlder && beforeOlderHeight.current !== null) {
      element.scrollTop += element.scrollHeight - beforeOlderHeight.current;
      beforeOlderHeight.current = null;
    } else if (pinnedRef.current) {
      element.scrollTop = element.scrollHeight;
    }
    wasLoadingOlder.current = state.loadingOlder;
  }, [state.messages, state.events, state.loadingOlder]);

  useEffect(() => {
    const content = contentRef.current;
    if (!content) return;
    let frame = 0;
    const observer = new ResizeObserver(() => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const element = scrollRef.current;
        if (element && pinnedRef.current) element.scrollTop = element.scrollHeight;
      });
    });
    observer.observe(content);
    return () => { observer.disconnect(); cancelAnimationFrame(frame); };
  }, []);

  function loadOlder() {
    beforeOlderHeight.current = scrollRef.current?.scrollHeight ?? null;
    void store.loadOlder();
  }

  function send() {
    const content = draft.trim();
    if (!content) return;
    setDraft("");
    void store.send(content);
  }

  return (
    <div className="conversation">
      <header className="conversation-header">
        <div><strong>Agent 会话</strong><small>OpenTopia Core · 实时工具事件</small></div>
        <span className="status-dot" aria-label="Runtime 已连接" />
      </header>
      <div
        ref={scrollRef}
        className="conversation-scroll"
        onScroll={(event) => {
          const element = event.currentTarget;
          pinnedRef.current = element.scrollHeight - element.clientHeight - element.scrollTop <= 24;
        }}
      >
        <div ref={contentRef} className="conversation-content">
          {state.loading && <div className="center-note">正在加载会话…</div>}
          {!state.loading && state.hasOlder && (
            <button className="older-button" onClick={loadOlder} disabled={state.loadingOlder}>
              {state.loadingOlder ? "加载中…" : "加载更早消息"}
            </button>
          )}
          {!state.loading && state.messages.length === 0 && (
            <div className="empty-state"><h2>Runtime 已就绪</h2><p>发送消息，或请模型调用 runtime_probe 工具验证完整链路。</p></div>
          )}
          {state.messages.map((message) => {
            const turnId = message.role === "user" ? turns.byUser.get(message.id) : undefined;
            return (
              <div key={message.id}>
                <MessageBubble message={message} />
                {turnId && <TurnActivity events={turns.byTurn.get(turnId) ?? []} threadId={threadId} />}
              </div>
            );
          })}
          {state.messages.at(-1)?.role === "user" && !turns.byUser.has(state.messages.at(-1)!.id) && (
            <div className="working">正在启动模型…</div>
          )}
        </div>
      </div>
      {state.error && <div role="alert" className="conversation-error">{state.error}</div>}
      <div className="composer">
        <textarea
          aria-label="输入消息"
          placeholder="输入消息。Shift + Enter 换行"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              send();
            }
          }}
        />
        <button onClick={send} disabled={!draft.trim() || state.sending}>发送</button>
      </div>
    </div>
  );
}

const MessageBubble = memo(function MessageBubble({ message }: { message: Message }) {
  const text = message.parts
    .filter((part): part is { type: "text"; text: string } => part.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("\n");
  return (
    <article className={`message ${message.role}`}>
      <div className="message-label">{message.role === "user" ? "你" : "Agent"}</div>
      <div className="message-body">
        {message.role === "assistant" ? <ReactMarkdown remarkPlugins={[remarkGfm]}>{text}</ReactMarkdown> : text}
      </div>
    </article>
  );
});

function TurnActivity({ events, threadId }: { events: AgentEvent[]; threadId: string }) {
  const toolStarts = events.filter((event) => event.payload.type === "tool_call_started");
  const results = new Map<string, AgentEvent>();
  for (const event of events) {
    if (event.payload.type === "tool_call_finished") {
      const result = event.payload.result as ToolResult;
      if (result) results.set(result.callId, event);
    }
  }
  const finished = events.some((event) => ["assistant_message", "turn_finished", "error"].includes(event.payload.type));
  const liveText = finished ? "" : events
    .filter((event) => event.payload.type === "model_delta")
    .map((event) => String(event.payload.text ?? ""))
    .join("");
  const error = events.find((event) => event.payload.type === "error");
  return (
    <div className="turn-activity">
      {toolStarts.map((event) => {
        const call = event.payload.call as ToolCall;
        return <ToolCard key={event.id} call={call} resultEvent={results.get(call.id)} threadId={threadId} />;
      })}
      {liveText && <div className="live-text">{liveText}<span className="cursor">▋</span></div>}
      {!finished && !liveText && <div className="working">模型正在处理…</div>}
      {error && <div className="turn-error">{String(error.payload.message ?? "运行失败")}</div>}
    </div>
  );
}

function ToolCard({ call, resultEvent, threadId }: { call: ToolCall; resultEvent?: AgentEvent; threadId: string }) {
  const [detail, setDetail] = useState<ToolResult | null>(null);
  const [loading, setLoading] = useState(false);
  const result = resultEvent?.payload.result as ToolResult | undefined;
  async function showDetail() {
    if (!resultEvent || detail || loading) return;
    setLoading(true);
    try { setDetail(await api.toolResult(threadId, resultEvent.id)); }
    finally { setLoading(false); }
  }
  return (
    <div className="tool-card">
      <div className="tool-head"><span>工具 · {call.name}</span><small>{result ? "已完成" : "运行中"}</small></div>
      <pre>{JSON.stringify(call.input, null, 2)}</pre>
      {result && <div className="tool-output">{detail?.output ?? result.output}</div>}
      {result && <button onClick={() => void showDetail()} disabled={loading}>{loading ? "加载中…" : "查看完整结果"}</button>}
    </div>
  );
}
