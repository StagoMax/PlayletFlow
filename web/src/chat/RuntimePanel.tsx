import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../api";
import type { ComposerAssetReference } from "../composer/types";
import { Conversation } from "./Conversation";
import { ThreadSwitcher } from "./ThreadSwitcher";
import { forgetConversation } from "./useConversation";
import type {
  WorkspaceThreadBinding,
  WorkspaceThreadClient,
  WorkspaceThreadScope,
} from "./workspaceThreadClient";
import { Icon } from "../workspace/Icons";
import { threadTitleFromPrompt } from "../threadTitle";
import { readRuntimeThreadTitles, resolveHistoricalThreadTitles } from "./workspaceThreadTitles";

type RuntimePanelProps = WorkspaceThreadScope & {
  client: WorkspaceThreadClient;
  assets: readonly ComposerAssetReference[];
  onTurnSettled: () => void;
  onSelectReference: (reference: ComposerAssetReference) => void;
};

const initialCreateKeys = new Map<string, string>();
const activeThreadIds = new Map<string, string>();

function scopeKey(scope: WorkspaceThreadScope) {
  return `${scope.projectId}:${scope.storyboardId}`;
}

function rememberedThread(scope: WorkspaceThreadScope) {
  const key = scopeKey(scope);
  const inMemory = activeThreadIds.get(key);
  if (inMemory) return inMemory;
  try { return window.localStorage.getItem(`videoflow:active-thread:v1:${key}`); }
  catch { return null; }
}

function rememberThread(scope: WorkspaceThreadScope, threadId: string | null) {
  const key = scopeKey(scope);
  if (threadId) activeThreadIds.set(key, threadId);
  else activeThreadIds.delete(key);
  try {
    if (threadId) window.localStorage.setItem(`videoflow:active-thread:v1:${key}`, threadId);
    else window.localStorage.removeItem(`videoflow:active-thread:v1:${key}`);
  } catch { /* In-memory selection still works when storage is unavailable. */ }
}

function initialCreateKey(scope: WorkspaceThreadScope) {
  const key = scopeKey(scope);
  let value = initialCreateKeys.get(key);
  if (!value) {
    value = crypto.randomUUID();
    initialCreateKeys.set(key, value);
  }
  return value;
}

