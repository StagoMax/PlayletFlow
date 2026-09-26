import type {
  GenerationJob,
  GenerationModel,
  MediaItem,
  MediaKind,
  MediaRole,
  MediaStatus,
  Project,
  StoryboardDetail,
  StoryboardScript,
  StoryboardSummary,
} from "../productApi/generated";
import type { NavigatorGroup, StoryboardWorkspace, WorkspaceSnapshot } from "./types";
import { cloneNavigatorGroup, copyStoryboardWorkspace, hydrateFixtureStoryboards } from "./fixtureStoryboardSnapshots";
import { withStoryboardOrder, withoutStoryboard } from "./storyboardOrder";
import { createCloudGenerationClient } from "../generation/cloudGenerationClient";
import { appendTreeNode, createNavigationTree, findFolder, findTreeNode, mergeWorkspaceTrees, removeTreeNode, renameTreeNode } from "./resourceTree";
import { createStoryboardClient } from "../storyboards/storyboardClient";
import type { WorkspaceClient } from "./workspaceClient";
import { FIXTURE_VIDEO_PREVIEW_MIME_TYPE, FIXTURE_VIDEO_PREVIEW_URL } from "./fixtureVideoPreview";
import {
  createWorkspaceNodeClient,
  ensurePersistedFolderPath,
  workspaceTreeFromNodes,
  workspaceTreeNodeFromNode,
} from "./workspaceNodeClient";

export type WorkspaceFixtureMode = "live" | "ready" | "empty" | "error" | "slow" | "acceptance";

const project: Project = {
  id: "10000000-0000-4000-8000-000000000001",
  name: "霓虹港湾 · 概念短片",
  revision: 12,
  createdAt: "2026-09-18T03:20:00.000Z",
  updatedAt: "2026-09-26T06:30:00.000Z",
};

const generationModels: GenerationModel[] = [
  {
    id: "doubao-seedream-5-0-260128",
    label: "Seedream 5.0 Lite",
    kind: "image",
    supportsFirstLastFrames: false,
    maxReferenceImages: 10,
    minDurationSeconds: null,
    maxDurationSeconds: null,
  },
  {
    id: "doubao-seedance-2-0-mini-260615",
    label: "Seedance 2.0 Mini · 省钱",
    kind: "video",
    supportsFirstLastFrames: true,
    maxReferenceImages: 9,
    minDurationSeconds: 4,
    maxDurationSeconds: 15,
  },
];

const storyboardNames = [
  "雾港建立镜头", "列车穿过雨幕", "主角走下站台", "寻找失踪信号", "旧码头入口", "无人机掠过水面",
  "仓库内部", "发现遗留终端", "警报突然亮起", "追逐开始", "穿越集装箱", "桥下短暂对峙",
  "信号源现身", "机械守卫苏醒", "霓虹街巷逃脱", "天台喘息", "远处塔楼启动", "再次收到讯息",
  "乘船离港", "水下灯群", "抵达防波堤", "最后的坐标", "晨光穿过云层", "未完待续",
];

function storyboardSummary(index: number, name: string): StoryboardSummary {
  const number = index + 1;
  return {
    id: `20000000-0000-4000-8000-${String(number).padStart(12, "0")}`,
    projectId: project.id,
    name,
    position: String(number * 1024),
    index: number,
    revision: 3 + (index % 4),
    pendingProposalCount: index === 11 ? 2 : index % 9 === 0 ? 1 : 0,
    thumbnail: null,
    updatedAt: `2026-09-${String(20 + (index % 7)).padStart(2, "0")}T08:30:00.000Z`,
  };
}

type FixtureItem = {
  id: string;
  name: string;
  navigationName?: string;
  subject?: { id: string; name: string };
  description: string;
  label: string;
  prompt: string;
  accent: string;
  kind?: MediaKind;
  role: MediaRole;
  width?: number;
  height?: number;
  durationMs?: number | null;
  status?: MediaStatus;
  error?: string | null;
};

