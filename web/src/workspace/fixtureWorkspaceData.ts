import type { GenerationModel, MediaItem, MediaKind, MediaRole, MediaStatus, Project, StoryboardDetail, StoryboardSummary } from "../productApi/generated";
import type { NavigatorGroup, StoryboardWorkspace, WorkspaceSnapshot } from "./types";
import { createNavigationTree } from "./resourceTree";
import { FIXTURE_VIDEO_PREVIEW_MIME_TYPE, FIXTURE_VIDEO_PREVIEW_URL } from "./fixtureVideoPreview";

const project: Project = {
  id: "10000000-0000-4000-8000-000000000001",
  name: "霓虹港湾 · 概念短片",
  revision: 12,
  createdAt: "2026-09-18T03:20:00.000Z",
  updatedAt: "2026-09-26T06:30:00.000Z",
};

export const generationModels: GenerationModel[] = [
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
    label: "Seedance 2.0 Mini",
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
  mediaId?: string;
  generationJobId?: string | null;
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
    id: fixture.mediaId ?? fixture.id,
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
    generation: fixture.generationJobId === null ? null : {
      jobId: fixture.generationJobId ?? `job-${fixture.id}`,
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
        item(storyboardId, { id: `video-draft-${suffix}`, mediaId: `60000000-0000-4000-8000-${storyboardId.slice(-12)}`, generationJobId: null, name: "生成版本 03", description: "6 秒 · 24 fps · 1080p", label: "视频", prompt: "镜头缓慢前推，细雨与远处警示灯形成视差，人物保持自然步态", accent: "#d55383", kind: "video", role: "generatedVideo", width: 1920, height: 1080, durationMs: 6_000 }),
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

export function createSnapshot(count = storyboardNames.length, initialIndex = 11): WorkspaceSnapshot {
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
