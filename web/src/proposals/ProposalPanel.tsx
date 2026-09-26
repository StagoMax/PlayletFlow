import { useEffect, useState } from "react";
import type { ApplyProposalResponse, ChangeProposal, GenerationJob } from "../productApi/generated";
import type { ProposalClient } from "./proposalClient";
import { ProposalDecision, type ProposalGenerationContext } from "./ProposalDecision";
import { ProposalBadge } from "./ProposalBadge";
import { ProposalDiff } from "./ProposalDiff";
import { proposalTargetLabel } from "./proposalTargets";
import "./proposals.css";

type ProposalPanelProps = {
  client: ProposalClient;
  projectId: string;
  proposal: ChangeProposal;
  currentTargetRevision: number;
  generationContext?: ProposalGenerationContext;
  applyBlockedReason?: string;
  onProposalChange?: (proposal: ChangeProposal) => void;
  onApplied?: (response: ApplyProposalResponse) => void;
};

function proposalNotice(status: ChangeProposal["status"]) {
  switch (status) {
    case "applied":
      return "这条建议已经应用到正式内容。";
    case "rejected":
      return "这条建议已取消，正式内容没有因此改变。";
    case "expired":
      return "建议目标已不存在或已过期，无法再应用。";
    case "failed":
      return "建议处理失败，正式内容未被覆盖。";
    default:
      return "AI 的建议尚未写入正式内容。只有确认成功后才会应用。";
  }
}

export function ProposalPanel({
  client,
  projectId,
  proposal,
  currentTargetRevision,
  generationContext,
  applyBlockedReason,
  onProposalChange,
  onApplied,
}: ProposalPanelProps) {
  const [generationFeedback, setGenerationFeedback] = useState<{ proposalId: string; job: GenerationJob } | null>(null);
  const generationJob = generationFeedback?.proposalId === proposal.id ? generationFeedback.job : null;

  useEffect(() => {
    if (!generationJob || ["succeeded", "failed", "cancelled"].includes(generationJob.status)) return;
    const controller = new AbortController();
    let timer = 0;
    const poll = async () => {
      try {
        const job = await client.getGeneration(projectId, generationJob.id, controller.signal);
        setGenerationFeedback({ proposalId: proposal.id, job });
      } catch (cause) {
          if (!(cause instanceof DOMException && cause.name === "AbortError")) {
            // A transient poll failure leaves the last confirmed status visible;
            // the next poll can try again.
          }
      } finally {
        if (!controller.signal.aborted) timer = window.setTimeout(() => void poll(), 2_500);
      }
    };
    timer = window.setTimeout(() => void poll(), 2_500);
    return () => {
      controller.abort();
      window.clearTimeout(timer);
    };
  }, [client, generationJob, projectId, proposal.id]);

  function applied(response: ApplyProposalResponse) {
    setGenerationFeedback(response.generationJob ? { proposalId: proposal.id, job: response.generationJob } : null);
    onProposalChange?.(response.proposal);
    onApplied?.(response);
  }

  return (
    <article className={`proposal-panel proposal-panel--${proposal.status}`}>
      <header className="proposal-panel__header">
        <div><small>{proposalTargetLabel(proposal.target)}</small><h2>{proposal.summary}</h2></div>
        <ProposalBadge status={proposal.status} />
      </header>
      <p className="proposal-panel__notice">{proposalNotice(proposal.status)}</p>
      <ProposalDiff beforeValue={proposal.beforeValue} proposedValue={proposal.proposedValue} />
      <dl className="proposal-panel__meta">
        <div><dt>建议版本</dt><dd>{proposal.revision}</dd></div>
        <div><dt>基于内容版本</dt><dd>{proposal.baseRevision}</dd></div>
        <div><dt>当前内容版本</dt><dd>{currentTargetRevision}</dd></div>
      </dl>
      <ProposalDecision
        key={`${proposal.id}:${proposal.revision}:${proposal.status}`}
        client={client}
        projectId={projectId}
        proposal={proposal}
        currentTargetRevision={currentTargetRevision}
        generationContext={generationContext}
        applyBlockedReason={applyBlockedReason}
        onApplied={applied}
        onRejected={onProposalChange}
        onConflict={() => {
          void client.get(projectId, proposal.id).then((latest) => onProposalChange?.(latest)).catch(() => undefined);
        }}
      />
      {generationJob ? <GenerationFeedback job={generationJob} /> : null}
    </article>
  );
}

function GenerationFeedback({ job }: { job: GenerationJob }) {
  const labels: Record<GenerationJob["status"], string> = {
    queued: "已进入生成队列",
    waitingForProvider: "提示词已保存，正在等待生成能力",
    running: "正在重新生成媒体",
    succeeded: "媒体生成完成",
    failed: "媒体生成失败，可从生成任务重试",
    cancelled: "生成任务已取消",
  };
  return (
    <div className={`proposal-generation proposal-generation--${job.status}`} role="status">
      <strong>{labels[job.status]}</strong>
      <small>任务 {job.id} · 第 {job.attempt} 次尝试</small>
      {job.error ? <span>{job.error}</span> : null}
      {job.resultMediaId ? <span>结果媒体 {job.resultMediaId}</span> : null}
    </div>
  );
}
