import type { ChangeProposal, ProposalTarget } from "../productApi/generated";

export function proposalTargetKey(target: ProposalTarget) {
  switch (target.type) {
    case "script":
      return `script:${target.storyboardId}`;
    case "mediaPrompt":
      return `mediaPrompt:${target.mediaId}`;
    case "assetBindingPrompt":
      return `assetBindingPrompt:${target.bindingId}`;
  }
}

export function groupActiveProposals(proposals: ChangeProposal[]) {
  const groups = new Map<string, ChangeProposal[]>();
  for (const proposal of proposals) {
    if (proposal.status !== "pending" && proposal.status !== "conflicted") continue;
    const key = proposalTargetKey(proposal.target);
    const group = groups.get(key) ?? [];
    group.push(proposal);
    groups.set(key, group);
  }
  return groups;
}

export function pendingProposalCountsByBinding(proposals: ChangeProposal[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const proposal of proposals) {
    if (proposal.target.type !== "assetBindingPrompt") continue;
    if (proposal.status !== "pending" && proposal.status !== "conflicted") continue;
    counts[proposal.target.bindingId] = (counts[proposal.target.bindingId] ?? 0) + 1;
  }
  return counts;
}

export function proposalTargetLabel(target: ProposalTarget) {
  switch (target.type) {
    case "script":
      return "分镜脚本";
    case "mediaPrompt":
      return "媒体提示词";
    case "assetBindingPrompt":
      return "分镜资产提示词";
  }
}
