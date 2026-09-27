import { useCallback, useEffect, useMemo, useReducer, useRef, useState, type ReactNode } from "react";
import type {
  ApplyProposalResponse,
  GenerationJob,
  GenerationOptions,
  MediaItem,
} from "../productApi/generated";
import type {
  NavigatorGroup,
  WorkspaceFolderNode,
  WorkspaceObjectNode,
  WorkspaceObjectType,
  WorkspaceSnapshot,
  WorkspaceTreeNode,
} from "./types";
import { appendTreeNode, findTreeNode, mediaBackedObjectIds, nodeContainsSelection } from "./resourceTree";
import { workspaceObjectMediaClient } from "./workspaceObjectMediaClient";
import { saveBrowserObjectMedia } from "./browserWorkspaceStorage";
import { useObjectMediaPolling } from "./useObjectMediaPolling";
import { withStoryboardOrder, withoutStoryboard } from "./storyboardOrder";
import type { WorkspaceClient } from "./workspaceClient";
import type { WorkspaceGenerationJob } from "./workspaceClient";
import { createWorkspaceState, rememberWorkspaceState, workspaceReducer } from "./workspaceReducer";
import { WorkspaceContext } from "./WorkspaceContext";

type WorkspaceProviderProps = {
  client: WorkspaceClient;
  data: WorkspaceSnapshot;
  children: ReactNode;
};

