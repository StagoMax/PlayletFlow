# Videoflow 产品接口文档

状态：本地产品接口契约；云端子集差异见第 6.3 节
版本：1.1
基础路径：`/api/v1`

本文档以本地 SQLite 产品接口为准。云端 `VIDEOFLOW_CLOUD=1` 复用部分 `/api/v1` 路径，但使用 TOS 快照与单独的提案适配器；云端工作区和对话请求见[运行时 API](runtime-api.md)，数据归属见[轻量云工作区模块](cloud-workspace.md)。产品路由不得写入 `server/src/runtime.rs`；运行时只在组合层注册产品工具和注入可信上下文。

## 1. 通用约定

### 1.1 标识、时间和字段命名

- 所有 ID 为 UUID 字符串。
- JSON 字段使用 `camelCase`。
- 时间为 UTC RFC 3339，例如 `2026-09-26T08:20:00Z`。
- 可编辑实体包含从 1 开始单调递增的 `revision`。
- 排序字段 `position` 是服务端生成的稳定排序键，客户端不得自行推算相邻浮点值。
- `deletedAt` 非空表示软删除；普通列表默认不返回软删除项。

### 1.2 成功响应

单个资源直接返回资源对象。列表使用统一结构：

```json
{
  "items": [],
  "page": {
    "nextCursor": null,
    "total": 0
  }
}
```

创建返回 `201 Created`，普通修改返回 `200 OK`，没有响应体的删除返回 `204 No Content`，异步任务创建返回 `202 Accepted`。

### 1.3 错误响应

```json
{
  "error": {
    "code": "REVISION_CONFLICT",
    "message": "目标内容已经更新，请刷新后重试。",
    "requestId": "req_01...",
    "details": {
      "expectedRevision": 7,
      "actualRevision": 8
    }
  }
}
```

| HTTP | 错误码示例 | 含义 |
| --- | --- | --- |
| 400 | `INVALID_REQUEST` | JSON 或查询参数格式错误。 |
| 401 | `UNAUTHENTICATED` | 未登录。 |
| 403 | `PROJECT_ACCESS_DENIED` | 无项目访问权或资源不在当前作用域。 |
| 404 | `RESOURCE_NOT_FOUND` | 资源不存在或无权知道其存在。 |
| 409 | `REVISION_CONFLICT` | 修订冲突。 |
| 409 | `ASSET_IN_USE` | 共享资产仍被片段引用。 |
| 409 | `DUPLICATE_BINDING` | 目标片段已经引用同一资产。 |
| 409 | `PROPOSAL_NOT_PENDING` | 提案已处理，不能再次确认。 |
| 422 | `VALIDATION_FAILED` | 业务字段校验失败。 |
| 429 | `RATE_LIMITED` | 请求过多。 |
| 500 | `INTERNAL_ERROR` | 未预期错误。 |

### 1.4 并发与幂等

- `PATCH`、提案确认和会影响现有数据的命令必须携带 `expectedRevision`。
- `POST` 创建、复制、提案确认和生成重试必须携带 `Idempotency-Key` 请求头；同一用户、路由和键在 24 小时内返回第一次操作的结果。
- 幂等键相同但请求体不同返回 `409 IDEMPOTENCY_KEY_REUSED`。
- API 不采用“最后写入者胜出”覆盖内容。

## 2. 核心数据结构

### 2.1 Project

```ts
type Project = {
  id: string;
  name: string;
  revision: number;
  createdAt: string;
  updatedAt: string;
};
```

### 2.2 StoryboardSummary 与 StoryboardDetail

```ts
type StoryboardSummary = {
  id: string;
  projectId: string;
  name: string;
  position: string;
  index: number;              // 当前排序下从 0 开始，仅用于展示/定位
  revision: number;
  pendingProposalCount: number;
  thumbnail: MediaThumbnail | null;
  updatedAt: string;
};

type StoryboardDetail = StoryboardSummary & {
  script: StoryboardScript;
  counts: {
    assetBindings: number;
    keyframes: number;
    videos: number;
  };
  createdAt: string;
};

type StoryboardScript = {
  text: string;
  revision: number;
  updatedAt: string;
};
```

