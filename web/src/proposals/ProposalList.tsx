import type { ChangeProposal } from "../productApi/generated";
import { ProposalBadge } from "./ProposalBadge";
import { proposalTargetLabel } from "./proposalTargets";
import "./proposals.css";

type ProposalListProps = {
  proposals: ChangeProposal[];
  selectedProposalId?: string | null;
  onSelect: (proposal: ChangeProposal) => void;
};

export function ProposalList({ proposals, selectedProposalId, onSelect }: ProposalListProps) {
  if (proposals.length === 0) {
    return <p className="proposal-list__empty" role="status">当前分镜没有待处理的 AI 建议。</p>;
  }

  return (
    <div className="proposal-list" aria-label="AI 变更建议">
      {proposals.map((proposal) => (
        <button
          type="button"
          key={proposal.id}
          className={`proposal-list__item${selectedProposalId === proposal.id ? " is-selected" : ""}`}
          aria-pressed={selectedProposalId === proposal.id}
          onClick={() => onSelect(proposal)}
        >
          <span><strong>{proposalTargetLabel(proposal.target)}</strong><small>{proposal.summary}</small></span>
          <ProposalBadge status={proposal.status} />
        </button>
      ))}
    </div>
  );
}