export function WorkspaceProvider({ client, data: initialData, children }: WorkspaceProviderProps) {
  const [data, setData] = useState(initialData);
  const [objectMedia, setObjectMedia] = useState<Record<string, MediaItem>>(initialData.objectMedia ?? {});
  useEffect(() => {
    if (!import.meta.env.PROD) return;
    const adopt = (event: Event) => {
      const snapshot = (event as CustomEvent<WorkspaceSnapshot>).detail;
      setData(snapshot);
      setObjectMedia(snapshot.objectMedia ?? {});
    };
    window.addEventListener("videoflow:cloud-workspace-updated", adopt);
    return () => window.removeEventListener("videoflow:cloud-workspace-updated", adopt);
  }, []);
  useEffect(() => {
    if (!import.meta.env.PROD) return;
    for (const [objectId, media] of Object.entries(objectMedia)) saveBrowserObjectMedia(objectId, media);
  }, [objectMedia]);
  const publishObjectMedia = useCallback((objectId: string, media: MediaItem) => {
    setObjectMedia((current) => {
      const previous = current[objectId];
      if (previous?.id === media.id && previous.revision > media.revision) return current;
      if (previous && previous.id !== media.id && previous.status === "ready"
        && (media.status === "processing" || media.status === "placeholder")) return current;
      if (previous?.id === media.id && previous.revision === media.revision
        && (previous.status === "ready" || previous.status === "failed")
        && (media.status === "processing" || media.status === "placeholder")) return current;
      if (previous?.id === media.id && previous.status === "processing"
        && media.status === "placeholder" && previous.revision === media.revision) return current;
      return { ...current, [objectId]: media };
    });
  }, []);
  const publishWorkspaceNodeMedia = useCallback((storyboardId: string, nodeId: string, media: MediaItem) => {
    publishObjectMedia(nodeId, media);
    setData((currentData) => {
      const workspace = currentData.workspaces[storyboardId];
      if (!workspace) return currentData;
      let changed = false;
      const updateGroups = (groups: NavigatorGroup[]) => groups.map((group) => ({
        ...group,
        items: group.items.map((item) => {
          if (item.media.id !== media.id || item.media.revision > media.revision) return item;
          changed = true;
          return { ...item, media };
        }),
      }));
      const assetGroups = updateGroups(workspace.assetGroups);
      const videoGroups = updateGroups(workspace.videoGroups);
      if (!changed) return currentData;
      return {
        ...currentData,
        workspaces: {
          ...currentData.workspaces,
          [storyboardId]: { ...workspace, assetGroups, videoGroups },
        },
      };
    });
  }, [publishObjectMedia]);
  const [state, dispatch] = useReducer(workspaceReducer, initialData, createWorkspaceState);
  useEffect(() => rememberWorkspaceState(data.project.id, state), [data.project.id, state]);
  useObjectMediaPolling(
    data.project.id,
    state.currentStoryboardId,
    data.workspaces[state.currentStoryboardId].navigationTree,
    objectMedia,
    publishObjectMedia,
  );
  const generationPolls = useRef(new Map<string, AbortController>());
  useEffect(() => () => {
    generationPolls.current.forEach((controller) => controller.abort());
    generationPolls.current.clear();
  }, []);
  const refreshNavigationTree = useCallback(async (storyboardId: string, signal?: AbortSignal) => {
    const navigationTree = await client.loadNavigationTree(data.project.id, storyboardId, signal);
    if (!navigationTree) return;
    setData((currentData) => {
      const workspace = currentData.workspaces[storyboardId];
      if (!workspace) return currentData;
      return {
        ...currentData,
        workspaces: {
          ...currentData.workspaces,
          [storyboardId]: { ...workspace, navigationTree },
        },
      };
    });
    for (const objectId of mediaBackedObjectIds(navigationTree)) {
      void workspaceObjectMediaClient.get(data.project.id, objectId, signal)
        .then((media) => { if (!signal?.aborted) publishObjectMedia(objectId, media); })
        .catch((error: unknown) => {
          if (!signal?.aborted) console.warn("无法加载对象缩略预览", error);
        });
    }
  }, [client, data.project.id, publishObjectMedia]);
  useEffect(() => {
    const controller = new AbortController();
    void refreshNavigationTree(state.currentStoryboardId, controller.signal)
      .catch((error: unknown) => {
        if (!(error instanceof DOMException && error.name === "AbortError")) {
          console.error("无法同步工作区资源树", error);
        }
      });
    return () => controller.abort();
  }, [refreshNavigationTree, state.currentStoryboardId]);
  const refreshScript = useCallback(async (storyboardId: string, signal?: AbortSignal) => {
    const script = await client.loadScript(data.project.id, storyboardId, signal);
    if (!script) return null;
    setData((currentData) => {
      const workspace = currentData.workspaces[storyboardId];
      if (!workspace) return currentData;
      const currentScript = workspace.storyboard.script;
      if (
        currentScript.revision === script.revision
        && currentScript.text === script.text
        && currentScript.updatedAt === script.updatedAt
      ) return currentData;
      return {
        ...currentData,
        workspaces: {
          ...currentData.workspaces,
          [storyboardId]: {
            ...workspace,
            storyboard: { ...workspace.storyboard, script },
          },
        },
      };
    });
    return script;
  }, [client, data.project.id]);
  useEffect(() => {
    const controller = new AbortController();
    void refreshScript(state.currentStoryboardId, controller.signal).catch((error: unknown) => {
      if (!(error instanceof DOMException && error.name === "AbortError")) {
        console.error("无法同步片段脚本", error);
      }
    });
    return () => controller.abort();
  }, [refreshScript, state.currentStoryboardId]);
  const loadGenerationModels = useCallback(
    (signal?: AbortSignal) => client.listGenerationModels(signal),
    [client],
  );
  const saveScript = useCallback(async (storyboardId: string, text: string, expectedRevision: number) => {
    const script = await client.updateScript(
      data.project.id,
      storyboardId,
      { text, expectedRevision },
    );
    setData((currentData) => {
      const workspace = currentData.workspaces[storyboardId];
      if (!workspace || workspace.storyboard.script.revision >= script.revision) return currentData;
      return {
        ...currentData,
        workspaces: {
          ...currentData.workspaces,
          [storyboardId]: {
            ...workspace,
            storyboard: { ...workspace.storyboard, script },
          },
        },
      };
    });
    return script;
  }, [client, data.project.id]);
  const commitAppliedProposal = useCallback((response: ApplyProposalResponse) => {
    setData((currentData) => applyProposalResult(currentData, response));
  }, []);
  const addNavigationNode = useCallback((storyboardId: string, parentId: string | null, node: WorkspaceFolderNode | WorkspaceObjectNode) => {
    setData((currentData) => {
      const workspace = currentData.workspaces[storyboardId];
      if (!workspace) return currentData;
      return {
        ...currentData,
        workspaces: {
          ...currentData.workspaces,
          [storyboardId]: {
            ...workspace,
            navigationTree: appendTreeNode(workspace.navigationTree, parentId, node),
          },
        },
      };
    });
  }, []);
  const createFolder = useCallback(async (storyboardId: string, parentId: string | null, name: string) => {
    const node = await client.createFolder(data.project.id, storyboardId, parentId, name);
    addNavigationNode(storyboardId, parentId, node);
    return node;
  }, [addNavigationNode, client, data.project.id]);
  const createObject = useCallback(async (
    storyboardId: string,
    parentId: string | null,
    name: string,
    objectType: WorkspaceObjectType,
  ) => {
    const node = await client.createObject(data.project.id, storyboardId, parentId, name, objectType);
    addNavigationNode(storyboardId, parentId, node);
    return node;
  }, [addNavigationNode, client, data.project.id]);
  const updateNavigationTree = useCallback((storyboardId: string, tree: WorkspaceTreeNode[]) => {
    setData((currentData) => {
      const workspace = currentData.workspaces[storyboardId];
      if (!workspace) return currentData;
      return { ...currentData, workspaces: {
        ...currentData.workspaces,
        [storyboardId]: { ...workspace, navigationTree: tree },
      } };
    });
  }, []);
  const renameNode = useCallback(async (nodeId: string, name: string) => {
    const tree = await client.renameNode(data.project.id, state.currentStoryboardId, nodeId, name);
    updateNavigationTree(state.currentStoryboardId, tree);
  }, [client, data.project.id, state.currentStoryboardId, updateNavigationTree]);
  const deleteNode = useCallback(async (nodeId: string) => {
    const node = findTreeNode(data.workspaces[state.currentStoryboardId].navigationTree, nodeId);
    const tree = await client.deleteNode(data.project.id, state.currentStoryboardId, nodeId);
    updateNavigationTree(state.currentStoryboardId, tree);
    if (node && nodeContainsSelection(node, state.selection)) {
      dispatch({ type: "contentSelected", selection: { kind: "script", storyboardId: state.currentStoryboardId } });
    }
  }, [client, data, state, updateNavigationTree]);
  const copyNode = useCallback(async (nodeId: string) => {
    const tree = await client.copyNode(data.project.id, state.currentStoryboardId, nodeId);
    updateNavigationTree(state.currentStoryboardId, tree);
  }, [client, data.project.id, state.currentStoryboardId, updateNavigationTree]);
  const reorderNode = useCallback(async (nodeId: string, targetId: string, placement: "before" | "after") => {
    const storyboardId = state.currentStoryboardId;
    const tree = await client.reorderNode(data.project.id, storyboardId, nodeId, targetId, placement);
    updateNavigationTree(storyboardId, tree);
  }, [client, data.project.id, state.currentStoryboardId, updateNavigationTree]);
  const moveNode = useCallback(async (nodeId: string, parentId: string | null) => {
    const storyboardId = state.currentStoryboardId;
    const tree = await client.moveNode(data.project.id, storyboardId, nodeId, parentId);
    updateNavigationTree(storyboardId, tree);
  }, [client, data.project.id, state.currentStoryboardId, updateNavigationTree]);
  const markObjectViewed = useCallback(async (storyboardId: string, nodeId: string, seenThrough: string) => {
    const tree = await client.markObjectViewed(data.project.id, storyboardId, nodeId, seenThrough);
    updateNavigationTree(storyboardId, tree);
  }, [client, data.project.id, updateNavigationTree]);
  const createStoryboard = useCallback(async (input: {
    name: string;
    sourceStoryboardId: string;
  }) => {
    const created = await client.createStoryboard(
      data.project.id,
      {
        name: input.name,
        insertAfterId: input.sourceStoryboardId,
      },
      crypto.randomUUID(),
    );
    setData((currentData) => {
      const sourceIndex = currentData.storyboards.findIndex((item) => item.id === input.sourceStoryboardId);
      const storyboards = [...currentData.storyboards];
      storyboards.splice(sourceIndex + 1, 0, created.storyboard);
      return withStoryboardOrder(currentData, storyboards, { [created.storyboard.id]: created.workspace });
    });
    dispatch({
      type: "storyboardSelected",
      storyboardId: created.storyboard.id,
      selection: { kind: "script", storyboardId: created.storyboard.id },
    });
  }, [client, data.project.id]);
  const duplicateStoryboard = useCallback(async (storyboardId: string) => {
    const created = await client.duplicateStoryboard(data.project.id, storyboardId, crypto.randomUUID());
    if (created.objectMedia) setObjectMedia((current) => ({ ...current, ...created.objectMedia }));
    setData((currentData) => {
      const index = currentData.storyboards.findIndex((item) => item.id === storyboardId);
      const storyboards = [...currentData.storyboards];
      storyboards.splice(index + 1, 0, created.storyboard);
      return withStoryboardOrder(currentData, storyboards, { [created.storyboard.id]: created.workspace });
    });
    dispatch({ type: "storyboardSelected", storyboardId: created.storyboard.id });
  }, [client, data.project.id]);
  const renameStoryboard = useCallback(async (name: string) => {
    const storyboardId = state.currentStoryboardId;
    const source = data.storyboards.find((item) => item.id === storyboardId);
    if (!source) throw new Error("片段不存在，请刷新后重试。");
    const updated = await client.renameStoryboard(data.project.id, storyboardId, name, source.revision);
    setData((currentData) => {
      const workspace = currentData.workspaces[storyboardId];
      if (!workspace) return currentData;
      return {
        ...currentData,
        storyboards: currentData.storyboards.map((item) => item.id === storyboardId
          ? { ...item, name: updated.name, revision: updated.revision, updatedAt: updated.updatedAt }
          : item),
        workspaces: { ...currentData.workspaces,
          [storyboardId]: { ...workspace, storyboard: updated } },
      };
    });
  }, [client, data.project.id, data.storyboards, state.currentStoryboardId]);
  const deleteStoryboard = useCallback(async (storyboardId: string = state.currentStoryboardId) => {
    const index = data.storyboards.findIndex((item) => item.id === storyboardId);
    const source = data.storyboards[index];
    if (!source) throw new Error("片段不存在，请刷新后重试。");
    let replacement = data.storyboards[index + 1] ?? data.storyboards[index - 1];
    if (!replacement) {
      const created = await client.createStoryboard(data.project.id, {
        name: "新片段",
        insertAfterId: storyboardId,
      }, crypto.randomUUID());
      replacement = created.storyboard;
      setData((currentData) => withStoryboardOrder(currentData,
        [...currentData.storyboards, created.storyboard],
        { [created.storyboard.id]: created.workspace }));
    }
    await client.deleteStoryboard(data.project.id, storyboardId, source.revision);
    if (storyboardId === state.currentStoryboardId) dispatch({ type: "storyboardSelected", storyboardId: replacement.id });
    setObjectMedia((current) => Object.fromEntries(Object.entries(current).filter(([, media]) =>
      media.owner.type !== "storyboard" || media.owner.storyboardId !== storyboardId)));
    setData((currentData) => withoutStoryboard(currentData, storyboardId));
  }, [client, data.project.id, data.storyboards, state.currentStoryboardId]);
  const reorderStoryboard = useCallback(async (
    storyboardId: string,
    targetId: string,
    placement: "before" | "after",
  ) => {
    const source = data.storyboards.find((item) => item.id === storyboardId);
    if (!source || storyboardId === targetId) return;
    const updated = await client.reorderStoryboard(data.project.id, storyboardId, {
      beforeId: placement === "before" ? targetId : null,
      afterId: placement === "after" ? targetId : null,
      expectedRevision: source.revision,
    }, crypto.randomUUID());
    setData((currentData) => {
      const storyboards = currentData.storyboards.filter((item) => item.id !== storyboardId);
      const targetIndex = storyboards.findIndex((item) => item.id === targetId);
      if (targetIndex < 0) return currentData;
      storyboards.splice(targetIndex + (placement === "after" ? 1 : 0), 0, updated);
      return withStoryboardOrder(currentData, storyboards);
    });
  }, [client, data.project.id, data.storyboards]);
  const monitorGeneration = useCallback((
    storyboardId: string,
    itemId: string,
    mediaId: string,
    initialJob: WorkspaceGenerationJob,
  ) => {
    if (isGenerationFinal(initialJob.status)) return;
    generationPolls.current.get(mediaId)?.abort();
    const controller = new AbortController();
    generationPolls.current.set(mediaId, controller);
    const poll = async () => {
      while (!controller.signal.aborted) {
        await wait(3_000, controller.signal);
        try {
          const job = await client.getGenerationJob(data.project.id, initialJob.id, controller.signal);
          setData((currentData) => updateMediaFromGeneration(
            currentData,
            storyboardId,
            itemId,
            mediaId,
            job,
          ));
          if (isGenerationFinal(job.status)) break;
        } catch (error) {
          if (controller.signal.aborted) break;
          console.warn("生成任务状态暂时不可用，将继续重试", error);
        }
      }
      if (generationPolls.current.get(mediaId) === controller) {
        generationPolls.current.delete(mediaId);
      }
    };
    void poll();
  }, [client, data.project.id]);
  const generateMedia = useCallback(async (
    storyboardId: string,
    itemId: string,
    mediaId: string,
    prompt: string,
    expectedRevision: number,
    generation: GenerationOptions,
    idempotencyKey: string,
    imageFiles?: readonly import("../generation/generationOptions").GenerationImageFile[],
  ) => {
    const workspace = data.workspaces[storyboardId];
    const objectIds = new Set(workspace ? mediaBackedObjectIds(workspace.navigationTree) : []);
    const referenceMedia = Object.entries(objectMedia)
      .filter(([objectId]) => objectIds.has(objectId))
      .map(([, media]) => media);
    const job = await client.requestMediaGeneration(
      data.project.id,
      storyboardId,
      mediaId,
      { prompt, expectedRevision, generation },
      idempotencyKey,
      undefined,
      imageFiles,
      referenceMedia,
    );
    setData((currentData) => updateMediaFromGeneration(
      currentData,
      storyboardId,
      itemId,
      mediaId,
      job,
      prompt,
    ));
    monitorGeneration(storyboardId, itemId, mediaId, job);
    return job;
  }, [client, data.project.id, data.workspaces, monitorGeneration, objectMedia]);
  const loadGenerationJob = useCallback((mediaId: string, jobId?: string | null, signal?: AbortSignal) =>
    jobId
      ? client.getGenerationJob(data.project.id, jobId, signal)
      : workspaceObjectMediaClient.getLatestGenerationJob(data.project.id, mediaId, signal),
  [client, data.project.id]);
  const value = useMemo(() => ({
    data,
    state,
    current: data.workspaces[state.currentStoryboardId],
    objectMedia,
    publishObjectMedia,
    publishWorkspaceNodeMedia,
    dispatch,
    createStoryboard,
    duplicateStoryboard,
    renameStoryboard,
    deleteStoryboard,
    reorderStoryboard,
    commitAppliedProposal,
    refreshNavigationTree,
    refreshScript,
    saveScript,
    createFolder,
    createObject,
    renameNode,
    deleteNode,
    copyNode,
    reorderNode,
    moveNode,
    markObjectViewed,
    loadGenerationModels,
    loadGenerationJob,
    generateMedia,
  }), [commitAppliedProposal, createFolder, createObject, renameNode, deleteNode, copyNode, reorderNode, moveNode, markObjectViewed, createStoryboard, duplicateStoryboard, renameStoryboard, deleteStoryboard, reorderStoryboard, data, generateMedia, loadGenerationJob, loadGenerationModels, objectMedia, publishObjectMedia, publishWorkspaceNodeMedia, refreshNavigationTree, refreshScript, saveScript, state]);
  return <WorkspaceContext.Provider value={value}>{children}</WorkspaceContext.Provider>;
}