`index` 是本次响应中的派生值，不参与写操作。菜单定位使用服务端返回的 `anchorIndex`，避免客户端先加载全部片段。

### 2.3 AssetSection

```ts
type AssetSection = {
  id: string;
  storyboardId: string;
  parentId: string | null;
  name: string;
  kind: "character" | "scene" | "prop" | "custom";
  position: string;
  revision: number;
  bindingCount: number;
};
```

第一阶段树深最大为 2。类型只用于筛选与默认图标，不能限制自定义名称。

### 2.4 Asset 与 AssetBinding

```ts
type Asset = {
  id: string;
  projectId: string;
  type: "character" | "scene" | "prop" | "custom";
  name: string;
  description: string | null;
  canonicalPrompt: string | null;
  revision: number;
  referenceCount: number;
  representations: AssetRepresentation[];
  createdAt: string;
  updatedAt: string;
};

type AssetRepresentation = {
  id: string;
  assetId: string;
  label: string;              // 如“面部三视图”“俯视图”
  viewKind: "front" | "back" | "side" | "top" | "threeView" | "custom";
  mediaId: string | null;
  position: string;
};

type AssetBinding = {
  id: string;
  storyboardId: string;
  sectionId: string;
  assetId: string;
  position: string;
  promptOverride: string | null;
  derivedMediaId: string | null;
  revision: number;
  asset: Asset;
};
```

唯一约束为 `(storyboardId, assetId)`。同一资产在同一片段只出现一次，可移动到其他分区。若未来需要同一资产的多个镜头用途，应新增“用法实例”概念，而不是放开此约束造成重复项歧义。

### 2.5 MediaItem

```ts
type MediaItem = {
  id: string;
  projectId: string;
  owner:
    | { type: "asset"; assetId: string }
    | { type: "storyboard"; storyboardId: string };
  kind: "image" | "video";
  role: "assetView" | "firstFrame" | "lastFrame" | "keyframe" | "generatedVideo" | "custom";
  name: string;
  prompt: string | null;
  mimeType: string;
  width: number | null;
  height: number | null;
  durationMs: number | null;
  status: "placeholder" | "ready" | "processing" | "failed";
  revision: number;
  thumbnail: MediaThumbnail | null;
  preview: MediaAccess | null;
  generation: {
    jobId: string;
    provider: string | null;
    model: string | null;
    error: string | null;
  } | null;
  createdAt: string;
  updatedAt: string;
};

type MediaThumbnail = {
  url: string;                // 短期签名 URL 或同源 URL
  expiresAt: string | null;
  width: number;
  height: number;
};

type MediaAccess = MediaThumbnail & {
  mimeType: string;
};
```

媒体列表只返回缩略图。`preview` 可以是短期 URL；过期后通过媒体访问接口刷新，客户端不得持久化 URL。

### 2.6 ChangeProposal

```ts
type ChangeProposal = {
  id: string;
  projectId: string;
  storyboardId: string;
  target:
    | { type: "script"; storyboardId: string }
    | { type: "mediaPrompt"; mediaId: string }
    | { type: "assetBindingPrompt"; bindingId: string };
  baseRevision: number;
  beforeValue: string;
  proposedValue: string;
  summary: string;
  status: "pending" | "applying" | "applied" | "rejected" | "conflicted" | "expired" | "failed";
  source: {
    type: "ai";
    threadId: string;
    turnId: string;
    toolCallId: string;
  };
  revision: number;
  createdAt: string;
  resolvedAt: string | null;
};
```

## 3. 项目和片段接口

### 3.1 项目

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| `GET` | `/projects` | 列出可访问项目。 |
| `POST` | `/projects` | 创建项目和第一个空白片段。 |
| `GET` | `/projects/:projectId` | 获取项目。 |
| `PATCH` | `/projects/:projectId` | 修改名称等元数据。 |

