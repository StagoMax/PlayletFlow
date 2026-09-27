import type { GenerationJob, StoryboardScript } from "../productApi/generated";
import type { NavigatorGroup, StoryboardWorkspace, WorkspaceSnapshot } from "./types";
import { cloneNavigatorGroup, copyStoryboardWorkspace, hydrateFixtureStoryboards } from "./fixtureStoryboardSnapshots";
import { createSnapshot, generationModels } from "./fixtureWorkspaceData";
import { withStoryboardOrder, withoutStoryboard } from "./storyboardOrder";
import { createCloudGenerationClient } from "../generation/cloudGenerationClient";
import { appendTreeNode, createNavigationTree, findFolder, findTreeNode, mergeWorkspaceTrees, moveTreeNode, removeTreeNode, renameTreeNode, reorderTreeNode, updateNodeUnseenUpdateAt } from "./resourceTree";
import { createStoryboardClient } from "../storyboards/storyboardClient";
import { createBrowserStoryboardClient } from "../storyboards/browserStoryboardClient";
import { hydrateBrowserWorkspaceMedia, loadBrowserWorkspace, saveBrowserWorkspace } from "./browserWorkspaceStorage";
import { welcomeSelection, welcomeStoryboardId } from "./welcomeWorkspace";
import type { WorkspaceClient } from "./workspaceClient";
import {
  createWorkspaceNodeClient,
  ensurePersistedFolderPath,
  workspaceTreeFromNodes,
  workspaceTreeNodeFromNode,
} from "./workspaceNodeClient";

export type WorkspaceFixtureMode = "live" | "ready" | "empty" | "error" | "slow" | "acceptance";

function delay(duration: number, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    const abort = () => {
      window.clearTimeout(timer);
      reject(new DOMException("Aborted", "AbortError"));
    };
    const timer = window.setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    }, duration);
    signal.addEventListener("abort", abort, { once: true });
  });
}

export function fixtureModeFromLocation(): WorkspaceFixtureMode {
  const mode = new URLSearchParams(window.location.search).get("fixture");
  return mode === "ready" || mode === "empty" || mode === "error" || mode === "slow" || mode === "acceptance" ? mode : "live";
}

