import { useCallback, useEffect, useMemo, useReducer, useRef, useState, type ReactNode } from "react";
import type {
  ApplyProposalResponse,
  GenerationJob,
  GenerationOptions,
  StoryboardScript,
} from "../productApi/generated";
import type {
  NavigatorGroup,
  WorkspaceFolderNode,
  WorkspaceObjectNode,
  WorkspaceObjectType,
  WorkspaceSnapshot,
} from "./types";
import { appendTreeNode } from "./resourceTree";
import type { WorkspaceClient } from "./workspaceClient";
import type { WorkspaceGenerationJob } from "./workspaceClient";
import { createWorkspaceState, workspaceReducer } from "./workspaceReducer";
import { WorkspaceContext } from "./WorkspaceContext";

type WorkspaceProviderProps = {
  client: WorkspaceClient;
  data: WorkspaceSnapshot;
  children: ReactNode;
};

export function WorkspaceProvider({ client, data: initialData, children }: WorkspaceProviderProps) {
  const [data, setData] = useState(initialData);
  const [state, dispatch] = useReducer(workspaceReducer, data.initialStoryboardId, createWorkspaceState);
  const generationPolls = useRef(new Map<string, AbortController>());
  useEffect(() => () => {
    generationPolls.current.forEach((controller) => controller.abort());
    generationPolls.current.clear();
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    void client
      .loadNavigationTree(data.project.id, state.currentStoryboardId, controller.signal)
      .then((navigationTree) => {
        if (!navigationTree) return;
        setData((currentData) => {
          const workspace = currentData.workspaces[state.currentStoryboardId];
          if (!workspace) return currentData;
          return {
            ...currentData,
            workspaces: {
              ...currentData.workspaces,
              [state.currentStoryboardId]: { ...workspace, navigationTree },
            },
          };
        });
      })
      .catch((error: unknown) => {
        if (!(error instanceof DOMException && error.name === "AbortError")) {
          console.error("无法同步工作区资源树", error);
        }
      });
    return () => controller.abort();
  }, [client, data.project.id, state.currentStoryboardId]);
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
        console.error("无法同步分镜脚本", error);
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
  const listAssetBindings = useCallback(
    (storyboardId: string, signal: AbortSignal) => client.listAssetBindings(data.project.id, storyboardId, signal),
    [client, data.project.id],
  );
  const createStoryboard = useCallback(async (input: {
    name: string;
    sourceStoryboardId: string;
    bindingIds: string[];
    includePromptOverrides: boolean;
  }) => {
    const created = await client.createStoryboard(
      data.project.id,
      {
        name: input.name,
        insertAfterId: input.sourceStoryboardId,
        reuseAssetsFrom: input.bindingIds.length > 0 ? {
          storyboardId: input.sourceStoryboardId,
          bindingIds: input.bindingIds,
          includePromptOverrides: input.includePromptOverrides,
        } : null,
      },
      crypto.randomUUID(),
    );
    setData((currentData) => {
      const sourceIndex = currentData.storyboards.findIndex((item) => item.id === input.sourceStoryboardId);
      const storyboards = [...currentData.storyboards];
      storyboards.splice(sourceIndex + 1, 0, created.storyboard);
      const normalized = storyboards.map((storyboard, index) => ({ ...storyboard, index: index + 1 }));
      return {
        ...currentData,
        storyboards: normalized,
        workspaces: { ...currentData.workspaces, [created.storyboard.id]: created.workspace },
      };
    });
    dispatch({
      type: "storyboardSelected",
      storyboardId: created.storyboard.id,
      selection: { kind: "script", storyboardId: created.storyboard.id },
    });
    return created.assetCopy;
  }, [client, data.project.id]);
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
  ) => {
    const job = await client.requestMediaGeneration(
      data.project.id,
      storyboardId,
      mediaId,
      { prompt, expectedRevision, generation },
      idempotencyKey,
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
  }, [client, data.project.id, monitorGeneration]);
  const value = useMemo(() => ({
    data,
    state,
    current: data.workspaces[state.currentStoryboardId],
    dispatch,
    listAssetBindings,
    createStoryboard,
    commitAppliedProposal,
    refreshScript,
    saveScript,
    createFolder,
    createObject,
    loadGenerationModels,
    generateMedia,
  }), [commitAppliedProposal, createFolder, createObject, createStoryboard, data, generateMedia, listAssetBindings, loadGenerationModels, refreshScript, saveScript, state]);
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