function item(storyboardId: string, fixture: FixtureItem) {
  const kind = fixture.kind ?? "image";
  const width = fixture.width ?? 1200;
  const height = fixture.height ?? 1200;
  const status = fixture.status ?? "ready";
  const artwork = artworkDataUrl(fixture.name, fixture.label, fixture.accent, width, height);
  const access = {
    url: artwork,
    expiresAt: null,
    width,
    height,
  };
  const media: MediaItem = {
    id: fixture.id,
    projectId: project.id,
    owner: { type: "storyboard", storyboardId },
    kind,
    role: fixture.role,
    name: fixture.name,
    prompt: fixture.prompt,
    mimeType: kind === "video" ? "video/mp4" : "image/svg+xml",
    width,
    height,
    durationMs: kind === "video" ? fixture.durationMs ?? 6_000 : null,
    status,
    revision: 2,
    thumbnail: status === "placeholder" ? null : access,
    preview: status === "ready"
      ? kind === "image"
        ? { ...access, mimeType: "image/svg+xml" }
        : { ...access, url: FIXTURE_VIDEO_PREVIEW_URL, mimeType: FIXTURE_VIDEO_PREVIEW_MIME_TYPE }
      : null,
    generation: {
      jobId: `job-${fixture.id}`,
      provider: "fixture",
      model: "Videoflow Preview",
      error: fixture.error ?? null,
    },
    createdAt: "2026-09-25T08:20:00.000Z",
    updatedAt: "2026-09-26T06:30:00.000Z",
  };
  return {
    id: fixture.id,
    name: fixture.name,
    navigationName: fixture.navigationName,
    subject: fixture.subject,
    description: fixture.description,
    label: fixture.label,
    accent: fixture.accent,
    media,
  };
}

function artworkDataUrl(name: string, label: string, accent: string, width: number, height: number) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
    <defs>
      <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1"><stop stop-color="#0b1020"/><stop offset="1" stop-color="${accent}"/></linearGradient>
      <pattern id="grid" width="48" height="48" patternUnits="userSpaceOnUse"><path d="M48 0H0V48" fill="none" stroke="white" stroke-opacity=".08"/></pattern>
    </defs>
    <rect width="100%" height="100%" fill="url(#bg)"/><rect width="100%" height="100%" fill="url(#grid)"/>
    <circle cx="72%" cy="28%" r="22%" fill="white" fill-opacity=".11"/>
    <path d="M0 ${height * .8} Q ${width * .28} ${height * .55} ${width * .5} ${height * .74} T ${width} ${height * .5} V ${height} H0Z" fill="#070a11" fill-opacity=".68"/>
    <text x="7%" y="78%" fill="white" font-family="Inter, sans-serif" font-size="${Math.max(24, width / 24)}" font-weight="650">${name}</text>
    <text x="7%" y="86%" fill="white" fill-opacity=".62" font-family="Inter, sans-serif" font-size="${Math.max(16, width / 40)}">${label} · Videoflow fixture</text>
  </svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

function assetGroups(storyboardId: string, index: number): NavigatorGroup[] {
  const suffix = storyboardId.slice(-2);
  return [
    {
      id: `${storyboardId}-characters`,
      name: "角色",
      kind: "character",
      items: [
        item(storyboardId, { id: `character-face-${suffix}`, name: "林舟 · 面部三视图", navigationName: "面部三视图", subject: { id: "lin-zhou", name: "林舟" }, description: "保持面部特征与年龄一致", label: "面部", prompt: "28岁东亚女性，冷静克制，正面与左右侧面角色设定图", accent: "#b37cff", role: "assetView" }),
        item(storyboardId, { id: `character-costume-${suffix}`, name: "林舟 · 防雨服装", navigationName: "防雨服装", subject: { id: "lin-zhou", name: "林舟" }, description: "深色机能风服装设定", label: "服装", prompt: "深蓝防雨风衣，反光肩线，正面背面侧面服装三视图", accent: "#5577ff", role: "assetView", width: 900, height: 1600 }),
      ],
    },
    {
      id: `${storyboardId}-scenes`,
      name: "场景",
      kind: "scene",
      items: [
        item(storyboardId, { id: `scene-harbor-${suffix}`, name: index > 12 ? "高塔外围" : "雨夜旧码头", description: "当前片段的主环境视图", label: "场景", prompt: "雨夜工业港口，湿润地面反射青蓝霓虹，电影感广角", accent: "#21b8c7", role: "assetView", width: 1600, height: 900 }),
      ],
    },
    {
      id: `${storyboardId}-props`,
      name: "道具",
      kind: "prop",
      items: [
        item(storyboardId, { id: `prop-terminal-${suffix}`, name: "便携式信号终端", description: "贯穿故事的关键道具", label: "道具", prompt: "磨损的便携信号终端，琥珀色波形屏幕，工业设计三视图", accent: "#f49a4a", role: "assetView" }),
      ],
    },
  ];
}