export function createFixtureWorkspaceClient(mode: WorkspaceFixtureMode = "live"): WorkspaceClient {
  const browserWorkspace = import.meta.env.PROD && mode === "live";
  let snapshot = browserWorkspace
    ? loadBrowserWorkspace()
    : mode === "acceptance" ? createSnapshot(200, 136) : mode === "live" ? createSnapshot(0) : createSnapshot();
  const setSnapshot = (next: WorkspaceSnapshot) => {
    snapshot = next;
    if (browserWorkspace) {
      const latestMedia = loadBrowserWorkspace().objectMedia;
      saveBrowserWorkspace({ ...next, objectMedia: { ...next.objectMedia, ...latestMedia } });
    }
  };
  const generationRequests = new Map<string, { fingerprint: string; job: GenerationJob }>();
  const cloudGeneration = import.meta.env.PROD ? createCloudGenerationClient() : null;
  const nodeClient = import.meta.env.PROD ? null : createWorkspaceNodeClient();
  const storyboardClient = browserWorkspace
    ? createBrowserStoryboardClient(() => snapshot)
    : createStoryboardClient();
  const isSeededStoryboard = (storyboardId: string) => /^20000000-0000-4000-8000-\d{12}$/.test(storyboardId);
  const isCopiedStoryboard = (storyboardId: string) => {
    try { return Boolean(window.localStorage.getItem(`videoflow:storyboard-source:${storyboardId}`)); }
    catch { return false; }
  };
  const reconcileTree = (workspace: StoryboardWorkspace, storyboardId: string, nodes: import("../productApi/generated").WorkspaceNode[]) => {
    const persisted = workspaceTreeFromNodes(nodes);
    const fixtureHasMedia = [...workspace.assetGroups, ...workspace.videoGroups].some((group) => group.items.length > 0);
    const authoritative = isSeededStoryboard(storyboardId) || isCopiedStoryboard(storyboardId)
      || !fixtureHasMedia || nodes.some((node) => node.targetType === "media");
    return authoritative ? persisted : mergeWorkspaceTrees(workspace.navigationTree, persisted);
  };
  if (mode === "empty") {
    setSnapshot({ ...snapshot, storyboards: [], workspaces: {}, initialStoryboardId: "" });
  }

  const loadNavigationTree: WorkspaceClient["loadNavigationTree"] = async (
    projectId,
    storyboardId,
    signal,
  ) => {
    if (!nodeClient) return null;
    try {
      const nodes = await nodeClient.list(projectId, storyboardId, signal);
      const workspace = snapshot.workspaces[storyboardId];
      if (!workspace) return null;
      const navigationTree = reconcileTree(workspace, storyboardId, nodes);
      setSnapshot(updateNavigationTree(snapshot, storyboardId, navigationTree));
      return navigationTree;
    } catch (cause) {
      if (signal?.aborted) throw cause;
      console.warn("[workspace] optional persisted resource tree is unavailable; using fixture data", cause);
      return null;
    }
  };
  const loadScript: WorkspaceClient["loadScript"] = async (projectId, storyboardId, signal) => {
    try {
      return await storyboardClient.getScript(projectId, storyboardId, signal);
    } catch (cause) {
      if (signal?.aborted) throw cause;
      console.warn("[workspace] canonical script is unavailable; using the local fixture snapshot", cause);
      return null;
    }
  };

  return {
    async load(signal) {
      if (mode === "slow") await delay(3_000, signal);
      else if (signal.aborted) throw signal.reason;
      if (mode === "error") throw new Error("无法加载工作区数据，请检查网络后重试。");
      if (browserWorkspace) {
        snapshot = await hydrateBrowserWorkspaceMedia(snapshot);
        saveBrowserWorkspace(snapshot);
        return snapshot;
      }
      if (mode === "live" || mode === "ready") {
        try {
          setSnapshot(await hydrateFixtureStoryboards(snapshot, storyboardClient, signal));
        } catch (cause) {
          if (signal.aborted) throw cause;
          if (mode === "live") throw cause;
          console.warn("[workspace] storyboard list is unavailable; using the local fixture snapshot", cause);
        }
      }
      if (mode === "live" && snapshot.initialStoryboardId === welcomeStoryboardId) {
        const tree = await loadNavigationTree(snapshot.project.id, welcomeStoryboardId, signal);
        if (tree && findTreeNode(tree, welcomeSelection.nodeId ?? "")) {
          setSnapshot({ ...snapshot, initialSelection: welcomeSelection });
        }
      }
      const initialWorkspace = snapshot.workspaces[snapshot.initialStoryboardId];
      if (initialWorkspace) {
        const script = await loadScript(snapshot.project.id, snapshot.initialStoryboardId, signal);
        if (script) setSnapshot(updateScriptSnapshot(snapshot, snapshot.initialStoryboardId, script));
      }
      // The fixture snapshot is the complete first paint. Persisted workspace
      // nodes are an optional overlay loaded by WorkspaceProvider after mount;
      // keeping them out of this path makes reload independent of backend I/O.
      return snapshot;
    },
    async createStoryboard(projectId, request, idempotencyKey, signal) {
      const response = await storyboardClient.create(projectId, request, idempotencyKey, signal);
      const source = request.reuseAssetsFrom
        ? snapshot.workspaces[request.reuseAssetsFrom.storyboardId]
        : null;
      const assets = source ? source.assetGroups.map(cloneNavigatorGroup) : [];
      const workspace: StoryboardWorkspace = {
        storyboard: response.storyboard,
        assetGroups: assets,
        videoGroups: [],
        navigationTree: createNavigationTree(response.storyboard.id, assets, []),
      };
      const sourceIndex = snapshot.storyboards.findIndex((item) => item.id === request.insertAfterId);
      const storyboards = [...snapshot.storyboards];
      storyboards.splice(sourceIndex + 1, 0, response.storyboard);
      setSnapshot(withStoryboardOrder({
        ...snapshot,
        initialStoryboardId: snapshot.initialStoryboardId || response.storyboard.id,
      }, storyboards, { [response.storyboard.id]: workspace }));
      return { ...response, workspace };
    },
    async duplicateStoryboard(projectId, storyboardId, idempotencyKey, signal) {
      const storyboard = await storyboardClient.duplicate(projectId, storyboardId, idempotencyKey, signal);
      const source = requireWorkspace(snapshot, projectId, storyboardId);
      const workspace = copyStoryboardWorkspace(source, storyboard);
      try { window.localStorage.setItem(`videoflow:storyboard-source:${storyboard.id}`, storyboardId); } catch { /* storage unavailable */ }
      const storyboards = [...snapshot.storyboards];
      const index = storyboards.findIndex((item) => item.id === storyboardId);
      storyboards.splice(index + 1, 0, storyboard);
      setSnapshot(withStoryboardOrder(snapshot, storyboards, { [storyboard.id]: workspace }));
      return { storyboard, workspace };
    },
    async reorderStoryboard(projectId, storyboardId, request, idempotencyKey, signal) {
      const updated = await storyboardClient.reorder(projectId, storyboardId, request, idempotencyKey, signal);
      const storyboards = snapshot.storyboards.filter((item) => item.id !== storyboardId);
      const index = storyboards.findIndex((item) => item.id === (request.beforeId ?? request.afterId));
      storyboards.splice(index + (request.afterId ? 1 : 0), 0, updated);
      setSnapshot(withStoryboardOrder(snapshot, storyboards));
      return updated;
    },
    async renameStoryboard(projectId, storyboardId, rawName, expectedRevision) {
      const name = validateResourceName(rawName);
      const updated = await storyboardClient.update(projectId, storyboardId, { name, expectedRevision });
      const workspace = requireWorkspace(snapshot, projectId, storyboardId);
      setSnapshot({
        ...snapshot,
        storyboards: snapshot.storyboards.map((item) => item.id === storyboardId ? { ...item, ...updated } : item),
        workspaces: { ...snapshot.workspaces, [storyboardId]: {
          ...workspace, storyboard: updated,
        } },
      });
      return updated;
    },
    async deleteStoryboard(projectId, storyboardId, expectedRevision) {
      await storyboardClient.delete(projectId, storyboardId, expectedRevision);
      setSnapshot(withoutStoryboard(snapshot, storyboardId));
    },
    loadNavigationTree,
    loadScript,
    async listGenerationModels(signal) {
      if (cloudGeneration) return cloudGeneration.listModels(signal);
      await delay(80, signal ?? new AbortController().signal);
      return generationModels;
    },
    async updateScript(projectId, storyboardId, request, signal) {
      if (projectId !== snapshot.project.id) throw new Error("项目不存在，无法保存脚本。");
      const workspace = snapshot.workspaces[storyboardId];
      if (!workspace) throw new Error("片段不存在，无法保存脚本。");
      if (Array.from(request.text).length > 20_000) {
        throw new Error("脚本不能超过 20,000 个字符。");
      }
      const script = await storyboardClient.updateScript(projectId, storyboardId, request, signal);
      setSnapshot(updateScriptSnapshot(snapshot, storyboardId, script));
      return script;
    },
    async createFolder(projectId, storyboardId, parentId, rawName, signal) {
      await delay(120, signal ?? new AbortController().signal);
      const workspace = requireWorkspace(snapshot, projectId, storyboardId);
      const name = validateResourceName(rawName);
      validateParentFolder(workspace, parentId);
      const persistedParentId = nodeClient
        ? await ensurePersistedFolderPath(nodeClient, projectId, storyboardId, workspace.navigationTree, parentId, signal)
        : parentId;
      const node = nodeClient
        ? workspaceTreeNodeFromNode(await nodeClient.create(projectId, storyboardId, {
            parentId: persistedParentId,
            kind: "folder",
            name,
            objectType: null,
          }, signal))
        : { kind: "folder" as const, id: crypto.randomUUID(), name, children: [] };
      if (node.kind !== "folder") throw new Error("服务端返回了无效的文件夹节点。");
      setSnapshot(updateNavigationTree(snapshot, storyboardId, appendTreeNode(workspace.navigationTree, parentId, node)));
      return node;
    },
    async createObject(projectId, storyboardId, parentId, rawName, objectType, signal) {
      await delay(120, signal ?? new AbortController().signal);
      const workspace = requireWorkspace(snapshot, projectId, storyboardId);
      const name = validateResourceName(rawName);
      validateParentFolder(workspace, parentId);
      const persistedParentId = nodeClient
        ? await ensurePersistedFolderPath(nodeClient, projectId, storyboardId, workspace.navigationTree, parentId, signal)
        : parentId;
      const node = nodeClient
        ? workspaceTreeNodeFromNode(await nodeClient.create(projectId, storyboardId, {
            parentId: persistedParentId,
            kind: "object",
            name,
            objectType,
          }, signal))
        : (() => {
            const id = crypto.randomUUID();
            return {
              kind: "object" as const,
              id,
              name,
              objectType,
              unseenUpdateAt: null,
              selection: { kind: "emptyObject" as const, objectId: id, objectType },
            };
          })();
      if (node.kind !== "object") throw new Error("服务端返回了无效的对象节点。");
      setSnapshot(updateNavigationTree(snapshot, storyboardId, appendTreeNode(workspace.navigationTree, parentId, node)));
      return node;
    },
    async renameNode(projectId, storyboardId, nodeId, rawName) {
      const workspace = requireWorkspace(snapshot, projectId, storyboardId);
      const node = findTreeNode(workspace.navigationTree, nodeId);
      if (!node) throw new Error("资源不存在，请刷新后重试。");
      const name = validateResourceName(rawName);
      if (nodeClient) {
        const saved = (await nodeClient.list(projectId, storyboardId)).find((entry) => entry.id === nodeId);
        if (!saved) throw new Error("该资源尚未同步到服务端，请刷新后重试。");
        await nodeClient.update(projectId, storyboardId, nodeId, {
          parentId: saved.parentId, name, expectedRevision: saved.revision,
        });
      }
      const tree = renameTreeNode(workspace.navigationTree, nodeId, name);
      setSnapshot(updateNavigationTree(snapshot, storyboardId, tree));
      return tree;
    },
    async deleteNode(projectId, storyboardId, nodeId) {
      const workspace = requireWorkspace(snapshot, projectId, storyboardId);
      if (!findTreeNode(workspace.navigationTree, nodeId)) throw new Error("资源不存在，请刷新后重试。");
      if (nodeClient) {
        const saved = (await nodeClient.list(projectId, storyboardId)).find((entry) => entry.id === nodeId);
        if (!saved) throw new Error("该资源尚未同步到服务端，请刷新后重试。");
        await nodeClient.delete(projectId, storyboardId, nodeId, saved.revision);
      }
      const tree = removeTreeNode(workspace.navigationTree, nodeId);
      setSnapshot(updateNavigationTree(snapshot, storyboardId, tree));
      return tree;
    },
    async copyNode(projectId, storyboardId, nodeId) {
      const workspace = requireWorkspace(snapshot, projectId, storyboardId);
      if (!findTreeNode(workspace.navigationTree, nodeId)) throw new Error("资源不存在，请刷新后重试。");
      if (!nodeClient) throw new Error("当前环境无法复制资源。");
      await nodeClient.copy(projectId, storyboardId, nodeId);
      const nodes = await nodeClient.list(projectId, storyboardId);
      const tree = reconcileTree(workspace, storyboardId, nodes);
      setSnapshot(updateNavigationTree(snapshot, storyboardId, tree));
      return tree;
    },
    async reorderNode(projectId, storyboardId, nodeId, targetId, placement) {
      const workspace = requireWorkspace(snapshot, projectId, storyboardId);
      if (nodeClient) {
        const nodes = await nodeClient.list(projectId, storyboardId);
        const source = nodes.find((node) => node.id === nodeId);
        const target = nodes.find((node) => node.id === targetId);
        if (!source || !target) throw new Error("该资源尚未同步到服务端，请刷新后重试。");
        await nodeClient.reorder(projectId, storyboardId, nodeId, {
          beforeId: placement === "before" ? targetId : null,
          afterId: placement === "after" ? targetId : null,
          expectedRevision: source.revision,
        });
      }
      const tree = reorderTreeNode(workspace.navigationTree, nodeId, targetId, placement);
      setSnapshot(updateNavigationTree(snapshot, storyboardId, tree));
      return tree;
    },
    async moveNode(projectId, storyboardId, nodeId, parentId) {
      const workspace = requireWorkspace(snapshot, projectId, storyboardId);
      const tree = moveTreeNode(workspace.navigationTree, nodeId, parentId);
      if (nodeClient) {
        const saved = (await nodeClient.list(projectId, storyboardId)).find((node) => node.id === nodeId);
        if (!saved) throw new Error("该资源尚未同步到服务端，请刷新后重试。");
        await nodeClient.update(projectId, storyboardId, nodeId, {
          parentId, name: saved.name, expectedRevision: saved.revision,
        });
      }
      setSnapshot(updateNavigationTree(snapshot, storyboardId, tree));
      return tree;
    },
    async markObjectViewed(projectId, storyboardId, nodeId, seenThrough) {
      const workspace = requireWorkspace(snapshot, projectId, storyboardId);
      const unseenUpdateAt = nodeClient
        ? (await nodeClient.markViewed(projectId, storyboardId, nodeId, { seenThrough })).unseenUpdateAt
        : null;
      const tree = updateNodeUnseenUpdateAt(workspace.navigationTree, nodeId, unseenUpdateAt);
      setSnapshot(updateNavigationTree(snapshot, storyboardId, tree));
      return tree;
    },
    async requestMediaGeneration(projectId, storyboardId, mediaId, request, idempotencyKey, signal, imageFiles, referenceMedia = []) {
      if (cloudGeneration) {
        const workspace = requireWorkspace(snapshot, projectId, storyboardId);
        const entries = [...workspace.assetGroups, ...workspace.videoGroups]
          .flatMap((group) => group.items);
        const selected = entries.find((entry) => entry.media.id === mediaId);
        if (!selected) throw new Error("媒体不存在，无法提交生成任务。");
        const job = await cloudGeneration.create(
          projectId,
          storyboardId,
          mediaId,
          selected.media.kind,
          request,
          idempotencyKey,
          [...entries.map((entry) => entry.media), ...referenceMedia],
          signal,
          imageFiles,
        );
        setSnapshot(updateGenerationSnapshot(snapshot, storyboardId, mediaId, request.prompt.trim(), job));
        return job;
      }
      await delay(360, signal ?? new AbortController().signal);
      const fingerprint = JSON.stringify({ projectId, storyboardId, mediaId, request });
      const replay = generationRequests.get(idempotencyKey);
      if (replay) {
        if (replay.fingerprint !== fingerprint) throw new Error("该生成请求标识已用于其他内容。");
        return replay.job;
      }
      if (projectId !== snapshot.project.id) throw new Error("项目不存在，无法提交生成任务。");
      const workspace = snapshot.workspaces[storyboardId];
      if (!workspace) throw new Error("片段不存在，无法提交生成任务。");
      const groups = [...workspace.assetGroups, ...workspace.videoGroups];
      const selected = groups.flatMap((group) => group.items).find((entry) => entry.media.id === mediaId);
      if (!selected) throw new Error("媒体不存在，无法提交生成任务。");
      if (selected.media.revision !== request.expectedRevision) {
        throw new Error("媒体已在其他位置更新，请刷新后再试。");
      }
      const prompt = request.prompt.trim();
      if (!prompt || Array.from(prompt).length > 10_000) {
        throw new Error("生成提示词需要包含 1 至 10,000 个字符。");
      }
      const generation = request.generation ?? {};
      const isVideo = selected.media.kind === "video";
      const now = new Date().toISOString();
      const job: GenerationJob = {
        id: crypto.randomUUID(),
        projectId,
        storyboardId,
        proposalId: null,
        targetType: "mediaPrompt",
        targetId: mediaId,
        targetRevision: selected.media.revision + 1,
        spec: isVideo
          ? {
              model: generation.model || "doubao-seedance-2-0-mini-260615",
              input: generation.input ?? { type: "textOnly" },
              imageSize: null,
              videoResolution: generation.videoResolution ?? "480p",
              videoRatio: generation.videoRatio ?? "16:9",
              durationSeconds: generation.durationSeconds ?? 4,
              generateAudio: generation.generateAudio ?? false,
            }
          : {
              model: generation.model || "doubao-seedream-5-0-260128",
              input: generation.input ?? { type: "textOnly" },
              imageSize: generation.imageSize ?? "2K",
              videoResolution: null,
              videoRatio: null,
              durationSeconds: null,
              generateAudio: null,
            },
        status: "waitingForProvider",
        attempt: 0,
        provider: null,
        resultMediaId: null,
        error: null,
        createdAt: now,
        updatedAt: now,
      };
      setSnapshot(updateGenerationSnapshot(snapshot, storyboardId, mediaId, prompt, job));
      generationRequests.set(idempotencyKey, { fingerprint, job });
      return job;
    },
    async getGenerationJob(projectId, jobId, signal) {
      if (cloudGeneration) return cloudGeneration.get(projectId, jobId, signal);
      const job = Array.from(generationRequests.values())
        .map((request) => request.job)
        .find((candidate) => candidate.id === jobId && candidate.projectId === projectId);
      if (!job) throw new Error("生成任务不存在。");
      return job;
    },
  };
}