function applyProposalResult(data: WorkspaceSnapshot, response: ApplyProposalResponse) {
  const { proposal, target, generationJob } = response;
  const workspace = data.workspaces[proposal.storyboardId];
  if (!workspace) return data;
  const updatedAt = new Date().toISOString();

  if (proposal.target.type === "script") {
    if (workspace.storyboard.script.revision > target.revision) return data;
    return {
      ...data,
      workspaces: {
        ...data.workspaces,
        [proposal.storyboardId]: {
          ...workspace,
          storyboard: {
            ...workspace.storyboard,
            script: {
              text: proposal.proposedValue,
              revision: target.revision,
              updatedAt,
            },
          },
        },
      },
    };
  }

  if (proposal.target.type !== "mediaPrompt") return data;
  const mediaId = proposal.target.mediaId;
  const updateGroups = (groups: NavigatorGroup[]) => groups.map((group) => ({
    ...group,
    items: group.items.map((item) => {
      if (item.media.id !== mediaId || item.media.revision > target.revision) return item;
      const pendingGeneration = generationJob
        && generationJob.status !== "succeeded"
        && generationJob.status !== "failed"
        && generationJob.status !== "cancelled";
      return {
        ...item,
        media: {
          ...item.media,
          prompt: proposal.proposedValue,
          revision: target.revision,
          status: pendingGeneration ? "processing" as const : item.media.status,
          updatedAt,
          generation: generationJob ? {
            jobId: generationJob.id,
            provider: generationJob.provider,
            model: generationJob.spec.model,
            error: generationJob.error,
          } : item.media.generation,
        },
      };
    }),
  }));
  return {
    ...data,
    workspaces: {
      ...data.workspaces,
      [proposal.storyboardId]: {
        ...workspace,
        assetGroups: updateGroups(workspace.assetGroups),
        videoGroups: updateGroups(workspace.videoGroups),
      },
    },
  };
}

