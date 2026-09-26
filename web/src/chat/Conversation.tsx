import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ComposerAssetReference } from "../composer/types";
import type { ConversationSubmission } from "../composer/submission";
import { Icon } from "../workspace/Icons";
import { ConversationComposer } from "./ConversationComposer";
import { ConversationTurn } from "./ConversationTurn";
import { projectConversationTurns } from "./conversationTurnModel";
import { useConversation } from "./useConversation";
import { useConversationScroll } from "./useConversationScroll";
import "./conversation.css";

type ConversationProps = {
  threadId: string;
  assets: readonly ComposerAssetReference[];
  runtimeModel: string | null;
  runtimeModelLoading: boolean;
  onTurnSettled: () => void;
  onFirstPrompt: (prompt: string) => void;
  onSelectReference: (reference: ComposerAssetReference) => void;
};

export function Conversation({
  threadId,
  assets,
  runtimeModel,
  runtimeModelLoading,
  onTurnSettled,
  onFirstPrompt,
  onSelectReference,
}: ConversationProps) {
  const { store, state } = useConversation(threadId);
  const [draft, setDraft] = useState("");
  const turnCache = useRef<{ threadId: string; turns: ReturnType<typeof projectConversationTurns> }>({
    threadId,
    turns: [],
  });
  const busy = state.sending || state.activeTurnId !== null;
  const wasBusy = useRef(false);

  useEffect(() => {
    if (wasBusy.current && !busy) onTurnSettled();
    wasBusy.current = busy;
  }, [busy, onTurnSettled]);
  const visibleMessages = useMemo(
    () => state.pendingMessage ? [...state.messages, state.pendingMessage] : state.messages,
    [state.messages, state.pendingMessage],
  );

  const turns = useMemo(() => {
    const previous = turnCache.current.threadId === threadId ? turnCache.current.turns : [];
    const next = projectConversationTurns(visibleMessages, state.events, state.activeTurnId, previous);
    turnCache.current = { threadId, turns: next };
    return next;
  }, [threadId, visibleMessages, state.events, state.activeTurnId]);
  const pendingTurnKey = busy
    ? [...turns].reverse().find((turn) => turn.userMessage && !turn.turnId && turn.assistantMessages.length === 0)?.key ?? null
    : null;
  const hasRecordedError = state.events.some((event) => event.payload.type === "error");
  const scroll = useConversationScroll({
    messageCount: visibleMessages.length,
    latestEventSeq: state.events.at(-1)?.seq ?? 0,
    loadingOlder: state.loadingOlder,
  });

  function loadOlder() {
    scroll.prepareForOlderMessages();
    void store.loadOlder();
  }

  const send = useCallback((submission: ConversationSubmission) => {
    const content = submission.plainText.trim();
    if (!content || busy) return;
    if (!state.messages.some((message) => message.role === "user")) onFirstPrompt(content);
    setDraft("");
    void store.send(submission);
  }, [busy, onFirstPrompt, state.messages, store]);
  const stop = useCallback(() => void store.cancel(), [store]);

  return (
    <div className="conversation">
      <div className="conversation-scroll-shell">
        <div ref={scroll.scrollRef} className="conversation-scroll" onScroll={scroll.onScroll}>
          <div ref={scroll.contentRef} className="conversation-content">
          {state.loading ? <div className="center-note">正在加载会话…</div> : null}
          {!state.loading && state.hasOlder ? (
            <button className="older-button" onClick={loadOlder} disabled={state.loadingOlder}>
              {state.loadingOlder ? "加载中…" : "加载更早消息"}
            </button>
          ) : null}
          {!state.loading && visibleMessages.length === 0 ? (
            <div className="empty-state"><h2>当前片段会话已就绪</h2><p>你可以让 AI 阅读当前片段并提出修改建议。</p></div>
          ) : null}
          {turns.map((turn) => (
            <ConversationTurn
              key={turn.key}
              turn={turn}
              threadId={threadId}
              pending={turn.key === pendingTurnKey}
              cancelling={state.cancelling && (turn.turnId === state.activeTurnId || turn.key === pendingTurnKey)}
              assets={assets}
              onSelectReference={onSelectReference}
            />
          ))}
          </div>
        </div>
        {scroll.awayFromLatest ? (
          <button
            className="jump-to-latest"
            type="button"
            aria-label="回到最新消息"
            title="回到最新消息"
            onClick={scroll.scrollToLatest}
          >
            <Icon name="arrow-down" />
          </button>
        ) : null}
      </div>
      {state.syncError ? <div role="status" className="conversation-sync-error">{state.syncError}</div> : null}
      {state.error && !hasRecordedError ? <div role="alert" className="conversation-error">{state.error}</div> : null}
      <ConversationComposer
        draft={draft}
        assets={assets}
        busy={busy}
        sending={state.sending}
        cancelling={state.cancelling}
        runtimeModel={runtimeModel}
        runtimeModelLoading={runtimeModelLoading}
        onDraftChange={setDraft}
        onSend={send}
        onStop={stop}
      />
    </div>
  );
}