### 3.2 获取片段菜单窗口

`GET /projects/:projectId/storyboards?anchorId=:currentId&before=25&after=25`

```json
{
  "items": [
    {
      "id": "3f...",
      "projectId": "91...",
      "name": "片段 137",
      "position": "p137",
      "index": 136,
      "revision": 4,
      "pendingProposalCount": 1,
      "thumbnail": null,
      "updatedAt": "2026-09-26T08:20:00Z"
    }
  ],
  "page": {
    "anchorId": "3f...",
    "anchorIndex": 136,
    "total": 200,
    "hasBefore": true,
    "hasAfter": true,
    "previousCursor": "opaque",
    "nextCursor": "opaque"
  }
}
```

省略 `anchorId` 时从头分页。锚点不存在返回 404。客户端打开菜单后使用 `anchorIndex` 或锚点元素执行居中滚动。

### 3.3 片段命令

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| `POST` | `/projects/:projectId/storyboards` | 新建片段。 |
| `GET` | `/projects/:projectId/storyboards/:storyboardId` | 工作区基本信息。 |
| `PATCH` | `/projects/:projectId/storyboards/:storyboardId` | 重命名。 |
| `POST` | `/projects/:projectId/storyboards/:storyboardId/reorder` | 移到另一片段前/后。 |
| `DELETE` | `/projects/:projectId/storyboards/:storyboardId` | 软删除片段。 |
| `POST` | `/projects/:projectId/storyboards/:storyboardId/restore` | 恢复片段。 |

创建请求：

```json
{
  "name": "片段 12",
  "insertAfterId": "current-storyboard-id",
  "reuseAssetsFrom": {
    "storyboardId": "source-storyboard-id",
    "bindingIds": ["binding-a", "binding-b"],
    "includePromptOverrides": false
  }
}
```

`reuseAssetsFrom` 省略表示空白片段。服务端在同一事务中创建分区映射和目标引用，响应额外包含复制报告：

```json
{
  "storyboard": {},
  "assetCopy": {
    "created": 2,
    "skipped": 0,
    "failed": []
  }
}
```

排序请求：

```json
{
  "beforeId": null,
  "afterId": "neighbor-storyboard-id",
  "expectedRevision": 4
}
```

`beforeId` 和 `afterId` 至少一个非空；二者都提供时必须相邻。

### 3.4 脚本

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| `GET` | `/projects/:projectId/storyboards/:storyboardId/script` | 获取正式脚本。 |
| `PATCH` | `/projects/:projectId/storyboards/:storyboardId/script` | 人工保存脚本。 |

```json
{
  "text": "镜头从城市上空缓慢下降……",
  "expectedRevision": 7
}
```

人工修改成功后脚本修订号增加。基于旧修订号的待确认提案不会被自动应用，并在下一次读取/确认时标记为 `conflicted`。

### 3.5 工作区资源树

资源树节点属于一个项目和片段。`parentId=null` 表示根级；`kind=folder` 时 `objectType=null`，`kind=object` 时必须提供 `objectType`。节点返回 `position`、`revision` 和可空的 `unseenUpdateAt`；后者表示仍待用户查看的 AI 更新。

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| `GET` | `/projects/:projectId/storyboards/:storyboardId/workspace-nodes` | 按顺序读取片段资源树节点。 |
| `POST` | `/projects/:projectId/storyboards/:storyboardId/workspace-nodes` | 创建文件夹或对象；要求 `Idempotency-Key`。 |
| `PATCH` | `/projects/:projectId/storyboards/:storyboardId/workspace-nodes/:nodeId` | 更新名称或父级；请求带 `expectedRevision`。 |
| `PATCH` | `/projects/:projectId/storyboards/:storyboardId/workspace-nodes/:nodeId/order` | 将节点放在目标节点前后；跨文件夹时在同一事务中更新父级和顺序。`beforeId`、`afterId` 必须恰有一个非空，且带 `expectedRevision`。 |
| `POST` | `/projects/:projectId/storyboards/:storyboardId/workspace-nodes/:nodeId/copies` | 复制节点；要求 `Idempotency-Key`。 |
| `DELETE` | `/projects/:projectId/storyboards/:storyboardId/workspace-nodes/:nodeId?expectedRevision=N` | 删除节点；成功返回 `204`。 |
| `PUT` | `/projects/:projectId/storyboards/:storyboardId/workspace-nodes/:nodeId/viewed` | 带 `seenThrough` 时间确认已查看；只清除不晚于该时刻的待查看标记。 |

