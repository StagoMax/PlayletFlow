import { useEffect, useState, type ReactNode } from "react";
import { MediaMetadata } from "../preview/MediaMetadata";
import { workspaceComposerAssets } from "../composer/workspaceAssets";
import type { ApplyProposalResponse, ChangeProposal } from "../productApi/generated";
import { ProposalActions, ProposalPanel, type ProposalClient } from "../proposals";
import { MediaPromptComposer } from "../preview/MediaPromptComposer";
import { MediaPromptDock } from "../preview/MediaPromptDock";
import { MediaViewer } from "../preview/MediaViewer";
import { Icon } from "./Icons";
import { ObjectMediaWorkspace } from "./ObjectMediaWorkspace";
import { findObject, findObjectForSelection, findTreeNode } from "./resourceTree";
import { ScriptEditor } from "./ScriptEditor";
import { useWorkspace } from "./WorkspaceContext";
import { workspaceObjectMediaClient } from "./workspaceObjectMediaClient";
import type { NavigatorItem, WorkspaceObjectNode } from "./types";

function findItem(groups: { items: NavigatorItem[] }[], itemId: string) {
  for (const group of groups) {
    const item = group.items.find((candidate) => candidate.id === itemId);
    if (item) return item;
  }
  return null;
}

function MediaProposalReview({ count, children }: { count: number; children: ReactNode }) {
  const [open, setOpen] = useState(true);
  return (
    <section className={`workspace-media-proposals${open ? "" : " workspace-media-proposals--collapsed"}`}
      aria-label="待确认的媒体修改">
      {open ? (
        <>
          <header className="workspace-media-proposals__header">
            <h2>待确认的 AI 修改</h2>
            <button type="button" onClick={() => setOpen(false)} aria-label="关闭建议面板">关闭</button>
          </header>
          {children}
        </>
      ) : (
        <button type="button" className="workspace-media-proposals__reopen" onClick={() => setOpen(true)}>
          查看待确认的 AI 修改（{count}）
        </button>
      )}
    </section>
  );
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
  const {
    data,
    current,
    objectMedia,
    state,
    saveScript,
    generateMedia,
    loadGenerationModels,
    publishWorkspaceNodeMedia,
    markObjectViewed,
  } = useWorkspace();
  const item = state.selection.kind === "item"
    ? findItem([...current.assetGroups, ...current.videoGroups], state.selection.itemId)
    : null;
  const [collapsedMediaId, setCollapsedMediaId] = useState<string | null>(null);
  const promptCollapsed = item?.media.kind === "video" && collapsedMediaId === item.media.id;
  const emptyObject = state.selection.kind === "emptyObject"
    ? findObject(current.navigationTree, state.selection.objectId)
    : null;
  const isScript = state.selection.kind === "script";
  const selectedNode = state.selection.nodeId ? findTreeNode(current.navigationTree, state.selection.nodeId) : null;
  const selectedObject = selectedNode?.kind === "object"
    ? selectedNode
    : findObjectForSelection(current.navigationTree, state.selection);
  const title = isScript ? "片段脚本" : selectedNode?.name ?? item?.name ?? emptyObject?.name ?? "未选择内容";
  const composerAssets = workspaceComposerAssets(current, objectMedia);
  const referenceMedia = composerAssets.flatMap((asset) =>
    asset.kind === "image" && asset.mediaId && asset.previewMedia?.status === "ready"
      ? [{ id: asset.mediaId, name: asset.name }]
      : []);
  const scriptProposal = scriptProposals[0] ?? null;
  const allItems = [...current.assetGroups, ...current.videoGroups].flatMap((group) => group.items);
  const allReadyImages = referenceMedia;
  const objectTargetMediaId = emptyObject?.mediaId ?? emptyObject?.id;
  const objectProposals = mediaProposals.filter((proposal) =>
    proposal.target.type === "mediaPrompt" && proposal.target.mediaId === objectTargetMediaId);

  useEffect(() => {
    const unseenUpdateAt = selectedObject?.unseenUpdateAt;
    if (!unseenUpdateAt || selectedObject.objectType === "text") return;
    const mediaId = item?.media.id ?? emptyObject?.mediaId ?? emptyObject?.id;
    if (!mediaId) return;
    const controller = new AbortController();
    let viewedFrame = 0;
    void workspaceObjectMediaClient.get(data.project.id, mediaId, controller.signal)
      .then((media) => {
        publishWorkspaceNodeMedia(current.storyboard.id, selectedObject.id, media);
        viewedFrame = window.requestAnimationFrame(() => {
          void markObjectViewed(current.storyboard.id, selectedObject.id, unseenUpdateAt)
            .catch((cause: unknown) => console.warn("无法标记 AI 内容为已查看", cause));
        });
      })
      .catch((cause: unknown) => {
        if (!controller.signal.aborted) console.warn("无法加载待查看的 AI 内容", cause);
      });
    return () => {
      controller.abort();
      window.cancelAnimationFrame(viewedFrame);
    };
  }, [current.storyboard.id, data.project.id, emptyObject?.id, emptyObject?.mediaId, item?.media.id,
    markObjectViewed, publishWorkspaceNodeMedia, selectedObject?.id, selectedObject?.objectType,
    selectedObject?.unseenUpdateAt]);

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
            <ObjectMediaWorkspace key={emptyObject.id} object={emptyObject} proposals={objectProposals.length > 0 ? (
              <MediaProposalReview key={emptyObject.id} count={objectProposals.length}>
                {objectProposals.map((proposal) => (
                  <ProposalPanel key={proposal.id} client={proposalClient}
                    projectId={data.project.id} proposal={proposal} targetName={emptyObject.name}
                    currentTargetRevision={objectMedia[emptyObject.id]?.revision ?? proposal.baseRevision}
                    generationContext={{ kind: emptyObject.objectType === "video" ? "video" : "image", media: allReadyImages }}
                    applyBlockedReason={objectMedia[emptyObject.id] && objectMedia[emptyObject.id].revision !== proposal.baseRevision
                      ? "正式内容已更新，请重新发起建议。" : undefined}
                    onProposalChange={onProposalChange}
                    onApplied={(response) => {
                      onProposalApplied(response);
                      if (!objectTargetMediaId) return;
                      void workspaceObjectMediaClient.get(data.project.id, objectTargetMediaId)
                        .then((media) => publishWorkspaceNodeMedia(current.storyboard.id, emptyObject.id, media))
                        .catch((cause: unknown) => console.warn("无法刷新已确认的媒体提示词", cause));
                    }} />
                ))}
              </MediaProposalReview>
            ) : null} />
          ) : emptyObject ? (
            <div className="canvas-body empty-object-canvas-body">
              <EmptyObjectState object={emptyObject} />
            </div>
          ) : (
            <div className="canvas-body media-canvas-body">
              <section className="media-preview-workspace" aria-label="媒体工作区">
                <MediaViewer item={item} onPreviewClick={item?.media.kind === "video"
                  ? () => setCollapsedMediaId(item.media.id) : undefined} />
                {mediaProposals.length > 0 ? (
                  <MediaProposalReview key={state.selection.nodeId ?? item?.id ?? "media"} count={mediaProposals.length}>
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
                  </MediaProposalReview>
                ) : null}
                {item ? (
                  <MediaPromptDock collapsible={item.media.kind === "video"} collapsed={promptCollapsed}
                    onToggle={() => setCollapsedMediaId(promptCollapsed ? null : item.media.id)}>
                    <MediaPromptComposer
                      key={item.id}
                      initialPrompt={item.media.prompt ?? ""}
                      draftKey={`${data.project.id}:${item.media.id}`}
                      kind={item.media.kind}
                      media={referenceMedia}
                      assets={composerAssets}
                      loadModels={loadGenerationModels}
                      onGenerate={(prompt, generation, idempotencyKey, imageFiles) => generateMedia(
                        current.storyboard.id,
                        item.id,
                        item.media.id,
                        prompt,
                        item.media.revision,
                        generation,
                        idempotencyKey,
                        imageFiles,
                      )}
                    />
                  </MediaPromptDock>
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
