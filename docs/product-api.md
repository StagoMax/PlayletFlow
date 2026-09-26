# Videoflow 产品接口文档

状态：第一阶段契约基线  
版本：1.0  
基础路径：`/api/v1`

本文档定义分镜工作区的产品接口。当前已经实现的通用 AgentRuntime 接口见 [runtime-api.md](./runtime-api.md)。产品路由不得写入 `server/src/runtime.rs`；运行时只在组合层注册产品工具和注入可信上下文。

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
| 409 | `ASSET_IN_USE` | 共享资产仍被分镜引用。 |
| 409 | `DUPLICATE_BINDING` | 目标分镜已经引用同一资产。 |
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

`index` 是本次响应中的派生值，不参与写操作。菜单定位使用服务端返回的 `anchorIndex`，避免客户端先加载全部分镜。

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

唯一约束为 `(storyboardId, assetId)`。同一资产在同一分镜只出现一次，可移动到其他分区。若未来需要同一资产的多个镜头用途，应新增“用法实例”概念，而不是放开此约束造成重复项歧义。

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

## 3. 项目和分镜接口

### 3.1 项目

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| `GET` | `/projects` | 列出可访问项目。 |
| `POST` | `/projects` | 创建项目和第一个空白分镜。 |
| `GET` | `/projects/:projectId` | 获取项目。 |
| `PATCH` | `/projects/:projectId` | 修改名称等元数据。 |

### 3.2 获取分镜菜单窗口

`GET /projects/:projectId/storyboards?anchorId=:currentId&before=25&after=25`

