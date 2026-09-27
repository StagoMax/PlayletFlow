import { useEffect, useRef, useState, type FormEvent } from "react";
import type { StoryboardDetail } from "../productApi/generated";
import { Icon } from "../workspace/Icons";

export function DeleteStoryboardDialog({ storyboard, lastStoryboard, onCancel, onDelete }: {
  storyboard: StoryboardDetail;
  lastStoryboard: boolean;
  onCancel: () => void;
  onDelete: (storyboardId: string) => Promise<void>;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    const dialog = dialogRef.current;
    dialog?.showModal();
    return () => dialog?.close();
  }, []);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError("");
    try { await onDelete(storyboard.id); }
    catch (cause) {
      setError(cause instanceof Error ? cause.message : "删除片段失败，请重试。");
      setBusy(false);
    }
  };
  return (
    <dialog ref={dialogRef} className="resource-dialog" aria-labelledby="storyboard-delete-title"
      onCancel={(event) => { event.preventDefault(); if (!busy) onCancel(); }}>
      <form onSubmit={(event) => void submit(event)}>
        <div className="resource-dialog__icon"><Icon name="folder" /></div>
        <div className="resource-dialog__heading">
          <span id="storyboard-delete-title">删除片段</span>
          <small>{storyboard.name}</small>
        </div>
        <p className="resource-dialog__message">
          确定删除“{storyboard.name}”吗？片段内的脚本和所有资源也会删除。
          {lastStoryboard ? "系统会创建一个空白片段。" : ""}
        </p>
        <p className="resource-dialog__message">脚本 {storyboard.script.text.trim() ? 1 : 0} · 关键帧 {storyboard.counts.keyframes} · 视频 {storyboard.counts.videos} · 待确认提案 {storyboard.pendingProposalCount}</p>
        {error ? <p role="alert">{error}</p> : null}
        <div className="resource-dialog__actions">
          <button type="button" onClick={onCancel} disabled={busy}>取消</button>
          <button type="submit" disabled={busy} className="danger">{busy ? "处理中…" : "删除"}</button>
        </div>
      </form>
    </dialog>
  );
}
