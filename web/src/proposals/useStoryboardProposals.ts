import { useCallback, useEffect, useMemo, useState } from "react";
import type { ChangeProposal, ProposalStatus } from "../productApi/generated";
import type { ProposalClient } from "./proposalClient";
import { groupActiveProposals } from "./proposalTargets";

const DEFAULT_STATUSES: ProposalStatus[] = ["pending", "conflicted"];

export function useStoryboardProposals(
  client: ProposalClient,
  projectId: string,
  storyboardId: string,
  statuses: ProposalStatus[] = DEFAULT_STATUSES,
) {
  const statusKey = statuses.join(",");
  const [proposals, setProposals] = useState<ChangeProposal[]>([]);
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [error, setError] = useState("");
  const [reloadToken, setReloadToken] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    setState("loading");
    setError("");
    setProposals([]);
    const requestedStatuses = statusKey ? statusKey.split(",") as ProposalStatus[] : [];
    void client.list(projectId, storyboardId, requestedStatuses, controller.signal)
      .then((items) => {
        setProposals(items);
        setState("ready");
      })
      .catch((cause) => {
        if (controller.signal.aborted) return;
        setError(cause instanceof Error ? cause.message : String(cause));
        setState("error");
      });
    return () => controller.abort();
  }, [client, projectId, reloadToken, statusKey, storyboardId]);

  const updateProposal = useCallback((proposal: ChangeProposal) => {
    setProposals((current) => {
      if (proposal.status !== "pending" && proposal.status !== "conflicted") {
        return current.filter((item) => item.id !== proposal.id);
      }
      const found = current.some((item) => item.id === proposal.id);
      return found ? current.map((item) => item.id === proposal.id ? proposal : item) : [...current, proposal];
    });
  }, []);

  const byTarget = useMemo(() => groupActiveProposals(proposals), [proposals]);
  const refresh = useCallback(() => setReloadToken((value) => value + 1), []);

  return { proposals, byTarget, state, error, refresh, updateProposal };
}
