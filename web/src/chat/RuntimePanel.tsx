import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../api";
import type { ComposerAssetReference } from "../composer/types";
import { Conversation } from "./Conversation";
import { ThreadSwitcher } from "./ThreadSwitcher";
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
  const [connectionAttempt, setConnectionAttempt] = useState(0);
  const [runtimeModel, setRuntimeModel] = useState<string | null>(null);
  const [runtimeModelLoading, setRuntimeModelLoading] = useState(true);
  const requestVersion = useRef(0);
  const activeRequest = useRef<AbortController | null>(null);

  useEffect(() => {
    let active = true;
    void api.runtimeInfo()
      .then((info) => {
        if (active) setRuntimeModel(info.model);
      })
      .catch(() => {
        if (active) setRuntimeModel(null);
      })
      .finally(() => {
        if (active) setRuntimeModelLoading(false);
      });
    return () => {
      active = false;
    };
  }, []);

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
    const scope = { projectId, storyboardId, storyboardName };
    void (async () => {
      try {
        const existing = await client.list(scope, controller.signal);
        const next = existing.length > 0
          ? existing
          : [await client.create(scope, initialCreateKey(scope), controller.signal)];
        const runtimeTitles = await readRuntimeThreadTitles(api);
        if (version === requestVersion.current) {
          const remembered = activeThreadIds.get(scopeKey(scope));
          const active = next.some((item) => item.threadId === remembered) ? remembered! : next[0].threadId;
          activeThreadIds.set(scopeKey(scope), active);
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
    if (creating) return;
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
        activeThreadIds.set(scopeKey({ projectId, storyboardId, storyboardName }), next.threadId);
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
    activeThreadIds.set(scopeKey({ projectId, storyboardId, storyboardName }), threadId);
    setActiveThreadId(threadId);
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
          disabled={loading}
          onSelect={selectThread}
        />
        <button
          className="new-thread"
          type="button"
          aria-label={creating ? "正在创建新对话" : "新建对话"}
          title="新建对话"
          onClick={() => void createThread()}
          disabled={creating || loading}
        >
          <Icon name="square-pen" /> <span className="sr-only">{creating ? "创建中…" : "新建对话"}</span>
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