```json
{
  "items": [
    {
      "id": "3f...",
      "projectId": "91...",
      "name": "分镜 137",
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

### 3.3 分镜命令

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| `POST` | `/projects/:projectId/storyboards` | 新建分镜。 |
| `GET` | `/projects/:projectId/storyboards/:storyboardId` | 工作区基本信息。 |
| `PATCH` | `/projects/:projectId/storyboards/:storyboardId` | 重命名。 |
| `POST` | `/projects/:projectId/storyboards/:storyboardId/reorder` | 移到另一分镜前/后。 |
| `DELETE` | `/projects/:projectId/storyboards/:storyboardId` | 软删除分镜。 |
| `POST` | `/projects/:projectId/storyboards/:storyboardId/restore` | 恢复分镜。 |

创建请求：

```json
{
  "name": "分镜 12",
  "insertAfterId": "current-storyboard-id",
  "reuseAssetsFrom": {
    "storyboardId": "source-storyboard-id",
    "bindingIds": ["binding-a", "binding-b"],
    "includePromptOverrides": false
  }
}
```

`reuseAssetsFrom` 省略表示空白分镜。服务端在同一事务中创建分区映射和目标引用，响应额外包含复制报告：

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

### 4.3 分镜资产引用

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| `GET` | `/projects/:projectId/storyboards/:storyboardId/asset-bindings` | 按分区返回引用。 |
| `POST` | `/projects/:projectId/storyboards/:storyboardId/asset-bindings` | 添加一个或多个共享资产引用。 |
| `PATCH` | `/projects/:projectId/storyboards/:storyboardId/asset-bindings/:bindingId` | 移动分区、排序或人工改分镜级提示词。 |
| `DELETE` | `/projects/:projectId/storyboards/:storyboardId/asset-bindings/:bindingId` | 解除引用。 |
| `POST` | `/projects/:projectId/storyboards/:sourceId/asset-bindings:copy` | 向另一分镜复制引用。 |

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

`includeSectionStructure=false` 时必须提供 `targetSectionId`；为 `true` 时必须传 `null`。复制和分区映射在同一事务内完成，目标分镜已有同一资产引用时按 `onDuplicate=skip` 返回，不产生重复引用。

## 5. 媒体与生成接口

### 5.1 列表和详情

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| `GET` | `/projects/:projectId/storyboards/:storyboardId/media?role=keyframe,generatedVideo&cursor=` | 分镜媒体列表。 |
| `GET` | `/projects/:projectId/media/:mediaId` | 媒体详情。 |
| `POST` | `/projects/:projectId/media/:mediaId/access` | 刷新短期预览 URL。 |
| `PATCH` | `/projects/:projectId/media/:mediaId` | 人工修改名称或提示词。 |
| `DELETE` | `/projects/:projectId/media/:mediaId` | 软删除分镜私有媒体。 |

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

### 5.2 上传（可选实现）

1. `POST /projects/:projectId/uploads` 获取一次性上传 URL 和 `uploadId`。
2. 浏览器直接向对象存储上传。
3. `POST /projects/:projectId/uploads/:uploadId/complete` 校验大小、类型和摘要并创建媒体。

禁止由应用服务器把大视频完整缓冲到内存。

### 5.3 生成任务

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| `GET` | `/generation-models` | 获取服务端模型白名单与输入能力。 |
| `POST` | `/projects/:projectId/storyboards/:storyboardId/media/:mediaId/generations` | 用户编辑提示词后直接发起图片或视频生成。 |
| `GET` | `/projects/:projectId/generation-jobs/:jobId` | 查询状态。 |
| `POST` | `/projects/:projectId/generation-jobs/:jobId/retry` | 失败后重试。 |

直接生成请求必须携带 `Idempotency-Key`、`prompt`、`expectedRevision` 和可选生成参数。服务端在同一事务中更新提示词并写入生成任务/outbox，返回 `202`；这类任务的 `proposalId` 为 `null`。AI 提案确认仍在应用提案的事务内创建生成任务，客户端无需再额外创建。两条入口共享同一任务状态机：

`queued | waitingForProvider | running | succeeded | failed | cancelled`

生成进度通过 SSE/事件接口推送；供应商没有可靠进度时只推送阶段，不推测百分比。

## 6. AI 会话绑定与提案接口

### 6.1 会话绑定

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| `GET` | `/projects/:projectId/storyboards/:storyboardId/ai-thread` | 获取当前分镜最近使用的线程绑定；尚未绑定时返回 `200 null`。 |
| `POST` | `/projects/:projectId/storyboards/:storyboardId/ai-thread` | 创建并绑定一个 AgentRuntime 线程。 |
| `GET` | `/projects/:projectId/storyboards/:storyboardId/ai-threads` | 按创建时间倒序列出当前分镜的全部线程绑定，用于会话切换。 |

```ts
type WorkspaceThreadBinding = {
  projectId: string;
  storyboardId: string;
  threadId: string;
  createdAt: string;
};
```

消息、历史和 SSE 继续使用现有 `/api/threads/:threadId/...` 契约。服务端发送消息前根据 `threadId` 查找绑定并构建只读 `StoryboardContext`；产品工具同样从绑定获取作用域，不接受模型提供的 `projectId` 或 `storyboardId`。

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

应用流程必须在一个数据库事务内完成：锁定提案 → 验证状态和目标修订 → 更新目标 → 标记提案已应用 → 写入唯一生成任务或 outbox。调用外部生成供应商不在该事务中执行。

## 7. AI 工具契约

工具是产品应用服务的适配器，只创建提案。工具实现不得直接执行 SQL，不得直接修改 `Storyboard`、`AssetBinding` 或 `MediaItem`。

### 7.1 `propose_script_change`

描述：为当前会话绑定的分镜提出脚本修改，等待用户确认。

输入 JSON Schema：

```json
{
  "type": "object",
  "properties": {
    "proposedText": {
      "type": "string",
      "minLength": 1,
      "maxLength": 20000
    },
    "summary": {
      "type": "string",
      "minLength": 1,
      "maxLength": 300
    }
  },
  "required": ["proposedText", "summary"],
  "additionalProperties": false
}
```

工具从可信上下文读取 `storyboardId`、当前脚本和修订号。输出：

```json
{
  "proposalId": "proposal-id",
  "status": "pending",
  "targetType": "script",
  "baseRevision": 7,
  "message": "脚本修改已提交，等待用户确认。"
}
```

### 7.2 `propose_media_prompt_change`

描述：为当前分镜中可见的图片、视频或资产引用提出提示词修改。

输入 JSON Schema：

```json
{
  "type": "object",
  "properties": {
    "targetType": {
      "type": "string",
      "enum": ["media", "assetBinding"]
    },
    "targetId": { "type": "string", "format": "uuid" },
    "proposedPrompt": {
      "type": "string",
      "minLength": 1,
      "maxLength": 10000
    },
    "summary": {
      "type": "string",
      "minLength": 1,
      "maxLength": 300
    }
  },
  "required": ["targetType", "targetId", "proposedPrompt", "summary"],
  "additionalProperties": false
}
```

服务端验证目标确实属于或被当前分镜引用。对共享资产的修改创建 `assetBinding` 级覆盖提案，不更新 `Asset.canonicalPrompt`。

输出：

```json
{
  "proposalId": "proposal-id",
  "status": "pending",
  "targetType": "assetBindingPrompt",
  "targetId": "binding-id",
  "baseRevision": 3,
  "message": "提示词修改已提交，确认后才会应用并创建生成任务。"
}
```

## 8. 事件接口

工作区使用一个项目级事件流补充请求/响应 API：

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

1. 读取项目和上次分镜 ID。
2. 以该 ID 为 `anchorId` 获取分镜菜单窗口。
3. 并行读取分镜详情、分区/引用、媒体、待确认提案和 AI 线程绑定。
4. 连接项目事件流和现有线程事件流。
5. 媒体缩略图进入视口时再加载，选中或悬停时获取预览访问地址。

### 9.2 AI 修改提示词

1. 用户在右侧发送消息。
2. AgentRuntime 调用 `propose_media_prompt_change`。
3. 工具验证线程绑定与目标，保存 `pending` 提案，返回提案 ID。
4. 项目事件流发出 `proposal.created`，左侧对应项出现黄色状态。
5. 用户在详情区确认，客户端调用提案 `apply`。
6. 服务端原子更新提示词、提案和生成 outbox，返回任务 ID。
7. 后台生成适配器处理任务，项目事件流更新进度，成功后替换该分镜的派生媒体。

## 10. 兼容与演进规则

- 第一阶段只新增 `/api/v1` 产品接口，不破坏当前 `/api/threads` 契约。
- 可选字段可以向后兼容地增加；删除字段、改变含义或收紧枚举需要新 API 版本。
- 工具名称和必填字段视为模型契约；变更时保留旧工具一段迁移期。
- TypeScript 类型应从一份机器可读契约生成或由契约测试校验，不能在前后端各自手写后长期漂移。
- 本文档是语义说明；[openapi.json](./openapi.json) 是机器可读的 OpenAPI 3.1 契约，并由前端构建执行生成文件漂移检查。