function updateScriptSnapshot(
  snapshot: WorkspaceSnapshot,
  storyboardId: string,
  script: StoryboardScript,
): WorkspaceSnapshot {
  const workspace = snapshot.workspaces[storyboardId];
  if (!workspace) return snapshot;
  return {
    ...snapshot,
    workspaces: {
      ...snapshot.workspaces,
      [storyboardId]: {
        ...workspace,
        storyboard: { ...workspace.storyboard, script },
      },
    },
  };
}

function updateGenerationSnapshot(
  snapshot: WorkspaceSnapshot,
  storyboardId: string,
  mediaId: string,
  prompt: string,
  job: GenerationJob,
) {
  const workspace = snapshot.workspaces[storyboardId];
  if (!workspace) return snapshot;
  const updateGroups = (source: NavigatorGroup[]) => source.map((group) => ({
    ...group,
    items: group.items.map((entry) => entry.media.id !== mediaId
      ? entry
      : {
          ...entry,
          media: {
            ...entry.media,
            prompt,
            revision: job.targetRevision,
            status: "processing" as const,
            generation: {
              jobId: job.id,
              provider: job.provider,
              model: job.spec.model,
              error: job.error,
            },
            updatedAt: job.updatedAt,
          },
        }),
  }));
  return {
    ...snapshot,
    workspaces: {
      ...snapshot.workspaces,
      [storyboardId]: {
        ...workspace,
        assetGroups: updateGroups(workspace.assetGroups),
        videoGroups: updateGroups(workspace.videoGroups),
      },
    },
  };
}

function requireWorkspace(snapshot: WorkspaceSnapshot, projectId: string, storyboardId: string) {
  if (projectId !== snapshot.project.id) throw new Error("项目不存在，无法创建内容。");
  const workspace = snapshot.workspaces[storyboardId];
  if (!workspace) throw new Error("片段不存在，无法创建内容。");
  return workspace;
}

function validateParentFolder(workspace: StoryboardWorkspace, parentId: string | null) {
  if (parentId !== null && !findFolder(workspace.navigationTree, parentId)) {
    throw new Error("目标文件夹不存在，无法创建内容。");
  }
}

function validateResourceName(value: string) {
  const name = value.trim();
  if (!name) throw new Error("名称不能为空。");
  if (Array.from(name).length > 120) throw new Error("名称不能超过 120 个字符。");
  return name;
}

function updateNavigationTree(snapshot: WorkspaceSnapshot, storyboardId: string, navigationTree: StoryboardWorkspace["navigationTree"]) {
  const workspace = snapshot.workspaces[storyboardId];
  return {
    ...snapshot,
    workspaces: {
      ...snapshot.workspaces,
      [storyboardId]: { ...workspace, navigationTree },
    },
  };
}
