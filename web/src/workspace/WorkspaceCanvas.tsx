import { MediaMetadata } from "../preview/MediaMetadata";
import { workspaceComposerAssets } from "../composer/workspaceAssets";
import type { ApplyProposalResponse, ChangeProposal } from "../productApi/generated";
import { ProposalActions, ProposalPanel, type ProposalClient } from "../proposals";
import { MediaPromptComposer } from "../preview/MediaPromptComposer";
import { MediaViewer } from "../preview/MediaViewer";
import { Icon } from "./Icons";
import { ObjectMediaWorkspace } from "./ObjectMediaWorkspace";
import { findObject, findTreeNode } from "./resourceTree";
import { ScriptEditor } from "./ScriptEditor";
import { useWorkspace } from "./WorkspaceContext";
import type { NavigatorItem, WorkspaceObjectNode } from "./types";

function findItem(groups: { items: NavigatorItem[] }[], itemId: string) {
  for (const group of groups) {
    const item = group.items.find((candidate) => candidate.id === itemId);
    if (item) return item;
  }
  return null;
}

type WorkspaceCanvasProps = {
  proposalClient: ProposalClient;
  scriptProposals: ChangeProposal[];
  mediaProposals: ChangeProposal[];
  onProposalChange: (proposal: ChangeProposal) => void;
  onProposalApplied: (response: ApplyProposalResponse) => void;
  onScriptSaved: () => void;
};

export function WorkspaceCanvas({
  proposalClient,
  scriptProposals,
  mediaProposals,
  onProposalChange,
  onProposalApplied,
  onScriptSaved,
}: WorkspaceCanvasProps) {
  const { current, state, saveScript, generateMedia, loadGenerationModels } = useWorkspace();
  const item = state.selection.kind === "item"
    ? findItem([...current.assetGroups, ...current.videoGroups], state.selection.itemId)
    : null;
  const emptyObject = state.selection.kind === "emptyObject"
    ? findObject(current.navigationTree, state.selection.objectId)
    : null;
  const isScript = state.selection.kind === "script";
  const selectedNode = state.selection.nodeId ? findTreeNode(current.navigationTree, state.selection.nodeId) : null;
  const title = isScript ? "片段脚本" : selectedNode?.name ?? item?.name ?? emptyObject?.name ?? "未选择内容";
  const referenceMedia = [...current.assetGroups, ...current.videoGroups]
    .flatMap((group) => group.items)
    .filter((candidate) => candidate.media.kind === "image"
      && candidate.media.status === "ready"
      && candidate.media.id !== item?.media.id)
    .map((candidate) => ({ id: candidate.media.id, name: candidate.name }));
  const scriptProposal = scriptProposals[0] ?? null;
  const allItems = [...current.assetGroups, ...current.videoGroups].flatMap((group) => group.items);
  const allReadyImages = allItems
    .filter((candidate) => candidate.media.kind === "image" && candidate.media.status === "ready")
    .map((candidate) => ({ id: candidate.media.id, name: candidate.name }));

  return (
    <main className="workspace-canvas" id="workspace-main" tabIndex={-1}>
      {isScript ? (
        <ScriptEditor
          key={current.storyboard.id}
          storyboard={current.storyboard}
          onSave={(text, expectedRevision) => saveScript(current.storyboard.id, text, expectedRevision)}
          onSaved={onScriptSaved}
          review={({ dirty, revision }) => scriptProposal && !dirty ? {
            id: scriptProposal.id,
            actions: (
              <ProposalActions
                key={`${scriptProposal.id}:${scriptProposal.revision}:${scriptProposal.status}`}
                client={proposalClient}
                projectId={current.storyboard.projectId}
                proposal={scriptProposal}
                currentTargetRevision={revision}
                applyBlockedReason={scriptProposal.baseRevision !== revision ? "正式脚本已更新，原建议不能直接确认。" : undefined}
                layout="toolbar"
                onApplied={(response) => {
                  onProposalChange(response.proposal);
                  onProposalApplied(response);
                }}
                onRejected={onProposalChange}
                onConflict={() => {
                  void proposalClient.get(current.storyboard.projectId, scriptProposal.id)
                    .then(onProposalChange)
                    .catch(() => undefined);
                }}
              />
            ),
            text: scriptProposal.proposedValue,
          } : null}
        />
      ) : (
        <>
          <header className={`canvas-header${item ? " media-canvas-header" : ""}`}>
            <h1 className="canvas-title">{title}</h1>
            {item ? <MediaMetadata item={item} /> : null}
          </header>
          {emptyObject && emptyObject.objectType !== "text" ? (
            <ObjectMediaWorkspace key={emptyObject.id} object={emptyObject} />
          ) : emptyObject ? (
            <div className="canvas-body empty-object-canvas-body">
              <EmptyObjectState object={emptyObject} />
            </div>
          ) : (
            <div className="canvas-body media-canvas-body">
              <section className="media-preview-workspace" aria-label="媒体工作区">
                <MediaViewer item={item} />
                {mediaProposals.length > 0 ? (
                  <section className="workspace-media-proposals" aria-label="待确认的媒体修改">
                    <h2>待确认的 AI 修改</h2>
                    {mediaProposals.map((proposal) => {
                      const targetMediaId = proposal.target.type === "mediaPrompt" ? proposal.target.mediaId : null;
                      const targetItem = targetMediaId
                        ? allItems.find((candidate) => candidate.media.id === targetMediaId)
                        : null;
                      const targetRevision = targetItem?.media.revision ?? proposal.baseRevision;
                      const kind = proposal.target.type === "assetBindingPrompt"
                        ? "image"
                        : targetItem?.media.kind ?? "image";
                      return (
                        <ProposalPanel
                          key={proposal.id}
                          client={proposalClient}
                          projectId={current.storyboard.projectId}
                          proposal={proposal}
                          targetName={targetItem?.name}
                          currentTargetRevision={targetRevision}
                          generationContext={{ kind, media: allReadyImages }}
                          applyBlockedReason={targetRevision !== proposal.baseRevision
                            ? "正式内容已更新，请重新发起建议。"
                            : undefined}
                          onProposalChange={onProposalChange}
                          onApplied={onProposalApplied}
                        />
                      );
                    })}
                  </section>
                ) : null}
                {item ? (
                  <div className="media-prompt-dock">
                    <MediaPromptComposer
                      key={item.id}
                      initialPrompt={item.media.prompt ?? ""}
                      kind={item.media.kind}
                      media={referenceMedia}
                      assets={workspaceComposerAssets(current)}
                      loadModels={loadGenerationModels}
                      onGenerate={(prompt, generation, idempotencyKey) => generateMedia(
                        current.storyboard.id,
                        item.id,
                        item.media.id,
                        prompt,
                        item.media.revision,
                        generation,
                        idempotencyKey,
                      )}
                    />
                  </div>
                ) : null}
              </section>
            </div>
          )}
        </>
      )}
    </main>
  );
}

function EmptyObjectState({ object }: { object: WorkspaceObjectNode }) {
  const label = object.objectType === "text" ? "文本" : object.objectType === "image" ? "图片" : "视频";
  return (
    <section className="empty-object-state" aria-label={`${object.name}空对象`}>
      <span>{object.objectType === "text" ? <Icon name="file-text" /> : object.objectType === "image" ? <Icon name="image" /> : <Icon name="film" />}</span>
      <h2>{object.name}</h2>
      <p>这是一个空的{label}对象。后续可以在这里编辑内容或添加媒体。</p>
    </section>
  );
}
