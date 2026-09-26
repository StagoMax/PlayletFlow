import { useRef, useState } from "react";
import type { ApplyProposalResponse, ChangeProposal, GenerationOptions } from "../productApi/generated";
import { ProposalApiError, type ProposalClient } from "./proposalClient";
import "./proposals.css";

type ProposalActionsProps = {
  client: ProposalClient;
  projectId: string;
  proposal: ChangeProposal;
  currentTargetRevision: number;
  generation?: GenerationOptions;
  applyBlockedReason?: string;
  layout?: "panel" | "toolbar";
  onApplied?: (response: ApplyProposalResponse) => void;
  onRejected?: (proposal: ChangeProposal) => void;
  onConflict?: (error: ProposalApiError) => void;
};

export function ProposalActions({
  client,
  projectId,
  proposal,
  currentTargetRevision,
  generation,
  applyBlockedReason,
  layout = "panel",
  onApplied,
  onRejected,
  onConflict,
}: ProposalActionsProps) {
  const keys = useRef<Partial<Record<"apply" | "reject", string>>>({});
  const [operation, setOperation] = useState<"idle" | "applying" | "rejecting" | "resolved">("idle");
  const [message, setMessage] = useState("");
  const [locallyConflicted, setLocallyConflicted] = useState(false);
  const busy = operation === "applying" || operation === "rejecting";
  const rejectLabel = layout === "toolbar" ? "取消" : "取消建议";
  const applyLabel = layout === "toolbar" ? "确认" : "确认并应用";
  const applyProgressLabel = "确认中…";
  const canApply = proposal.status === "pending" && !locallyConflicted && !applyBlockedReason && operation !== "resolved";
  const canReject = (proposal.status === "pending" || proposal.status === "conflicted" || locallyConflicted) && operation !== "resolved";

  async function apply() {
    if (!canApply || busy) return;
    setOperation("applying");
    setMessage("");
    const key = keys.current.apply ?? crypto.randomUUID();
    keys.current.apply = key;
    try {
      const response = await client.apply(projectId, proposal.id, {
        expectedProposalRevision: proposal.revision,
        expectedTargetRevision: currentTargetRevision,
        generation,
      }, key);
      keys.current.apply = undefined;
      setOperation("resolved");
      setMessage(response.generationJob ? "变更已应用，已创建生成任务。" : "变更已应用。正式内容现已更新。");
      onApplied?.(response);
    } catch (cause) {
      if (cause instanceof ProposalApiError) {
        keys.current.apply = undefined;
        if (cause.status === 409) {
          setLocallyConflicted(true);
          setMessage("正式内容已发生变化，这条建议不能直接应用。请刷新内容后重新发起建议，或取消本提案。");
          onConflict?.(cause);
        } else setMessage(cause.message);
      } else {
        setMessage("网络响应不明确。再次确认会复用同一个幂等请求，不会重复创建生成任务。");
      }
      setOperation("idle");
    }
  }

  async function reject() {
    if (!canReject || busy) return;
    setOperation("rejecting");
    setMessage("");
    const key = keys.current.reject ?? crypto.randomUUID();
    keys.current.reject = key;
    try {
      const response = await client.reject(projectId, proposal.id, {
        expectedProposalRevision: proposal.revision,
        expectedTargetRevision: currentTargetRevision,
      }, key);
      keys.current.reject = undefined;
      setOperation("resolved");
      setMessage("建议已取消，正式内容没有变化。");
      onRejected?.(response);
    } catch (cause) {
      if (cause instanceof ProposalApiError) {
        keys.current.reject = undefined;
        setMessage(cause.message);
      } else {
        setMessage("网络响应不明确。再次取消会复用同一个幂等请求。");
      }
      setOperation("idle");
    }
  }

  if (proposal.status !== "pending" && proposal.status !== "conflicted" && operation !== "resolved") {
    return <p className="proposal-actions__resolved">这条建议已经处理，不能再次确认或取消。</p>;
  }

  return (
    <div className={`proposal-actions proposal-actions--${layout}`}>
      {(proposal.status === "conflicted" || locallyConflicted) ? (
        <p className="proposal-actions__conflict" role="alert"><strong>版本冲突</strong> 当前正式内容与 AI 提出建议时的版本不同，系统不会覆盖新内容。</p>
      ) : null}
      {applyBlockedReason ? <p className="proposal-actions__blocked" role="status">{applyBlockedReason}</p> : null}
      {message ? <p className="proposal-actions__message" role="status">{message}</p> : null}
      <div className="proposal-actions__buttons">
        <button type="button" onClick={() => void reject()} disabled={!canReject || busy}>
          {operation === "rejecting" ? "取消中…" : rejectLabel}
        </button>
        <button type="button" className="is-primary" onClick={() => void apply()} disabled={!canApply || busy}>
          {operation === "applying" ? applyProgressLabel : applyLabel}
        </button>
      </div>
    </div>
  );
}