跨项目或跨片段的父节点、循环移动和受保护的脚本节点由服务端拒绝。客户端只在写入成功后把返回节点合入本地树；失败时保留正式状态并展示错误。

## 4. 资产接口

### 4.1 资产分区

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| `GET` | `/projects/:projectId/storyboards/:storyboardId/asset-sections` | 返回完整两级分区树。 |
| `POST` | `/projects/:projectId/storyboards/:storyboardId/asset-sections` | 新建分区。 |
| `PATCH` | `/projects/:projectId/storyboards/:storyboardId/asset-sections/:sectionId` | 重命名、改类型或父级。 |
| `POST` | `/projects/:projectId/storyboards/:storyboardId/asset-sections/:sectionId/reorder` | 调整顺序。 |
| `DELETE` | `/projects/:projectId/storyboards/:storyboardId/asset-sections/:sectionId` | 删除分区。 |

删除非空分区必须明确提供策略：

`DELETE .../:sectionId?bindingAction=move&targetSectionId=:id&expectedRevision=3`

或：

`DELETE .../:sectionId?bindingAction=detach&expectedRevision=3`

### 4.2 项目共享资产库

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| `GET` | `/projects/:projectId/assets?type=&query=&cursor=&limit=50` | 搜索资产选择器。 |
| `POST` | `/projects/:projectId/assets` | 创建共享资产。 |
| `GET` | `/projects/:projectId/assets/:assetId` | 获取资产和视图。 |
| `PATCH` | `/projects/:projectId/assets/:assetId` | 显式修改共享资产。 |
| `DELETE` | `/projects/:projectId/assets/:assetId` | 删除未被引用的共享资产。 |
| `POST` | `/projects/:projectId/assets/:assetId/representations` | 添加视图槽位或关联媒体。 |

创建资产：

```json
{
  "type": "character",
  "name": "女主角",
  "description": "短发，冷色调服装",
  "canonicalPrompt": "cinematic character reference..."
}
```

### 4.3 片段资产引用

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| `GET` | `/projects/:projectId/storyboards/:storyboardId/asset-bindings` | 按分区返回引用。 |
| `POST` | `/projects/:projectId/storyboards/:storyboardId/asset-bindings` | 添加一个或多个共享资产引用。 |
| `PATCH` | `/projects/:projectId/storyboards/:storyboardId/asset-bindings/:bindingId` | 移动分区、排序或人工改片段级提示词。 |
| `DELETE` | `/projects/:projectId/storyboards/:storyboardId/asset-bindings/:bindingId` | 解除引用。 |
| `POST` | `/projects/:projectId/storyboards/:sourceId/asset-bindings:copy` | 向另一片段复制引用。 |

批量添加：

```json
{
  "sectionId": "people-section-id",
  "assetIds": ["asset-a", "asset-b"]
}
```

复制引用：

```json
{
  "targetStoryboardId": "target-id",
  "bindingIds": ["binding-a", "binding-b"],
  "includeSectionStructure": true,
  "targetSectionId": null,
  "includePromptOverrides": false,
  "onDuplicate": "skip"
}
```

响应：

```json
{
  "createdBindingIds": ["new-binding-id"],
  "skipped": [
    { "bindingId": "binding-b", "reason": "assetAlreadyBound" }
  ],
  "sectionMap": {
    "source-section-id": "target-section-id"
  }
}
```

