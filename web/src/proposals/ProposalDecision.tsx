import { useState } from "react";
import type { ApplyProposalResponse, ChangeProposal, GenerationOptions, MediaKind } from "../productApi/generated";
import { GenerationControls, type GenerationMediaOption } from "../generation/GenerationControls";
import { createDefaultGenerationOptions } from "../generation/generationOptions";
import { ProposalActions } from "./ProposalActions";
import type { ProposalClient, ProposalApiError } from "./proposalClient";

export type ProposalGenerationContext = {
  kind: MediaKind;
  media: GenerationMediaOption[];
};

type ProposalDecisionProps = {
  client: ProposalClient;
  projectId: string;
  proposal: ChangeProposal;
  currentTargetRevision: number;
  generationContext?: ProposalGenerationContext;
  applyBlockedReason?: string;
  onApplied: (response: ApplyProposalResponse) => void;
  onRejected?: (proposal: ChangeProposal) => void;
  onConflict: (error: ProposalApiError) => void;
};

export function ProposalDecision({
  client,
  projectId,
  proposal,
  currentTargetRevision,
  generationContext,
  applyBlockedReason,
  onApplied,
  onRejected,
  onConflict,
}: ProposalDecisionProps) {
  const [generation, setGeneration] = useState<GenerationOptions | undefined>(() => {
    if (!generationContext) return undefined;
    return createDefaultGenerationOptions(generationContext.kind);
  });

  return (
    <>
      {generationContext && generation ? (
        <GenerationControls
          loadModels={client.listGenerationModels}
          kind={generationContext.kind}
          media={generationContext.media}
          value={generation}
          onChange={setGeneration}
          disabled={proposal.status !== "pending"}
        />
      ) : null}
      <ProposalActions
        client={client}
        projectId={projectId}
        proposal={proposal}
        currentTargetRevision={currentTargetRevision}
        generation={generation}
        applyBlockedReason={applyBlockedReason}
        onApplied={onApplied}
        onRejected={onRejected}
        onConflict={onConflict}
      />
    </>
  );
}
