import type { ReactNode } from "react";
import type { ChangeProposal } from "../productApi/generated";
import { ProposalBadge } from "./ProposalBadge";
import "./proposals.css";

type ProposalTargetBoundaryProps = {
  proposals: ChangeProposal[];
  children: ReactNode;
  className?: string;
  onOpenProposal?: (proposal: ChangeProposal) => void;
};

export function ProposalTargetBoundary({ proposals, children, className = "", onOpenProposal }: ProposalTargetBoundaryProps) {
  const active = proposals.filter((proposal) => proposal.status === "pending" || proposal.status === "conflicted");
  const conflict = active.find((proposal) => proposal.status === "conflicted");
  const primary = conflict ?? active[0];
  const state = conflict ? "conflicted" : primary ? "pending" : "none";

  return (
    <div className={`proposal-target proposal-target--${state}${className ? ` ${className}` : ""}`}>
      {children}
      {primary ? (
        <button type="button" className="proposal-target__open" onClick={() => onOpenProposal?.(primary)} aria-label={`查看${active.length}条${conflict ? "冲突" : "待确认"}建议`}>
          <ProposalBadge status={conflict ? "conflicted" : "pending"} count={active.length} />
        </button>
      ) : null}
    </div>
  );
}