接口禁止复制资产记录或对象存储文件。

`includeSectionStructure=false` 时必须提供 `targetSectionId`；为 `true` 时必须传 `null`。复制和分区映射在同一事务内完成，目标片段已有同一资产引用时按 `onDuplicate=skip` 返回，不产生重复引用。

## 5. 媒体与生成接口

### 5.1 列表和详情

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| `GET` | `/projects/:projectId/storyboards/:storyboardId/media?role=keyframe,generatedVideo&cursor=` | 片段媒体列表。 |
| `GET` | `/projects/:projectId/media/:mediaId` | 媒体详情。 |
| `POST` | `/projects/:projectId/media/:mediaId/access` | 刷新短期预览 URL。 |
| `PATCH` | `/projects/:projectId/media/:mediaId` | 人工修改名称或提示词。 |
| `DELETE` | `/projects/:projectId/media/:mediaId` | 软删除片段私有媒体。 |

媒体访问响应：

```json
{
  "thumbnail": {
    "url": "/media/signed/thumb-token",
    "expiresAt": "2026-09-26T08:35:00Z",
    "width": 320,
    "height": 320
  },
  "preview": {
    "url": "/media/signed/preview-token",
    "expiresAt": "2026-09-26T08:35:00Z",
    "width": 1080,
    "height": 1920,
    "mimeType": "image/webp"
  }
}
```

### 5.2 工作区对象媒体上传

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| `POST` | `/projects/:projectId/storyboards/:storyboardId/workspace-nodes/:nodeId/media` | 为图片/视频对象确保媒体占位符，并返回媒体详情。 |
| `PUT` | `/projects/:projectId/storyboards/:storyboardId/workspace-nodes/:nodeId/media?width=W&height=H&durationMs=D` | 本地运行时上传文件并绑定到对象；视频可传 `durationMs`。 |

上传使用原始文件字节及正确的 `Content-Type`。当前本地接口校验 MIME 与文件签名、对象类型、尺寸和大小（1 字节至 100 MB）；不支持本地媒体存储的部署返回依赖不可用错误。大文件直传对象存储属于后续扩展，不能把尚未实现的通用上传路径当成现有接口。

### 5.3 生成任务

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| `GET` | `/generation-models` | 获取服务端模型白名单与输入能力。 |
| `POST` | `/projects/:projectId/storyboards/:storyboardId/media/:mediaId/generations` | 用户编辑提示词后直接发起图片或视频生成。 |
| `PUT` | `/projects/:projectId/storyboards/:storyboardId/generation-inputs/:inputId` | 本地运行时上传图片生成用的参考图；`inputId` 为客户端 UUID，重复上传相同内容可安全重试。 |
| `GET` | `/projects/:projectId/generation-jobs/:jobId` | 查询状态。 |
| `POST` | `/projects/:projectId/generation-jobs/:jobId/retry` | 失败后重试。 |

直接生成请求必须携带 `Idempotency-Key`、`prompt`、`expectedRevision` 和可选生成参数。服务端在同一事务中更新提示词并写入生成任务/outbox，返回 `202`；这类任务的 `proposalId` 为 `null`。AI 提案确认仍在应用提案的事务内创建生成任务，客户端无需再额外创建。两条入口共享同一任务状态机：

本地参考图上传使用 `Content-Type: image/jpeg|image/png|image/webp`，查询参数传 `name`、`width`、`height`，单张最多 8 MB；生成请求通过 `generation.input.mediaIds` 引用上传后返回的媒体 ID。云部署则在生成请求中直接携带输入图片数据，由云端保存。

`queued | waitingForProvider | running | succeeded | failed | cancelled`

生成进度通过 SSE/事件接口推送；供应商没有可靠进度时只推送阶段，不推测百分比。

## 6. AI 会话绑定与提案接口