function isGenerationFinal(status: GenerationJob["status"]) {
  return status === "succeeded" || status === "failed" || status === "cancelled";
}

function updateMediaFromGeneration(
  data: WorkspaceSnapshot,
  storyboardId: string,
  itemId: string,
  mediaId: string,
  job: WorkspaceGenerationJob,
  prompt?: string,
) {
  const workspace = data.workspaces[storyboardId];
  if (!workspace) return data;
  const updateGroups = (groups: NavigatorGroup[]) => groups.map((group) => ({
    ...group,
    items: group.items.map((item) => {
      if (item.id !== itemId || item.media.id !== mediaId) return item;
      const result = job.result ?? null;
      const failed = job.status === "failed" || job.status === "cancelled";
      const ready = job.status === "succeeded" && result;
      const access = ready ? {
        url: result.url,
        expiresAt: result.expiresAt,
        width: result.width ?? item.media.width ?? 1,
        height: result.height ?? item.media.height ?? 1,
      } : null;
      return {
        ...item,
        media: {
          ...item.media,
          prompt: prompt ?? item.media.prompt,
          revision: job.targetRevision,
          status: ready ? "ready" as const : failed ? "failed" as const : "processing" as const,
          mimeType: result?.mimeType ?? item.media.mimeType,
          width: result?.width ?? item.media.width,
          height: result?.height ?? item.media.height,
          durationMs: result?.durationMs ?? item.media.durationMs,
          thumbnail: result?.kind === "image" && access ? access : item.media.thumbnail,
          preview: result && access ? { ...access, mimeType: result.mimeType } : item.media.preview,
          generation: {
            jobId: job.id,
            provider: job.provider,
            model: job.spec.model,
            error: job.error,
          },
          updatedAt: job.updatedAt,
        },
      };
    }),
  }));
  return {
    ...data,
    workspaces: {
      ...data.workspaces,
      [storyboardId]: {
        ...workspace,
        assetGroups: updateGroups(workspace.assetGroups),
        videoGroups: updateGroups(workspace.videoGroups),
      },
    },
  };
}

function wait(duration: number, signal: AbortSignal) {
  return new Promise<void>((resolve) => {
    const timer = window.setTimeout(resolve, duration);
    signal.addEventListener("abort", () => {
      window.clearTimeout(timer);
      resolve();
    }, { once: true });
  });
}
