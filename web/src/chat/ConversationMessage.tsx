import { memo, useEffect, useMemo, useState } from "react";
import type { Message } from "../types";
import type { ComposerAssetReference } from "../composer/types";
import { Icon } from "../workspace/Icons";
import { messageClipboardText } from "./conversationTurnModel";
import { MarkdownContent } from "./MarkdownContent";
import { MessageReferenceChip } from "./MessageReferenceChip";
import { workspaceReferenceFromPart } from "./workspaceReference";

export const UserMessage = memo(function UserMessage({
  message,
  assets,
  onSelectReference,
}: {
  message: Message;
  assets: readonly ComposerAssetReference[];
  onSelectReference: (reference: ComposerAssetReference) => void;
}) {
  const text = messageClipboardText(message);
  const assetsById = useMemo(
    () => new Map(assets.map((asset) => [asset.id, asset])),
    [assets],
  );
  return (
    <article className="message user">
      <div className="message-content">
        <div className="message-body">
          {message.parts.map((part, index) => {
            if (part.type === "text" && typeof part.text === "string") {
              return <span className="message-text" key={index}>{part.text}</span>;
            }
            const reference = workspaceReferenceFromPart(part);
            return reference ? (
              <MessageReferenceChip
                key={`${reference.id}:${index}`}
                reference={reference}
                asset={assetsById.get(reference.id)}
                onSelectReference={onSelectReference}
              />
            ) : null;
          })}
        </div>
        <MessageActions text={text} />
      </div>
    </article>
  );
});

export const AssistantMessage = memo(function AssistantMessage({
  text,
  streaming = false,
  interrupted = false,
}: {
  text: string;
  streaming?: boolean;
  interrupted?: boolean;
}) {
  if (!text) return null;
  return (
    <article className="message assistant" data-streaming={streaming || undefined}>
      <div className="message-content">
        {interrupted ? <div className="assistant-response-state">回答已停止，以下为已生成内容</div> : null}
        <div className="message-body" aria-live={streaming ? "polite" : undefined}>
          <MarkdownContent text={text} />
          {streaming ? <span className="stream-cursor" aria-hidden="true" /> : null}
        </div>
        {!streaming ? <MessageActions text={text} /> : null}
      </div>
    </article>
  );
});

function MessageActions({ text }: { text: string }) {
  const [copyState, setCopyState] = useState<"idle" | "copied" | "error">("idle");

  useEffect(() => {
    if (copyState === "idle") return;
    const timeout = window.setTimeout(() => setCopyState("idle"), 1_600);
    return () => window.clearTimeout(timeout);
  }, [copyState]);

  return (
    <div className="message-actions">
      <button
        type="button"
        className="message-action-button"
        data-state={copyState}
        aria-label={copyState === "copied" ? "消息已复制" : copyState === "error" ? "复制失败，重试" : "复制消息"}
        title={copyState === "copied" ? "已复制" : copyState === "error" ? "复制失败" : "复制消息"}
        onClick={() => {
          void navigator.clipboard.writeText(text)
            .then(() => setCopyState("copied"))
            .catch(() => setCopyState("error"));
        }}
      >
        <Icon name={copyState === "copied" ? "check" : "copy"} />
      </button>
      <span className="sr-only" aria-live="polite">
        {copyState === "copied" ? "消息已复制到剪贴板" : copyState === "error" ? "消息复制失败" : ""}
      </span>
    </div>
  );
}
