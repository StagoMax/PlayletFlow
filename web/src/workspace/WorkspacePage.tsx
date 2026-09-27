import { useCallback, useEffect, useMemo, useRef, useState, type ComponentType, type CSSProperties } from "react";
import type { ComposerAssetReference } from "../composer/types";
import { workspaceComposerAssets } from "../composer/workspaceAssets";
import { ContentNavigator } from "../navigator/ContentNavigator";
import { createProposalClient, useStoryboardProposals } from "../proposals";
import { StoryboardPicker } from "../storyboards/StoryboardPicker";
import { AssistantLauncher } from "./AssistantLauncher";
import { WorkspaceCanvas } from "./WorkspaceCanvas";
import { Icon } from "./Icons";
import type { WorkspaceClient } from "./workspaceClient";
import { useWorkspace } from "./WorkspaceContext";
import { WorkspaceProvider } from "./WorkspaceProvider";
import { WorkspaceEmpty, WorkspaceError, WorkspaceLoading } from "./WorkspaceStates";
import { useWorkspaceQueries } from "./useWorkspaceQueries";
import { useWorkspacePanelWidths } from "./useWorkspacePanelWidths";

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
  const [assistantOpen, setAssistantOpen] = useState(true);
  const [cloudSyncError, setCloudSyncError] = useState<string | null>(null);
  useEffect(() => {
    if (!import.meta.env.PROD) return;
    const onSync = (event: Event) => setCloudSyncError((event as CustomEvent<string | null>).detail);
    window.addEventListener("videoflow:cloud-workspace-sync", onSync);
    return () => window.removeEventListener("videoflow:cloud-workspace-sync", onSync);
  }, []);
  const panels = useWorkspacePanelWidths(assistantOpen);
  const assistantCloseButtonRef = useRef<HTMLButtonElement>(null);
  const {
    data,
    state,
    current,
    objectMedia,
    dispatch,
    createStoryboard,
    duplicateStoryboard,
    deleteStoryboard,
    reorderStoryboard,
    commitAppliedProposal,
    refreshNavigationTree,
    refreshScript,
  } = useWorkspace();
  const { byTarget, refresh: refreshProposals, updateProposal } = useStoryboardProposals(
    proposalClient,
    data.project.id,
    current.storyboard.id,
  );
  const pendingUserActionTargets = useMemo(() => new Set(byTarget.keys()), [byTarget]);
  const composerAssets = useMemo(
    () => workspaceComposerAssets(current, objectMedia),
    [current, objectMedia],
  );
  const scriptProposals = byTarget.get(`script:${current.storyboard.id}`) ?? [];
  const mediaProposals = useMemo(
    () => [...byTarget.values()].flat().filter((proposal) => proposal.target.type !== "script"),
    [byTarget],
  );
  const handleTurnSettled = useCallback(() => {
    refreshProposals();
    void refreshNavigationTree(current.storyboard.id);
    void refreshScript(current.storyboard.id);
  }, [current.storyboard.id, refreshNavigationTree, refreshProposals, refreshScript]);
  const handleProposalApplied = useCallback((response: Parameters<typeof commitAppliedProposal>[0]) => {
    commitAppliedProposal(response);
  }, [commitAppliedProposal]);
  const handleSelectReference = useCallback((reference: ComposerAssetReference) => {
    if (reference.kind !== "text") return;
    dispatch({ type: "contentSelected", selection: reference.selection });
  }, [dispatch]);
  const setAssistantVisibility = useCallback((open: boolean) => {
    setAssistantOpen(open);
    if (open) window.requestAnimationFrame(() => assistantCloseButtonRef.current?.focus());
  }, []);
  return (
    <div
      ref={panels.shellRef}
      className={`workspace-shell${assistantOpen ? "" : " assistant-closed"}`}
      style={{
        "--workspace-navigator-width": `${panels.widths.navigator}px`,
        "--workspace-assistant-width": `${panels.widths.assistant}px`,
      } as CSSProperties}
    >
      <a className="skip-link" href="#workspace-main">跳到预览区</a>
      {cloudSyncError ? <div role="alert" className="cloud-sync-error">云端保存失败：{cloudSyncError}</div> : null}
      <aside className="workspace-navigator" id="workspace-navigator">
        <header className="navigator-header">
          <div className="workspace-brand">
            <svg className="workspace-brand-mark" viewBox="0 0 34 34" aria-hidden="true">
              <path d="M4 2 29 12.5 16.4 17.1 7.6 31 9.1 17.6Z" fill="#189df0" />
              <path d="m16.4 17.1 12.6-4.6-8.4 16-13 2.5Z" fill="#0878d7" />
              <path d="m4 2 5.1 15.6 7.3-.5Z" fill="#43bdff" />
            </svg>
            <strong>PlayletFlow</strong>
          </div>
          <StoryboardPicker
            storyboards={data.storyboards}
            details={Object.fromEntries(Object.entries(data.workspaces).map(([id, workspace]) => [id, workspace.storyboard]))}
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
            onDelete={deleteStoryboard}
            onReorder={reorderStoryboard}
          />
        </header>
        <ContentNavigator pendingUserActionTargets={pendingUserActionTargets} />
      </aside>
      <div
        className={`workspace-splitter workspace-splitter--navigator${panels.dragging === "navigator" ? " is-dragging" : ""}`}
        role="separator"
        tabIndex={0}
        aria-label="调整左侧导航宽度"
        aria-orientation="vertical"
        aria-controls="workspace-navigator workspace-main"
        aria-valuemin={panels.limits("navigator").min}
        aria-valuemax={panels.limits("navigator").max}
        aria-valuenow={panels.widths.navigator}
        onPointerDown={(event) => panels.onPointerDown("navigator", event)}
        onPointerMove={panels.onPointerMove}
        onPointerUp={panels.onPointerEnd}
        onPointerCancel={panels.onPointerEnd}
        onLostPointerCapture={panels.onPointerEnd}
        onKeyDown={(event) => panels.onKeyDown("navigator", event)}
      />
      <WorkspaceCanvas
        proposalClient={proposalClient}
        scriptProposals={scriptProposals}
        mediaProposals={mediaProposals}
        onProposalChange={updateProposal}
        onProposalApplied={handleProposalApplied}
        onScriptSaved={refreshProposals}
      />
      {assistantOpen ? (
        <div
          className={`workspace-splitter workspace-splitter--assistant${panels.dragging === "assistant" ? " is-dragging" : ""}`}
          role="separator"
          tabIndex={0}
          aria-label="调整右侧 AI 对话宽度"
          aria-orientation="vertical"
          aria-controls="workspace-main workspace-assistant-panel"
          aria-valuemin={panels.limits("assistant").min}
          aria-valuemax={panels.limits("assistant").max}
          aria-valuenow={panels.widths.assistant}
          onPointerDown={(event) => panels.onPointerDown("assistant", event)}
          onPointerMove={panels.onPointerMove}
          onPointerUp={panels.onPointerEnd}
          onPointerCancel={panels.onPointerEnd}
          onLostPointerCapture={panels.onPointerEnd}
          onKeyDown={(event) => panels.onKeyDown("assistant", event)}
        />
      ) : null}
      <aside
        id="workspace-assistant-panel"
        className="workspace-assistant"
        aria-label="AI 对话区"
        hidden={!assistantOpen}
      >
        <button
          ref={assistantCloseButtonRef}
          className="assistant-panel-close"
          type="button"
          aria-label="收起 AI 对话"
          aria-controls="workspace-assistant-panel"
          title="收起 AI 对话"
          onClick={() => setAssistantVisibility(false)}
        >
          <Icon name="minimize" />
        </button>
        <div className="workspace-assistant-content">
          <AssistantPanel
            projectId={data.project.id}
            storyboardId={state.currentStoryboardId}
            storyboardName={current.storyboard.name}
            assets={composerAssets}
            onTurnSettled={handleTurnSettled}
            onSelectReference={handleSelectReference}
          />
        </div>
      </aside>
      {!assistantOpen ? (
        <AssistantLauncher onOpen={() => setAssistantVisibility(true)} />
      ) : null}
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
