import { memo, useEffect, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { Message } from "../types";
import { Icon } from "../workspace/Icons";
import { messageText } from "./conversationTurnModel";

export const UserMessage = memo(function UserMessage({ message }: { message: Message }) {
  const text = messageText(message);
  return (
    <article className="message user">
      <div className="message-content">
        <div className="message-body"><span className="message-text">{text}</span></div>
        <MessageActions text={text} createdAt={message.createdAt} />
      </div>
    </article>
  );
});

export const AssistantMessage = memo(function AssistantMessage({
  text,
  createdAt,
  streaming = false,
  interrupted = false,
}: {
  text: string;
  createdAt?: string;
  streaming?: boolean;
  interrupted?: boolean;
}) {
  if (!text) return null;
  return (
    <article className="message assistant" data-streaming={streaming || undefined}>
      <div className="message-content">
        {interrupted ? <div className="assistant-response-state">回答已停止，以下为已生成内容</div> : null}
        <div className="message-body" aria-live={streaming ? "polite" : undefined}>
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{text}</ReactMarkdown>
          {streaming ? <span className="stream-cursor" aria-hidden="true" /> : null}
        </div>
        {!streaming ? <MessageActions text={text} createdAt={createdAt} /> : null}
      </div>
    </article>
  );
});

function MessageActions({ text, createdAt }: { text: string; createdAt?: string }) {
  const [copyState, setCopyState] = useState<"idle" | "copied" | "error">("idle");

  useEffect(() => {
    if (copyState === "idle") return;
    const timeout = window.setTimeout(() => setCopyState("idle"), 1_600);
    return () => window.clearTimeout(timeout);
  }, [copyState]);

  const timestamp = createdAt ? formatTimestamp(createdAt) : null;
  return (
    <div className="message-actions">
      {timestamp ? <time dateTime={createdAt} title={timestamp.title}>{timestamp.label}</time> : null}
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

function formatTimestamp(createdAt: string) {
  const date = new Date(createdAt);
  if (!Number.isFinite(date.getTime())) return null;
  return {
    label: new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit" }).format(date),
    title: new Intl.DateTimeFormat("zh-CN", {
      year: "numeric", month: "long", day: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit",
    }).format(date),
  };
}
