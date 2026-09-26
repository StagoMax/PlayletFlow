import { memo, useEffect, useState } from "react";
import { api } from "../api";
import type { ToolResult } from "../types";
import { Icon } from "../workspace/Icons";
import { eventTime, formatDuration, type ToolActivity, type ToolActivityGroup } from "./conversationActivityModel";

export const ToolActivityDetails = memo(function ToolActivityDetails({
  group,
  threadId,
  now,
}: {
  group: ToolActivityGroup;
  threadId: string;
  now: number;
}) {
  const running = group.tools.some((tool) => !tool.finished);
  const [open, setOpen] = useState(running);
  const startedAt = Math.min(...group.tools.map((tool) => eventTime(tool.started) ?? now));
  const completedTimes = group.tools
    .map((tool) => eventTime(tool.finished))
    .filter((time): time is number => time !== undefined);
  const endedAt = running || !completedTimes.length ? now : Math.max(...completedTimes);

  useEffect(() => {
    if (running) setOpen(true);
  }, [running]);

  return (
    <details className="activity-entry tool-group" open={open} onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary>
        <span className={`activity-entry-dot ${running ? "is-running" : "is-complete"}`} aria-hidden="true" />
        <span>{running ? "正在调用工具" : "工具调用"}</span>
        <small>{group.tools.length} 项 · {formatDuration(endedAt - startedAt)}</small>
        <Icon name="chevron-down" />
      </summary>
      <div className="activity-entry-body tool-group-body">
        {group.tools.map((tool) => (
          <ToolActivityItem key={tool.call.id} tool={tool} threadId={threadId} now={now} />
        ))}
      </div>
    </details>
  );
});

function ToolActivityItem({ tool, threadId, now }: { tool: ToolActivity; threadId: string; now: number }) {
  const [detail, setDetail] = useState<ToolResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const startedAt = eventTime(tool.started) ?? now;
  const endedAt = eventTime(tool.finished) ?? now;

  async function showDetail() {
    if (!tool.finished || detail || loading) return;
    setLoading(true);
    setError(null);
    try {
      setDetail(await api.toolResult(threadId, tool.finished.id));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setLoading(false);
    }
  }

  return (
    <details className="tool-card">
      <summary>
        <span>{tool.call.name}</span>
        <small>{tool.finished ? "已完成" : "运行中"} · {formatDuration(endedAt - startedAt)}</small>
        <Icon name="chevron-down" />
      </summary>
      <div className="tool-card-body">
        <div className="tool-section-label">输入</div>
        <pre>{formatJson(tool.call.input)}</pre>
        {tool.result ? (
          <>
            <div className="tool-section-label">输出</div>
            <div className="tool-output">{detail?.output ?? tool.result.output}</div>
            <button type="button" onClick={() => void showDetail()} disabled={loading || Boolean(detail)}>
              {loading ? "加载中…" : detail ? "已显示完整结果" : "查看完整结果"}
            </button>
            {error ? <p className="tool-detail-error" role="alert">{error}</p> : null}
          </>
        ) : null}
      </div>
    </details>
  );
}

function formatJson(value: unknown) {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}
