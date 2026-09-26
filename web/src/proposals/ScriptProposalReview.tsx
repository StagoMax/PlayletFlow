import type { ChangeProposal } from "../productApi/generated";
import { ProposalDiff } from "./ProposalDiff";
import "./proposals.css";

type ScriptProposalReviewProps = {
  proposal: ChangeProposal;
};

export function ScriptProposalReview({ proposal }: ScriptProposalReviewProps) {
  return (
    <ProposalDiff
      beforeValue={proposal.beforeValue}
      proposedValue={proposal.proposedValue}
      variant="editor"
    />
  );
}