function videoGroups(storyboardId: string, index: number): NavigatorGroup[] {
  const suffix = storyboardId.slice(-2);
  return [
    {
      id: `${storyboardId}-keyframes`,
      name: "片段关键帧",
      kind: "keyframe",
      items: [
        item(storyboardId, { id: `first-frame-${suffix}`, name: "首帧", description: "镜头开始时的构图", label: "首帧", prompt: "低机位广角，人物从画面左侧进入，港口灯光形成纵深", accent: "#475bd8", role: "firstFrame", width: 1600, height: 900 }),
        item(storyboardId, { id: `key-frame-${suffix}`, name: "关键帧", description: "动作节奏的视觉锚点", label: "关键帧", prompt: `第 ${index} 个片段的动作高潮，动态构图，保留角色与场景一致性`, accent: "#a652d1", role: "keyframe", width: 1600, height: 900 }),
        item(storyboardId, { id: `last-frame-${suffix}`, name: "尾帧", description: "为下一个片段预留运动方向", label: "尾帧", prompt: "主体停在右侧三分线，镜头朝下一个场景运动方向留白", accent: "#3545a1", role: "lastFrame", width: 1600, height: 900 }),
      ],
    },
    {
      id: `${storyboardId}-videos`,
      name: "生成的视频",
      kind: "generatedVideo",
      items: [
        item(storyboardId, { id: `video-draft-${suffix}`, name: "生成版本 03", description: "6 秒 · 24 fps · 1080p", label: "视频", prompt: "镜头缓慢前推，细雨与远处警示灯形成视差，人物保持自然步态", accent: "#d55383", kind: "video", role: "generatedVideo", width: 1920, height: 1080, durationMs: 6_000 }),
        item(storyboardId, { id: `video-alt-${suffix}`, name: "备选版本 02", description: "6 秒 · 24 fps · 1080p", label: "视频", prompt: "手持镜头轻微晃动，强调紧张感，结尾聚焦信号终端", accent: "#8d4fd1", kind: "video", role: "generatedVideo", width: 1920, height: 1080, durationMs: 6_000 }),
      ],
    },
  ];
}

function storyboardWorkspace(summary: StoryboardSummary): StoryboardWorkspace {
  const storyboard: StoryboardDetail = {
    ...summary,
    script: {
      text: `雨水打在金属顶棚上。林舟停在${summary.name}的入口，确认终端上闪烁的坐标后继续向前。镜头从环境全景缓慢推进到她手中的信号终端。`,
      revision: summary.revision,
      updatedAt: summary.updatedAt,
    },
    counts: { assetBindings: 4, keyframes: 3, videos: 2 },
    createdAt: "2026-09-20T08:00:00.000Z",
  };
  const assets = assetGroups(summary.id, summary.index);
  const videos = videoGroups(summary.id, summary.index);
  return {
    storyboard,
    assetGroups: assets,
    videoGroups: videos,
    navigationTree: createNavigationTree(summary.id, assets, videos),
  };
}