### 6.1 会话绑定

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| `GET` | `/projects/:projectId/storyboards/:storyboardId/ai-thread` | 获取当前片段最近使用的线程绑定；尚未绑定时返回 `200 null`。 |
| `POST` | `/projects/:projectId/storyboards/:storyboardId/ai-thread` | 创建并绑定一个 AgentRuntime 线程。 |
| `GET` | `/projects/:projectId/storyboards/:storyboardId/ai-threads` | 按创建时间倒序列出当前片段的全部线程绑定，用于会话切换。 |
| `DELETE` | `/projects/:projectId/storyboards/:storyboardId/ai-threads/:threadId` | 删除该片段指定会话及其绑定；成功返回 `204`。 |

```ts
type WorkspaceThreadBinding = {
  projectId: string;
  storyboardId: string;
  threadId: string;
  createdAt: string;
};
```

本地消息、历史和 SSE 使用 `/api/threads/:threadId/...` 契约。服务端发送消息前根据 `threadId` 查找绑定并构建只读 `StoryboardContext`；产品工具同样从绑定获取作用域，不接受模型提供的 `projectId` 或 `storyboardId`。云端的线程绑定及历史当前保存在浏览器，发送 `/api/turn` 时由工作区密钥与服务端快照再次验证片段作用域。

### 6.2 提案列表与处理

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| `GET` | `/projects/:projectId/storyboards/:storyboardId/proposals?status=pending,conflicted` | 获取左侧和详情区徽标来源。 |
| `GET` | `/projects/:projectId/proposals/:proposalId` | 获取完整差异。 |
| `POST` | `/projects/:projectId/proposals/:proposalId/apply` | 用户确认。 |
| `POST` | `/projects/:projectId/proposals/:proposalId/reject` | 用户取消。 |

确认请求：

```json
{
  "expectedProposalRevision": 1,
  "expectedTargetRevision": 7,
  "generation": {
    "model": "doubao-seedance-2-5-260628",
    "input": {
      "type": "firstLastFrames",
      "firstFrameMediaId": "first-frame-media-id",
      "lastFrameMediaId": "last-frame-media-id"
    },
    "videoResolution": "720p",
    "videoRatio": "adaptive",
    "durationSeconds": 5,
    "generateAudio": false
  }
}
```

`generation` 仅用于媒体提案且可省略。输入模式为 `textOnly`、
`firstLastFrames` 或 `referenceImages`；首尾帧与参考关键帧互斥。服务端会把
模型、输入媒体 ID 和输出参数固化到任务 `spec`，并校验模型能力及项目作用域。
取消请求仍携带两个预期版本，但不修改目标内容，也不要求目标版本保持不变。
如果目标变更使提案从 `pending` 变为 `conflicted`，取消可接受变更前的提案版本；
已应用、已取消或已过期的提案仍不可再次取消。

脚本提案成功响应：

```json
{
  "proposal": { "id": "proposal-id", "status": "applied" },
  "target": { "type": "script", "revision": 8 },
  "generationJob": null
}
```

媒体提示词提案成功响应包含唯一生成任务：

```json
{
  "proposal": { "id": "proposal-id", "status": "applied" },
  "target": { "type": "mediaPrompt", "revision": 4 },
  "generationJob": {
    "id": "job-id",
    "status": "waitingForProvider"
  }
}
```

本地应用流程在一个数据库事务内完成：锁定提案 → 验证状态和目标修订 → 更新目标 → 标记提案已应用 → 写入唯一生成任务或 outbox。调用外部生成供应商不在该事务中执行。

### 6.3 云端轻量提案适配器

云端只实现本节四个提案路径，不提供本地的 `/ai-thread` 持久绑定接口。每次请求都带 `X-Videoflow-Workspace-Key`；服务端在私有 TOS 文档内按项目和片段筛选提案。确认或取消仍提交 `expectedProposalRevision` 与 `expectedTargetRevision`，目标或提案变化返回 `409`。已应用提案的确认响应保存在提案记录中，重复确认返回该响应。

