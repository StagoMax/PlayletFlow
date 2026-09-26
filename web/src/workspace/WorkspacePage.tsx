import { useCallback, useMemo, type ComponentType } from "react";
import type { ComposerAssetReference } from "../composer/types";
import { workspaceComposerAssets } from "../composer/workspaceAssets";
import { ContentNavigator } from "../navigator/ContentNavigator";
import { createProposalClient, useStoryboardProposals } from "../proposals";
import { StoryboardPicker } from "../storyboards/StoryboardPicker";
import { WorkspaceCanvas } from "./WorkspaceCanvas";
import type { WorkspaceClient } from "./workspaceClient";
import { useWorkspace } from "./WorkspaceContext";
import { WorkspaceProvider } from "./WorkspaceProvider";
import { WorkspaceEmpty, WorkspaceError, WorkspaceLoading } from "./WorkspaceStates";
import { useWorkspaceQueries } from "./useWorkspaceQueries";

type WorkspacePageProps = {
  client: WorkspaceClient;
  assistantPanel: ComponentType<WorkspaceAssistantScope>;
};

const proposalClient = createProposalClient();

export type WorkspaceAssistantScope = {
  projectId: string;
  storyboardId: string;
  storyboardName: string;
  assets: readonly ComposerAssetReference[];
  onTurnSettled: () => void;
  onSelectReference: (reference: ComposerAssetReference) => void;
};

function WorkspaceLayout({ assistantPanel: AssistantPanel }: { assistantPanel: ComponentType<WorkspaceAssistantScope> }) {
  const {
    data,
    state,
    current,
    dispatch,
    createStoryboard,
    duplicateStoryboard,
    reorderStoryboard,
    commitAppliedProposal,
    refreshScript,
  } = useWorkspace();
  const { byTarget, refresh: refreshProposals, updateProposal } = useStoryboardProposals(
    proposalClient,
    data.project.id,
    current.storyboard.id,
  );
  const pendingUserActionTargets = useMemo(() => new Set(byTarget.keys()), [byTarget]);
  const composerAssets = useMemo(() => workspaceComposerAssets(current), [current]);
  const scriptProposals = byTarget.get(`script:${current.storyboard.id}`) ?? [];
  const mediaProposals = useMemo(
    () => [...byTarget.values()].flat().filter((proposal) => proposal.target.type !== "script"),
    [byTarget],
  );
  const handleTurnSettled = useCallback(() => {
    refreshProposals();
    void refreshScript(current.storyboard.id);
  }, [current.storyboard.id, refreshProposals, refreshScript]);
  const handleProposalApplied = useCallback((response: Parameters<typeof commitAppliedProposal>[0]) => {
    commitAppliedProposal(response);
  }, [commitAppliedProposal]);
  const handleSelectReference = useCallback((reference: ComposerAssetReference) => {
    if (reference.kind !== "text") return;
    dispatch({ type: "contentSelected", selection: reference.selection });
  }, [dispatch]);
  return (
    <div className="workspace-shell">
      <a className="skip-link" href="#workspace-main">跳到预览区</a>
      <aside className="workspace-navigator">
        <header className="navigator-header">
          <div className="workspace-brand"><span className="workspace-brand-mark">V</span><div><strong>Videoflow</strong><small>{data.project.name}</small></div></div>
          <StoryboardPicker
            storyboards={data.storyboards}
            currentId={state.currentStoryboardId}
            onSelect={(storyboardId) => {
              const target = data.workspaces[storyboardId];
              if (!target) return;
              const firstItem = [...target.assetGroups, ...target.videoGroups]
                .flatMap((group) => group.items)
                .find((item) => item.media.status === "ready");
              dispatch({
                type: "storyboardSelected",
                storyboardId,
                selection: firstItem
                  ? { kind: "item", itemId: firstItem.id }
                  : { kind: "script", storyboardId },
              });
            }}
            onCreate={(sourceStoryboardId, name) => createStoryboard({ sourceStoryboardId, name })}
            onDuplicate={duplicateStoryboard}
            onReorder={reorderStoryboard}
          />
        </header>
        <ContentNavigator pendingUserActionTargets={pendingUserActionTargets} />
      </aside>
      <WorkspaceCanvas
        proposalClient={proposalClient}
        scriptProposals={scriptProposals}
        mediaProposals={mediaProposals}
        onProposalChange={updateProposal}
        onProposalApplied={handleProposalApplied}
        onScriptSaved={refreshProposals}
      />
      <aside className="workspace-assistant" aria-label="AI 对话区">
        <AssistantPanel
          projectId={data.project.id}
          storyboardId={state.currentStoryboardId}
          storyboardName={current.storyboard.name}
          assets={composerAssets}
          onTurnSettled={handleTurnSettled}
          onSelectReference={handleSelectReference}
        />
      </aside>
    </div>
  );
}

export function WorkspacePage({ client, assistantPanel }: WorkspacePageProps) {
  const { resource, retry } = useWorkspaceQueries(client);
  if (resource.status === "loading") return <WorkspaceLoading />;
  if (resource.status === "error") return <WorkspaceError message={resource.message} onRetry={retry} />;
  if (resource.status === "empty") return <WorkspaceEmpty projectName={resource.data.project.name} onCreate={async (name) => {
    await client.createStoryboard(resource.data.project.id, { name, insertAfterId: null }, crypto.randomUUID());
    retry();
  }} />;
  return (
    <WorkspaceProvider client={client} data={resource.data}>
      <WorkspaceLayout assistantPanel={assistantPanel} />
    </WorkspaceProvider>
  );
}
