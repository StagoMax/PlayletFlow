import { memo, useLayoutEffect, useRef, useState } from "react";
import { ComposerDropOverlay } from "../composer/ComposerDropOverlay";
import { ComposerSources } from "../composer/ComposerSources";
import { ComposerToolbar } from "../composer/ComposerToolbar";
import { referenceMarker } from "../composer/assetMention";
import {
  composeConversationSubmission,
  type ConversationSubmission,
} from "../composer/submission";
import type { ComposerAssetReference } from "../composer/types";
import { useAssetMention } from "../composer/useAssetMention";
import { useComposerAttachments } from "../composer/useComposerAttachments";

type ConversationComposerProps = {
  draft: string;
  busy: boolean;
  sending: boolean;
  cancelling: boolean;
  runtimeModel: string | null;
  runtimeModelLoading: boolean;
  assets: readonly ComposerAssetReference[];
  onDraftChange: (value: string) => void;
  onSend: (submission: ConversationSubmission) => void;
  onStop: () => void;
};

export const ConversationComposer = memo(function ConversationComposer({
  draft,
  busy,
  sending,
  cancelling,
  runtimeModel,
  runtimeModelLoading,
  assets,
  onDraftChange,
  onSend,
  onStop,
}: ConversationComposerProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [references, setReferences] = useState<ComposerAssetReference[]>([]);
  const attachments = useComposerAttachments();
  const mentions = useAssetMention({
    value: draft,
    assets,
    textareaRef,
    onChange: onDraftChange,
    onReference: (asset) => setReferences((current) =>
      current.some((item) => item.id === asset.id) ? current : [...current, asset]),
  });

  useLayoutEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    textarea.style.height = "0px";
    textarea.style.height = `${Math.min(textarea.scrollHeight, 150)}px`;
    textarea.style.overflowY = textarea.scrollHeight > 150 ? "auto" : "hidden";
  }, [draft]);

  function submit() {
    if (busy || !draft.trim()) return;
    onSend(composeConversationSubmission(draft, references, attachments.attachments));
    setReferences([]);
    attachments.clearAttachments();
    mentions.close();
  }

  function removeReference(id: string) {
    const reference = references.find((item) => item.id === id);
    setReferences((current) => current.filter((item) => item.id !== id));
    if (reference) {
      onDraftChange(draft.replaceAll(referenceMarker(reference), "").replace(/ {2,}/gu, " "));
    }
  }

  return (
    <form
      className={`composer composer-focus-surface ${busy ? "is-running" : ""}`}
      {...attachments.dragHandlers}
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      {attachments.dragging ? <ComposerDropOverlay /> : null}
      <input
        ref={attachments.inputRef}
        type="file"
        accept="image/*,video/*,text/*,.md,.markdown,.json,.csv,.tsv,.srt,.vtt"
        multiple
        hidden
        onChange={(event) => {
          void attachments.addFiles(Array.from(event.target.files ?? []));
          event.target.value = "";
        }}
      />
      <ComposerSources
        references={references}
        attachments={attachments.attachments}
        onRemoveReference={removeReference}
        onRemoveAttachment={attachments.removeAttachment}
      />
      {attachments.error ? <p role="alert" className="shared-composer-error">{attachments.error}</p> : null}
      <label className="sr-only" htmlFor="conversation-composer">输入消息</label>
      <textarea
        ref={textareaRef}
        id="conversation-composer"
        aria-label="输入消息"
        aria-autocomplete="list"
        aria-expanded={mentions.isOpen}
        aria-controls={mentions.isOpen ? mentions.listboxId : undefined}
        placeholder={busy ? "AI 正在运行，你可以继续编辑下一条消息" : "向 Agent 发送消息"}
        value={draft}
        rows={1}
        onChange={(event) => {
          const next = event.target.value;
          onDraftChange(next);
          setReferences((current) => current.filter((reference) => next.includes(referenceMarker(reference))));
          mentions.onTextChange(next, event.target.selectionStart);
        }}
        onKeyDown={(event) => {
          if (event.nativeEvent.isComposing) return;
          if (mentions.onKeyDown(event)) return;
          if (event.key === "Escape" && busy) {
            event.preventDefault();
            onStop();
            return;
          }
          if (event.key === "Enter" && !event.shiftKey) {
            event.preventDefault();
            if (!busy) submit();
          }
        }}
      />
      {mentions.menu}
      <ComposerToolbar
        onAttach={attachments.openFilePicker}
        onMention={mentions.openAtCaret}
        controls={(
          <div className="composer-runtime-model" role="status" aria-label="当前 Agent 模型">
            {runtimeModelLoading ? "加载模型…" : runtimeModel ?? "模型信息不可用"}
          </div>
        )}
        action={{
          type: busy ? "button" : "submit",
          icon: busy ? "stop" : "send",
          label: busy ? (cancelling ? "正在停止运行" : "停止运行") : "发送消息",
          tone: busy ? "danger" : "primary",
          onClick: busy ? onStop : undefined,
          disabled: busy ? cancelling : !draft.trim() || sending,
        }}
      />
    </form>
  );
});