媒体提案确认时，浏览器先冲刷待同步快照，并按提案所选素材构造可选的 `inputs` 图片数据；服务端通过云端生成服务创建任务，再将目标、提案状态和任务信息写回工作区文档。该路径使用 TOS 条件写入和有限重试，不具备上一节所述的 SQLite 单事务边界。云端工作区快照的 GET/PUT、修订头、大小限制与冲突码见[运行时 API](runtime-api.md#云端工作区与会话)。

## 7. AI 工具契约

本地和云端片段会话使用同名的七个工具。工具输入不接受 `projectId`、`storyboardId` 或服务器文件路径。本地由 Runtime `threadId` 的数据库绑定推导作用域，云端由工作区密钥、请求片段和 TOS 快照校验作用域。创建工具直接写入新的导航对象和媒体占位符；提示词保存工具直接更新现有对象，但不触发生成；三个提案工具只创建待确认提案，提案内容仍由用户确认接口应用。

| 工具 | 输入重点 | 结果 |
| --- | --- | --- |
| `create_workspace_object` | `parentId`（根目录为 `null`）、`name`、`objectType=image/video`、`prompt` | 在当前片段指定目录创建图片或视频对象及媒体占位符，只保存提示词，不创建生成任务。 |
| `save_workspace_object_prompt` | `targetId`、`baseRevision`、`prompt` | 把提示词直接写入现有图片或视频对象的输入框；不创建提案或生成任务，检查目标修订。 |
| `search_storyboard_assets` | 可选 `query`、`kind`、`offset`、`limit` | 当前片段的文本、资产绑定、图片和视频摘要，含稳定 ID、状态和修订号；分页上限 100。 |
| `read_storyboard_asset` | `kind`、`id` | 完整文本或提示词、状态和修订号；本地路径还可返回最近生成任务使用的图片输入。 |
| `propose_text_patch` | `targetId`、`baseRevision`、`oldText`、`newText`、`summary` | 对当前片段脚本执行唯一匹配的精确替换，产生待确认提案。 |
| `propose_image_prompt_change` | `targetType=media/assetBinding`、`targetId`、`baseRevision`、`proposedPrompt`、`input`、`summary` | 图片或片段资产绑定的提示词提案及参考图选择。 |
| `propose_video_prompt_change` | `targetId`、`baseRevision`、`proposedPrompt`、`input`、`summary` | 视频提示词提案及图片输入选择。 |

`input` 复用 `GenerationInputSelection`：`textOnly` 不传图片；图片工具可用 `referenceImages`；视频工具可用 `firstLastFrames` 或 `referenceImages`。前者含必选首帧与可选尾帧，后者含按顺序排列的参考图片 ID。两类图片模式互斥；服务端检查数量、就绪状态及片段可见性。首帧与尾帧允许选择同一图片。用户确认面板展示提案所选素材，并允许在提交确认前调整；任务使用确认时显示的选择。若确认接口未提供生成选项，服务端使用提案保存的 `input`。

工具结果返回 `proposalId`、目标、`baseRevision`、`proposedInput` 和状态。共享资产媒体在检索结果中标为只读；修改它在当前片段的提示词时使用 `assetBinding` 覆盖提案，不更新全局媒体提示词。`read_storyboard_asset` 读取文本、提示词及元数据，不读取图片像素。普通空白文本节点只有导航记录，尚无文本内容存储，因此文本补丁仅支持已持久化的片段脚本。

`create_workspace_object` 是唯一直接创建产品对象的工具。`parentId` 必须来自当前片段的文件夹（或为 `null`）；本地由线程绑定、云端由工作区密钥和快照再次校验作用域。创建结果的媒体状态为 `placeholder`，提示词已保存，但不会写入生成任务。AI 回合结束后客户端刷新本地资源树或重读云端快照，因此新对象会出现在左侧栏。

本地工具用数据库记录和工具调用 ID 实现幂等重放；云端工具以 TOS 条件写入处理并发，当前未持久化逐工具调用的幂等记录。云端重试同一个创建工具可能产生第二个对象，调用方不得把这两种保证混为一谈。

当用户只要求撰写或填入提示词时，AgentRuntime 使用 `save_workspace_object_prompt`。它只允许修改当前作用域内、由片段拥有的图片/视频对象，检查修订号并更新提示词，不创建提案或生成任务。`propose_image_prompt_change` 与 `propose_video_prompt_change` 用于用户明确需要“确认后生成”的提案流程。

## 8. 事件接口

本地产品工作区使用项目级事件流补充请求/响应 API：

`GET /api/v1/projects/:projectId/events/stream?since=:seq`

事件信封：

```json
{
  "id": "event-id",
  "projectId": "project-id",
  "seq": 184,
  "occurredAt": "2026-09-26T08:20:00Z",
  "type": "proposal.created",
  "payload": {}
}
```

第一阶段事件类型：

- `storyboard.created|updated|deleted|reordered`
- `script.updated`
- `assetSection.created|updated|deleted|reordered`
- `asset.created|updated|deleted`
- `assetBinding.created|updated|deleted`
- `media.created|updated|deleted`
- `proposal.created|applied|rejected|conflicted|expired`
- `generation.queued|running|succeeded|failed`

服务端先持久化事件再广播；断线后按 `since` 重放。事件用于失效缓存和更新状态，不代替读取详情接口。

## 9. 请求顺序示例

### 9.1 打开工作区

1. 读取项目和上次片段 ID。
2. 以该 ID 为 `anchorId` 获取片段菜单窗口。
3. 并行读取片段详情、分区/引用、媒体、待确认提案和 AI 线程绑定。
4. 连接项目事件流和现有线程事件流。
5. 媒体缩略图进入视口时再加载，选中或悬停时获取预览访问地址。

### 9.2 AI 提出“确认后生成”的提示词变更（本地）

1. 用户在右侧发送消息。
2. AgentRuntime 使用 `search_storyboard_assets` 和 `read_storyboard_asset` 确认目标及可引用图片，再调用对应的图片或视频提示词工具；若用户要求新增对象，则从可信上下文选择目录并调用 `create_workspace_object`，此路径不会发起生成。
3. 工具验证线程绑定、目标修订及引用素材，保存含生成输入的 `pending` 提案，返回提案 ID。
4. 项目事件流发出 `proposal.created`，左侧对应项出现黄色状态。
5. 用户在详情区检查提示词和引用素材，可调整生成选项，然后调用提案 `apply`。
6. 服务端原子更新提示词、提案和生成 outbox，返回任务 ID。
7. 后台生成适配器处理任务，项目事件流更新进度，成功后替换该片段的派生媒体。

用户只要求保存提示词时，改用 `save_workspace_object_prompt`：目标内容直接更新，但不创建提案或生成任务。云端模式使用 `/api/turn`、TOS 快照和云端提案适配器，不依赖本地项目事件流；浏览器在回合结束后重读工作区。

## 10. 兼容与演进规则

- 本地 `/api/v1` 产品接口不破坏 `/api/threads` 契约；云端轻量适配器另有 `/api/cloud-workspace` 与 `/api/turn`，并只覆盖一部分产品路径。
- 可选字段可以向后兼容地增加；删除字段、改变含义或收紧枚举需要新 API 版本。
- 工具名称和必填字段视为模型契约。本次工具集包含一个对象创建工具、一个直接提示词保存工具、两个读取工具和三个定向提案工具；既有历史工具事件仍可读取，新的模型回合只暴露当前七个工具。
- TypeScript 类型应从一份机器可读契约生成或由契约测试校验，不能在前后端各自手写后长期漂移。
- 本文档是语义说明；[openapi.json](./openapi.json) 是本地产品 API 的机器可读 OpenAPI 3.1 契约，由前端构建执行生成文件漂移检查。云端专用 `/api/cloud-workspace` 与 `/api/turn` 的现行语义以[运行时 API](runtime-api.md)和对应路由测试为准。
