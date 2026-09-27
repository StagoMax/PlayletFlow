import { memo, useEffect, useState } from "react";
import { api } from "../api";
import type { ToolResult } from "../types";
import { Icon } from "../workspace/Icons";
import { eventTime, formatDuration, type ToolActivity, type ToolActivityGroup } from "./conversationActivityModel";
import { toolGroupPresentation, toolPresentation } from "./toolActivityPresentation";

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

  if (group.tools.length === 1) {
    return <ToolActivityItem tool={group.tools[0]} threadId={threadId} now={now} />;
  }

  const presentation = toolGroupPresentation(group.group, group.tools.length);
  return (
    <details className="activity-entry tool-group" open={open} onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary>
        <span className="activity-entry-icon" data-icon={presentation.icon} aria-hidden="true"><Icon name={presentation.icon} /></span>
        <span>{presentation.title}</span>
        <small>{formatDuration(endedAt - startedAt)}</small>
        <span className="activity-entry-chevron"><Icon name="chevron-down" /></span>
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
  const presentation = toolPresentation(tool.call);

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
        <span className="tool-card-icon" data-icon={presentation.icon} aria-hidden="true"><Icon name={presentation.icon} /></span>
        <span title={tool.call.name}>{presentation.title}</span>
        <small>{tool.finished ? "已完成" : "运行中"} · {formatDuration(endedAt - startedAt)}</small>
        <span className="tool-card-chevron"><Icon name="chevron-down" /></span>
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
