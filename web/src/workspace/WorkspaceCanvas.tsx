import { MediaMetadata } from "../preview/MediaMetadata";
import { workspaceComposerAssets } from "../composer/workspaceAssets";
import type { ApplyProposalResponse, ChangeProposal } from "../productApi/generated";
import { ProposalActions, ScriptProposalReview, type ProposalClient } from "../proposals";
import { MediaPromptComposer } from "../preview/MediaPromptComposer";
import { MediaViewer } from "../preview/MediaViewer";
import { Icon } from "./Icons";
import { findObject } from "./resourceTree";
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
  onProposalChange: (proposal: ChangeProposal) => void;
  onProposalApplied: (response: ApplyProposalResponse) => void;
};

export function WorkspaceCanvas({
  proposalClient,
  scriptProposals,
  onProposalChange,
  onProposalApplied,
}: WorkspaceCanvasProps) {
  const { current, state, saveScript, generateMedia, loadGenerationModels } = useWorkspace();
  const item = state.selection.kind === "item"
    ? findItem([...current.assetGroups, ...current.videoGroups], state.selection.itemId)
    : null;
  const emptyObject = state.selection.kind === "emptyObject"
    ? findObject(current.navigationTree, state.selection.objectId)
    : null;
  const isScript = state.selection.kind === "script";
  const title = isScript ? "分镜脚本" : item?.name ?? emptyObject?.name ?? "未选择内容";
  const referenceMedia = [...current.assetGroups, ...current.videoGroups]
    .flatMap((group) => group.items)
    .filter((candidate) => candidate.media.kind === "image"
      && candidate.media.status === "ready"
      && candidate.media.id !== item?.media.id)
    .map((candidate) => ({ id: candidate.media.id, name: candidate.name }));
  const scriptProposal = scriptProposals[0] ?? null;

  return (
    <main className="workspace-canvas" id="workspace-main" tabIndex={-1}>
      {isScript ? (
        <ScriptEditor
          key={current.storyboard.id}
          storyboard={current.storyboard}
          onSave={(text, expectedRevision) => saveScript(current.storyboard.id, text, expectedRevision)}
          review={({ dirty, revision }) => scriptProposal && !dirty ? {
            actions: (
              <ProposalActions
                key={`${scriptProposal.id}:${scriptProposal.revision}:${scriptProposal.status}`}
                client={proposalClient}
                projectId={current.storyboard.projectId}
                proposal={scriptProposal}
                currentTargetRevision={revision}
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
            content: <ScriptProposalReview proposal={scriptProposal} />,
          } : null}
        />
      ) : (
        <>
          <header className={`canvas-header${item ? " media-canvas-header" : ""}`}>
            <h1 className="canvas-title">{title}</h1>
            {item ? <MediaMetadata item={item} /> : null}
          </header>
          {emptyObject ? (
            <div className="canvas-body empty-object-canvas-body">
              <EmptyObjectState object={emptyObject} />
            </div>
          ) : (
            <div className="canvas-body media-canvas-body">
              <section className="media-preview-workspace" aria-label="媒体工作区">
                <MediaViewer item={item} />
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