export function RuntimePanel({
  client,
  projectId,
  storyboardId,
  storyboardName,
  assets,
  onTurnSettled,
  onSelectReference,
}: RuntimePanelProps) {
  const [bindings, setBindings] = useState<WorkspaceThreadBinding[]>([]);
  const [activeThreadId, setActiveThreadId] = useState<string | null>(null);
  const [threadTitles, setThreadTitles] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [deletingThreadId, setDeletingThreadId] = useState<string | null>(null);
  const [connectionAttempt, setConnectionAttempt] = useState(0);
  const [runtimeModel, setRuntimeModel] = useState<string | null>(null);
  const [fixtureRuntime, setFixtureRuntime] = useState(false);
  const [runtimeModelLoading, setRuntimeModelLoading] = useState(true);
  const requestVersion = useRef(0);
  const activeRequest = useRef<AbortController | null>(null);

  useEffect(() => {
    let active = true;
    let retryTimer: number | undefined;
    setRuntimeModelLoading(true);

    const loadRuntimeInfo = async (attempt: number) => {
      try {
        const info = await api.runtimeInfo();
        if (!active) return;
        setRuntimeModel(info.model);
        setFixtureRuntime(info.mode === "fixture");
        setRuntimeModelLoading(false);
      } catch {
        if (!active) return;
        if (attempt < 1) {
          retryTimer = window.setTimeout(() => void loadRuntimeInfo(attempt + 1), 1_000);
          return;
        }
        setRuntimeModel(null);
        setRuntimeModelLoading(false);
      }
    };

    void loadRuntimeInfo(0);
    return () => {
      active = false;
      window.clearTimeout(retryTimer);
    };
  }, [connectionAttempt]);

  useEffect(() => {
    const version = ++requestVersion.current;
    const controller = new AbortController();
    activeRequest.current?.abort();
    activeRequest.current = controller;
    setBindings([]);
    setActiveThreadId(null);
    setThreadTitles({});
    setError(null);
    setLoading(true);
    setCreating(false);
    setDeletingThreadId(null);
    const scope = { projectId, storyboardId, storyboardName };
    void (async () => {
      try {
        const existing = await client.list(scope, controller.signal);
        const next = existing.length > 0
          ? existing
          : [await client.create(scope, initialCreateKey(scope), controller.signal)];
        const runtimeTitles = await readRuntimeThreadTitles(api);
        if (version === requestVersion.current) {
          const remembered = rememberedThread(scope);
          const active = next.some((item) => item.threadId === remembered) ? remembered! : next[0].threadId;
          rememberThread(scope, active);
          setBindings(next);
          setActiveThreadId(active);
          setThreadTitles(runtimeTitles);
          void resolveHistoricalThreadTitles(next, runtimeTitles, api).then((resolved) => {
            if (version !== requestVersion.current) return;
            setThreadTitles((current) => {
              const enriched = { ...current };
              for (const [threadId, title] of Object.entries(resolved)) {
                if (current[threadId] === runtimeTitles[threadId]) enriched[threadId] = title;
              }
              return enriched;
            });
          });
        }
      } catch (cause) {
        if (!controller.signal.aborted && version === requestVersion.current) {
          setError(cause instanceof Error ? cause.message : String(cause));
        }
      } finally {
        if (version === requestVersion.current) setLoading(false);
      }
    })();
    return () => controller.abort();
  }, [client, connectionAttempt, projectId, storyboardId, storyboardName]);

  async function createThread() {
    if (creating || deletingThreadId) return;
    const version = ++requestVersion.current;
    const controller = new AbortController();
    activeRequest.current?.abort();
    activeRequest.current = controller;
    setCreating(true);
    setError(null);
    try {
      const next = await client.create(
        { projectId, storyboardId, storyboardName },
        crypto.randomUUID(),
        controller.signal,
      );
      const runtimeTitles = await readRuntimeThreadTitles(api);
      if (version === requestVersion.current) {
        rememberThread({ projectId, storyboardId, storyboardName }, next.threadId);
        setBindings((current) => [next, ...current.filter((item) => item.threadId !== next.threadId)]);
        setActiveThreadId(next.threadId);
        setThreadTitles(runtimeTitles);
        void resolveHistoricalThreadTitles([next], runtimeTitles, api).then((resolved) => {
          if (version !== requestVersion.current) return;
          setThreadTitles((current) => {
            const title = resolved[next.threadId];
            return title && current[next.threadId] === runtimeTitles[next.threadId]
              ? { ...current, [next.threadId]: title }
              : current;
          });
        });
      }
    } catch (cause) {
      if (!controller.signal.aborted && version === requestVersion.current) {
        setError(cause instanceof Error ? cause.message : String(cause));
      }
    } finally {
      if (version === requestVersion.current) setCreating(false);
    }
  }

  const binding = bindings.find((item) => item.threadId === activeThreadId) ?? null;

  function selectThread(threadId: string) {
    rememberThread({ projectId, storyboardId, storyboardName }, threadId);
    setActiveThreadId(threadId);
  }

  async function deleteThread(threadId: string) {
    if (deletingThreadId || creating || !bindings.some((item) => item.threadId === threadId)) return;
    const scope = { projectId, storyboardId, storyboardName };
    const version = ++requestVersion.current;
    const controller = new AbortController();
    activeRequest.current?.abort();
    activeRequest.current = controller;
    setDeletingThreadId(threadId);
    setError(null);
    try {
      await client.delete(scope, threadId, controller.signal);
      forgetConversation(threadId);
      if (version !== requestVersion.current) return;
      const remaining = bindings.filter((item) => item.threadId !== threadId);
      setBindings(remaining);
      setThreadTitles((current) => {
        const next = { ...current };
        delete next[threadId];
        return next;
      });
      if (activeThreadId !== threadId) return;
      if (remaining.length > 0) {
        const nextId = remaining[0].threadId;
        rememberThread(scope, nextId);
        setActiveThreadId(nextId);
        return;
      }
      rememberThread(scope, null);
      setActiveThreadId(null);
      setLoading(true);
      const replacement = await client.create(scope, crypto.randomUUID(), controller.signal);
      if (version !== requestVersion.current) return;
      rememberThread(scope, replacement.threadId);
      setBindings([replacement]);
      setActiveThreadId(replacement.threadId);
      const titles = await readRuntimeThreadTitles(api);
      if (version === requestVersion.current) setThreadTitles(titles);
    } catch (cause) {
      if (!controller.signal.aborted && version === requestVersion.current) {
        setError(cause instanceof Error ? cause.message : String(cause));
      }
    } finally {
      if (version === requestVersion.current) {
        setDeletingThreadId(null);
        setLoading(false);
      }
    }
  }

  const titleFromFirstPrompt = useCallback((prompt: string) => {
    if (!activeThreadId) return;
    const threadId = activeThreadId;
    const expectedTitle = threadTitles[threadId];
    const optimisticTitle = threadTitleFromPrompt(prompt);
    if (!expectedTitle || !optimisticTitle) return;
    setThreadTitles((current) => ({ ...current, [threadId]: optimisticTitle }));
    void api.generateThreadTitle(threadId, prompt, expectedTitle)
      .then(({ thread }) => {
        setThreadTitles((current) => ({ ...current, [threadId]: thread.title }));
      })
      .catch(() => {
        setThreadTitles((current) => ({ ...current, [threadId]: expectedTitle }));
      });
  }, [activeThreadId, threadTitles]);

  return (
    <div className="runtime-panel" data-storyboard-id={storyboardId} data-thread-id={binding?.threadId ?? ""}>
      <div className="runtime-toolbar">
        <ThreadSwitcher
          bindings={bindings}
          activeThreadId={activeThreadId}
          storyboardName={storyboardName}
          threadTitles={threadTitles}
          disabled={loading || deletingThreadId !== null}
          onSelect={selectThread}
          onDelete={(threadId) => void deleteThread(threadId)}
        />
        <button
          className="new-thread"
          type="button"
          aria-label={creating ? "正在创建新对话" : "新建对话"}
          title="新建对话"
          onClick={() => void createThread()}
          disabled={creating || loading || deletingThreadId !== null}
        >
          <Icon name="message-plus" /> <span className="sr-only">{creating ? "创建中…" : "新建对话"}</span>
        </button>
      </div>
      {error ? (
        <div role="alert" className="global-error global-error--actionable">
          <span>{error}</span>
          <button type="button" onClick={() => setConnectionAttempt((attempt) => attempt + 1)}>
            重新连接
          </button>
        </div>
      ) : null}
      {fixtureRuntime ? (
        <div role="status" className="runtime-fixture-warning">
          当前连接的是演示后端，只会固定回显消息，不会调用真实模型或分镜工具。
        </div>
      ) : null}
      {loading ? <div className="center-note">正在连接当前片段会话…</div> : null}
      {!loading && binding ? (
        <Conversation
          key={binding.threadId}
          threadId={binding.threadId}
          assets={assets}
          runtimeModel={runtimeModel}
          runtimeModelLoading={runtimeModelLoading}
          onTurnSettled={onTurnSettled}
          onFirstPrompt={titleFromFirstPrompt}
          onSelectReference={onSelectReference}
        />
      ) : null}
    </div>
  );
}
