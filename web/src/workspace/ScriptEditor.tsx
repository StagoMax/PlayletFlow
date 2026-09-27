import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type FormEvent,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import type { StoryboardDetail, StoryboardScript } from "../productApi/generated";
import { Icon } from "./Icons";

const MAX_SCRIPT_CHARS = 20_000;
const DRAFT_STORAGE_VERSION = "v1";

type SavePhase = "idle" | "saving" | "error";

type ScriptEditorProps = {
  storyboard: StoryboardDetail;
  onSave: (text: string, expectedRevision: number) => Promise<StoryboardScript>;
  onSaved?: () => void;
  review?: (state: { dirty: boolean; revision: number }) => {
    id: string;
    actions: ReactNode;
    text: string;
  } | null;
};

export function ScriptEditor({ storyboard, onSave, onSaved, review }: ScriptEditorProps) {
  const [restoredDraft] = useState(() => readDraft(storyboard));
  const [draft, setDraft] = useState(restoredDraft?.text ?? storyboard.script.text);
  const [savedText, setSavedText] = useState(storyboard.script.text);
  const [revision, setRevision] = useState(storyboard.script.revision);
  const [updatedAt, setUpdatedAt] = useState(storyboard.script.updatedAt);
  const [phase, setPhase] = useState<SavePhase>("idle");
  const [error, setError] = useState<string | null>(null);
  const [incoming, setIncoming] = useState<StoryboardScript | null>(null);
  const [editingReviewId, setEditingReviewId] = useState<string | null>(restoredDraft?.reviewId ?? null);
  const [dismissedReviewId, setDismissedReviewId] = useState<string | null>(null);
  const characterCount = useMemo(() => Array.from(draft).length, [draft]);
  const dirty = draft !== savedText;
  const candidateReview = review?.({ dirty: dirty || editingReviewId !== null, revision }) ?? null;
  const reviewDismissed = candidateReview?.id === dismissedReviewId;
  const reviewState = reviewDismissed ? null : candidateReview;
  const visibleCharacterCount = reviewState
    ? Array.from(reviewState.text).length
    : characterCount;

  useEffect(() => {
    const next = storyboard.script;
    if (next.revision === revision && next.text === savedText && next.updatedAt === updatedAt) return;
    if (dirty) {
      setIncoming(next);
      return;
    }
    setDraft(next.text);
    setSavedText(next.text);
    setRevision(next.revision);
    setUpdatedAt(next.updatedAt);
    setIncoming(null);
    setPhase("idle");
    setError(null);
  }, [dirty, revision, savedText, storyboard.script, updatedAt]);

  useEffect(() => {
    if (!dirty) return;
    const warnBeforeUnload = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener("beforeunload", warnBeforeUnload);
    return () => window.removeEventListener("beforeunload", warnBeforeUnload);
  }, [dirty]);

  useEffect(() => {
    const key = draftStorageKey(storyboard.id);
    if (!dirty) {
      window.sessionStorage.removeItem(key);
      return;
    }
    window.sessionStorage.setItem(key, JSON.stringify({
      baseRevision: revision,
      text: draft,
      reviewId: editingReviewId,
    }));
  }, [dirty, draft, editingReviewId, revision, storyboard.id]);

  const save = useCallback(async () => {
    if (!dirty || phase === "saving" || characterCount > MAX_SCRIPT_CHARS) return;
    const textToSave = draft;
    setPhase("saving");
    setError(null);
    try {
      const saved = await onSave(textToSave, revision);
      setSavedText(saved.text);
      setRevision(saved.revision);
      setUpdatedAt(saved.updatedAt);
      setIncoming(null);
      if (editingReviewId) setDismissedReviewId(editingReviewId);
      setEditingReviewId(null);
      setPhase("idle");
      onSaved?.();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "保存失败，请稍后重试。");
      setPhase("error");
    }
  }, [characterCount, dirty, draft, editingReviewId, onSave, onSaved, phase, revision]);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    void save();
  };

  const handleShortcut = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
      event.preventDefault();
      void save();
    }
  };

  return (
    <form className="script-editor" aria-label="片段脚本编辑器" onSubmit={submit}>
      <header className="canvas-header script-editor-header">
        <h1 className="canvas-title">片段脚本</h1>
        <div className="script-editor-actions">
          {reviewState ? reviewState.actions : (
            <>
              {editingReviewId ? (
                <button className="script-discard-button" type="button" disabled={phase === "saving"} onClick={() => {
                  setDraft(savedText);
                  setEditingReviewId(null);
                  setError(null);
                  setPhase("idle");
                }}>放弃修改</button>
              ) : null}
              <button className="script-save-button" type="submit" disabled={!dirty || phase === "saving" || characterCount > MAX_SCRIPT_CHARS}>
                <Icon name="save" />
                {phase === "saving" ? "保存中" : "保存"}
              </button>
            </>
          )}
        </div>
      </header>

      {incoming ? (
        <div className="script-editor-incoming" role="alert">
          <span><strong>正式脚本已有新版本</strong>当前本地草稿未被覆盖。载入版本 {incoming.revision} 会放弃这份未保存草稿。</span>
          <button
            type="button"
            onClick={() => {
              setDraft(incoming.text);
              setSavedText(incoming.text);
              setRevision(incoming.revision);
              setUpdatedAt(incoming.updatedAt);
              setIncoming(null);
              setEditingReviewId(null);
              setPhase("idle");
              setError(null);
            }}
          >
            载入最新版本
          </button>
        </div>
      ) : null}

      {reviewDismissed ? (
        <div className="script-editor-incoming" role="status">
          <span>人工脚本已保存；原 AI 建议仍可查看或取消。</span>
          <button type="button" onClick={() => setDismissedReviewId(null)}>查看原建议</button>
        </div>
      ) : null}

      <div className="script-editor-body">
        <label htmlFor="storyboard-script">脚本内容</label>
        <textarea
          id="storyboard-script"
          value={reviewState?.text ?? draft}
          onChange={(event) => {
            if (reviewState) setEditingReviewId(reviewState.id);
            setDraft(event.target.value);
            if (phase === "error") {
              setPhase("idle");
              setError(null);
            }
          }}
          onKeyDown={handleShortcut}
          placeholder="输入这个片段的场景、动作、对白与镜头描述…"
          spellCheck={false}
          aria-describedby="script-editor-hint script-editor-feedback"
        />
      </div>

      <footer className="script-editor-footer">
        <div id="script-editor-feedback" className={`script-editor-feedback${error ? " error" : ""}`}>
          {error ?? (editingReviewId
            ? "已修改 AI 建议 · 保存为人工脚本"
            : reviewState
              ? "AI 建议 · 可直接编辑，修改后保存为人工脚本"
              : dirty ? "未保存" : "已保存")}
        </div>
        <div id="script-editor-hint" className={visibleCharacterCount > MAX_SCRIPT_CHARS ? "over-limit" : ""}>
          {visibleCharacterCount.toLocaleString("zh-CN")} / {MAX_SCRIPT_CHARS.toLocaleString("zh-CN")} 字符
        </div>
      </footer>
    </form>
  );
}

function draftStorageKey(storyboardId: string) {
  return `videoflow:script-draft:${DRAFT_STORAGE_VERSION}:${storyboardId}`;
}

function readDraft(storyboard: StoryboardDetail) {
  try {
    const serialized = window.sessionStorage.getItem(draftStorageKey(storyboard.id));
    if (!serialized) return null;
    const draft = JSON.parse(serialized) as { baseRevision?: unknown; text?: unknown; reviewId?: unknown };
    if (draft.baseRevision !== storyboard.script.revision || typeof draft.text !== "string") {
      window.sessionStorage.removeItem(draftStorageKey(storyboard.id));
      return null;
    }
    return { text: draft.text, reviewId: typeof draft.reviewId === "string" ? draft.reviewId : null };
  } catch {
    return null;
  }
}