function createSnapshot(count = storyboardNames.length, initialIndex = 11): WorkspaceSnapshot {
  const names = Array.from(
    { length: count },
    (_, index) => storyboardNames[index] ?? `验收片段 ${index + 1}`,
  );
  const storyboards = names.map((name, index) => storyboardSummary(index, name));
  return {
    project,
    storyboards,
    workspaces: Object.fromEntries(storyboards.map((storyboard) => [storyboard.id, storyboardWorkspace(storyboard)])),
    initialStoryboardId: storyboards[Math.min(initialIndex, storyboards.length - 1)]?.id ?? "",
  };
}

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
  let snapshot = mode === "acceptance" ? createSnapshot(200, 136) : mode === "live" ? createSnapshot(0) : createSnapshot();
  const generationRequests = new Map<string, { fingerprint: string; job: GenerationJob }>();
  const cloudGeneration = import.meta.env.PROD ? createCloudGenerationClient() : null;
  const nodeClient = import.meta.env.PROD ? null : createWorkspaceNodeClient();
  const storyboardClient = createStoryboardClient();
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
    snapshot = { ...snapshot, storyboards: [], workspaces: {}, initialStoryboardId: "" };
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
      snapshot = updateNavigationTree(snapshot, storyboardId, navigationTree);
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
      if (mode === "live" || mode === "ready") {
        try {
          snapshot = await hydrateFixtureStoryboards(snapshot, storyboardClient, signal);
        } catch (cause) {
          if (signal.aborted) throw cause;
          if (mode === "live") throw cause;
          console.warn("[workspace] storyboard list is unavailable; using the local fixture snapshot", cause);
        }
      }
      const initialWorkspace = snapshot.workspaces[snapshot.initialStoryboardId];
      if (initialWorkspace) {
        const script = await loadScript(snapshot.project.id, snapshot.initialStoryboardId, signal);
        if (script) snapshot = updateScriptSnapshot(snapshot, snapshot.initialStoryboardId, script);
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
      snapshot = withStoryboardOrder({
        ...snapshot,
        initialStoryboardId: snapshot.initialStoryboardId || response.storyboard.id,
      }, storyboards, { [response.storyboard.id]: workspace });
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
      snapshot = withStoryboardOrder(snapshot, storyboards, { [storyboard.id]: workspace });
      return { storyboard, workspace };
    },
    async reorderStoryboard(projectId, storyboardId, request, idempotencyKey, signal) {
      const updated = await storyboardClient.reorder(projectId, storyboardId, request, idempotencyKey, signal);
      const storyboards = snapshot.storyboards.filter((item) => item.id !== storyboardId);
      const index = storyboards.findIndex((item) => item.id === (request.beforeId ?? request.afterId));
      storyboards.splice(index + (request.afterId ? 1 : 0), 0, updated);
      snapshot = withStoryboardOrder(snapshot, storyboards);
      return updated;
    },
    async renameStoryboard(projectId, storyboardId, rawName, expectedRevision) {
      const name = validateResourceName(rawName);
      const updated = await storyboardClient.update(projectId, storyboardId, { name, expectedRevision });
      const workspace = requireWorkspace(snapshot, projectId, storyboardId);
      snapshot = {
        ...snapshot,
        storyboards: snapshot.storyboards.map((item) => item.id === storyboardId ? { ...item, ...updated } : item),
        workspaces: { ...snapshot.workspaces, [storyboardId]: {
          ...workspace, storyboard: updated,
        } },
      };
      return updated;
    },
    async deleteStoryboard(projectId, storyboardId, expectedRevision) {
      await storyboardClient.delete(projectId, storyboardId, expectedRevision);
      snapshot = withoutStoryboard(snapshot, storyboardId);
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
      snapshot = updateScriptSnapshot(snapshot, storyboardId, script);
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
      snapshot = updateNavigationTree(snapshot, storyboardId, appendTreeNode(workspace.navigationTree, parentId, node));
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
              selection: { kind: "emptyObject" as const, objectId: id, objectType },
            };
          })();
      if (node.kind !== "object") throw new Error("服务端返回了无效的对象节点。");
      snapshot = updateNavigationTree(snapshot, storyboardId, appendTreeNode(workspace.navigationTree, parentId, node));
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
      snapshot = updateNavigationTree(snapshot, storyboardId, tree);
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
      snapshot = updateNavigationTree(snapshot, storyboardId, tree);
      return tree;
    },
    async copyNode(projectId, storyboardId, nodeId) {
      const workspace = requireWorkspace(snapshot, projectId, storyboardId);
      if (!findTreeNode(workspace.navigationTree, nodeId)) throw new Error("资源不存在，请刷新后重试。");
      if (!nodeClient) throw new Error("当前环境无法复制资源。");
      await nodeClient.copy(projectId, storyboardId, nodeId);
      const nodes = await nodeClient.list(projectId, storyboardId);
      const tree = reconcileTree(workspace, storyboardId, nodes);
      snapshot = updateNavigationTree(snapshot, storyboardId, tree);
      return tree;
    },
    async requestMediaGeneration(projectId, storyboardId, mediaId, request, idempotencyKey, signal) {
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
          entries.map((entry) => entry.media),
          signal,
        );
        snapshot = updateGenerationSnapshot(snapshot, storyboardId, mediaId, request.prompt.trim(), job);
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
      snapshot = updateGenerationSnapshot(snapshot, storyboardId, mediaId, prompt, job);
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
