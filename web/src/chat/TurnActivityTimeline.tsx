import { memo, useEffect, useId, useState, type ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Icon } from "../workspace/Icons";
import { formatDuration, type TurnActivityProjection } from "./conversationActivityModel";
import { ToolActivityDetails } from "./ToolActivityDetails";

export const TurnActivityTimeline = memo(function TurnActivityTimeline({
  activity,
  threadId,
}: {
  activity: TurnActivityProjection;
  threadId: string;
}) {
  const bodyId = useId();
  const [expanded, setExpanded] = useState(activity.active || activity.phase.tone === "error");
  const now = useRunningClock(activity.active);
  const elapsed = (activity.endedAt ?? now) - activity.startedAt;
  const hasEntries = Boolean(activity.reasoning || activity.commentary || activity.toolGroups.length);
  const state = activity.phase.tone;
  const label = state === "complete" ? "已处理" : activity.phase.label;

  useEffect(() => {
    if (activity.active || state === "error") setExpanded(true);
    else setExpanded(false);
  }, [activity.active, state]);

  return (
    <section className="turn-activity" data-state={state} aria-label="Agent 运行过程">
      <button
        className={`turn-activity-header ${hasEntries ? "" : "is-static"}`.trim()}
        type="button"
        disabled={!hasEntries}
        aria-expanded={hasEntries ? expanded : undefined}
        aria-controls={hasEntries ? bodyId : undefined}
        onClick={() => hasEntries && setExpanded((current) => !current)}
      >
        <span className="turn-activity-heading" aria-live={activity.active ? "polite" : undefined}>
          <strong>{label}</strong>
          {activity.phase.detail ? <small>{activity.phase.detail}</small> : null}
          <time>{formatDuration(elapsed)}</time>
        </span>
        {hasEntries ? (
          <span className="turn-activity-chevron" aria-hidden="true"><Icon name="chevron-down" /></span>
        ) : null}
      </button>

      {hasEntries && expanded ? (
        <div className="turn-activity-body" id={bodyId} aria-live={activity.active ? "polite" : undefined}>
          {activity.reasoning ? (
            <ActivityDisclosure label="Reasoning" meta={`${activity.reasoning.length} 字`} active={activity.active}>
              <div className="activity-plain-text">{activity.reasoning}</div>
            </ActivityDisclosure>
          ) : null}
          {activity.commentary ? (
            <ActivityDisclosure label="Commentary" active={activity.active}>
              <div className="activity-markdown"><ReactMarkdown remarkPlugins={[remarkGfm]}>{activity.commentary}</ReactMarkdown></div>
            </ActivityDisclosure>
          ) : null}
          {activity.toolGroups.map((group) => (
            <ToolActivityDetails key={group.key} group={group} threadId={threadId} now={now} />
          ))}
        </div>
      ) : null}
    </section>
  );
});

export function PendingTurnStatus({ cancelling = false }: { cancelling?: boolean }) {
  return (
    <section className="turn-activity" data-state={cancelling ? "cancelled" : "running"}>
      <div className="turn-activity-header is-static" role="status" aria-live="polite">
        <span className="turn-activity-heading">
          <strong>{cancelling ? "正在停止" : "处理中"}</strong>
          <small>{cancelling ? "等待当前操作安全结束" : "正在创建运行上下文"}</small>
        </span>
      </div>
    </section>
  );
}

function ActivityDisclosure({
  label,
  meta,
  active,
  children,
}: {
  label: string;
  meta?: string;
  active: boolean;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(active);

  useEffect(() => setOpen(active), [active]);

  return (
    <details className="activity-entry" open={open} onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary>
        <span className={`activity-entry-dot ${active ? "is-running" : "is-complete"}`} aria-hidden="true" />
        <span>{label}</span>
        {meta ? <small>{meta}</small> : null}
        <Icon name="chevron-down" />
      </summary>
      <div className="activity-entry-body">{children}</div>
    </details>
  );
}

function useRunningClock(running: boolean) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!running) return;
    setNow(Date.now());
    const interval = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(interval);
  }, [running]);
  return now;
}
