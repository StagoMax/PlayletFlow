# 当前架构与模块边界

本文记录当前代码的职责和改动入口。产品范围见 [需求文档](product-requirements.md)；HTTP 语义见 [产品 API](product-api.md)和[运行时 API](runtime-api.md)。[OpenAPI](openapi.json) 描述本地 `/api/v1` 产品契约；轻量云适配器的差异另见运行时 API 文档。

## 依赖方向

```text
浏览器组件 → 模块 client → HTTP API → 应用服务 → 领域规则
                                           ↓
                                    仓储/供应商端口
                                           ↑
                                 SQLite/媒体/模型适配器

AgentRuntime → 产品工具适配器 → 产品应用服务

云端浏览器快照 → /api/cloud-workspace → cloud_workspace → 私有 TOS
云端 /api/turn → cloud_workspace 作用域工具 → 同一份 TOS 文档
```

本地产品领域不依赖 HTTP、SQLite、React 或模型供应商。路由负责解析与映射请求，应用服务负责用例、项目作用域、修订与事务边界，基础设施负责持久化和外部服务。本地 AI 工具通过应用服务操作产品对象；脚本和生成提案的确认规则由服务端执行。

`VIDEOFLOW_CLOUD=1` 使用单独的轻量云适配器：浏览器保存工作区副本，服务端以随机工作区密钥定位 TOS JSON 文档，用 TOS 修订号做条件写入；云端提案及七个作用域工具在 `cloud_workspace/` 操作该文档。这条路径不经过本地 SQLite 应用服务，也不具备本地数据库事务或账户权限模型。改动共享业务规则时要检查两条实现，避免语义漂移。详细读写流程见[轻量云工作区模块](cloud-workspace.md)。

运行时调用由 `runtime::RuntimeTurnRequest` 统一传入会话标识、历史、事件发送器、工作区上下文和取消信号。`conversation.rs` 负责线程生命周期及事件持久化，`cloud.rs` 与本地入口只负责组装请求和返回协议，避免逐层扩展位置参数。

## 服务端模块

| 路径 | 职责 | 修改时关注 |
| --- | --- | --- |
| `server/src/product/domain/` | 产品对象、标识、错误与规则 | 不引入数据库、Axum 或供应商类型 |
| `server/src/product/application/` | 项目、片段、资产、媒体、提案、生成等用例及端口 | 保持修订冲突、幂等和项目作用域 |
| `server/src/product/infrastructure/` | SQLite 仓储、迁移、媒体存储与生成适配 | 写操作事务、迁移兼容与外部失败恢复 |
| `server/src/product/api/` | `/api/v1` 产品路由与请求映射 | 与 OpenAPI、语义文档、HTTP 测试同步 |
| `server/src/product/tools/` | AgentRuntime 到产品用例的工具适配 | 不绕过应用服务直接写数据库 |
| `server/src/runtime.rs`、`conversation.rs`、`api.rs`、`cloud.rs` | 通用会话、事件、Runtime 与本地/云入口 | 与产品域保持明确的绑定接口 |
| `server/src/cloud_workspace/` | 云端快照/提案 API、TOS 修订写入与七个作用域工具 | 校验工作区密钥和片段作用域；并发冲突不得静默覆盖 |
| `server/src/cloud_generation/` | 云端请求与任务状态，TOS 归档生成输入和产物 | 与本地 outbox/worker 路径分开维护 |

数据库 schema 的历史版本是持久化契约。不要通过删除旧迁移来清理代码；新增迁移并测试从旧库升级。

## 前端模块

| 路径 | 职责 | 修改时关注 |
| --- | --- | --- |
| `web/src/workspace/` | 工作区状态、资源树和页面组合 | 通过 `WorkspaceClient` 接入数据；纯树操作留在 `resourceTree.ts` |
| `web/src/storyboards/`、`assets/`、`preview/` | 片段、共享资产、媒体查看 | 只经模块 client 或工作区上下文通信 |
| `web/src/chat/`、`composer/` | 会话、活动时间线、输入引用 | 运行时协议与工作区对象引用保持分离 |
| `web/src/proposals/`、`generation/` | 提案审阅与生成选项 | 正式内容和任务状态以服务端响应为准 |
| `web/src/productApi/generated.ts` | 由 OpenAPI 生成的产品类型 | 不手工编辑，运行 `pnpm contract:generate` |
| `web/src/workspace/fixtureWorkspaceData.ts` | 确定性工作区演示数据 | 只生成快照，不执行网络请求或改变客户端状态 |
| `web/src/workspace/fixtureWorkspaceClient.ts` | 开发 fixture 与生产浏览器工作区的 `WorkspaceClient` 适配 | 生产模式加载云端快照；开发模式叠加本地产品 API |
| `web/src/workspace/cloudWorkspaceSync.ts`、`browserWorkspaceStorage.ts`、`browserMediaFiles.ts` | 云端修订同步、浏览器快照与 IndexedDB 原始媒体 | 同步失败与冲突可见；浏览器本地文件不能当作跨设备媒体存储 |
| `web/src/storyboards/browserStoryboardClient.ts` | 生产浏览器工作区的片段操作 | 更新快照后交给同步层，不调用本地 SQLite 片段路由 |

`App.tsx` 负责顶层组合。当前前端以 Vite 的 `PROD` 标志选择云端浏览器存储与 `/api/turn`，开发构建使用本地服务；不能把开发服务器的 fixture 行为当作部署后的持久化行为。前端不复制服务端的提案确认或生成任务状态机规则。

## 功能模块改动入口

| 功能 | 前端入口 | 服务端入口 | 契约与回归 |
| --- | --- | --- | --- |
| 项目、片段与脚本 | `workspace/`、`storyboards/` | `product/api/storyboards.rs` → `application/storyboards.rs` | `product-api.md` 第 3 节；`storyboards_tests.rs` |
| 资源树与对象媒体 | `navigator/`、`workspace/workspaceNodeClient.ts`、`preview/` | `product/api/workspace_nodes.rs`、`workspace_media.rs` → 对应应用服务 | OpenAPI 的 `workspace-nodes` 与媒体路径；`workspace_nodes_tests.rs`、`object-media-workspace.spec.ts` |
| 共享资产与引用 | `assets/` | `product/api/assets/` → `application/assets.rs` | `product-api.md` 第 4 节；资产 HTTP 测试 |
| 会话与引用 | `chat/`、`composer/` | `api.rs`、`product/api/workspace_threads.rs` | `runtime-api.md` 与线程绑定 OpenAPI；`conversation-topia.spec.ts` |
| AI 提案 | `proposals/` | `product/tools/` → `application/proposals.rs` → `api/proposals.rs` | `product-api.md` 第 6、7 节；提案测试 |
| 图片与视频生成 | `generation/`、`preview/` | `product/application/generation/`、`infrastructure/volcengine_generation.rs` | `volcengine-generation.md`；生成任务与浏览器测试 |
| 云端工作区与提案 | `workspace/cloudWorkspaceSync.ts`、`proposals/proposalClient.ts`、`cloudApi.ts` | `cloud_workspace/api.rs`、`tools.rs` | `runtime-api.md` 云端接口；TOS 版本冲突与作用域测试 |

资产库组件目前可单独复用，接入工作区时应通过 `AssetWorkspaceClient`，不要让资源树直接依赖资产 UI 的内部状态。

## 关键流程与验证

1. **编辑内容**：本地产品 API 带 `expectedRevision` 提交；云端浏览器先更新本地快照，再带 `X-Videoflow-Revision` 条件写入 TOS。版本冲突要求重载或人工处理，不自动覆盖。
2. **AI 提案**：Runtime 工具创建提案，用户审阅后调用确认接口，服务端原子地应用或返回冲突。
3. **媒体生成**：应用服务创建任务，基础设施调用供应商并归档结果；工作区按任务状态刷新预览。
4. **资源树**：前端树运算负责展示。本地模式由产品 API 持久化节点；云端模式随整个工作区快照保存，页面显示同步失败。
5. **云端会话**：当前浏览器保存线程和消息历史；提交 `/api/turn` 前冲刷待同步快照，附工作区密钥及项目/片段 ID。服务端从 TOS 文档校验作用域并注入只读上下文，工具写入后浏览器重读快照。

验证入口：`cargo test --locked`、`pnpm build`、各 `pnpm test:*` 脚本；浏览器验收矩阵见 [`web/e2e/README.md`](../web/e2e/README.md)。新增模块应在此文档说明职责与允许的依赖，不必为目录结构创建空占位文件。

## 文件规模观察

当前没有超过 1000 行的手写源文件。`web/src/styles.css` 已接近此线，仍聚合工作区布局、资源树和画布样式；后续修改这些区域时应按组件归属迁入模块样式，并做视觉验收。`cloud_workspace/tools.rs` 同时含工具注册、资源投影和写入规则，新增云端用例前应抽出有明确职责的模块，并检查与本地产品规则的一致性。`WorkspaceProvider.tsx` 新增长流程优先放进单一职责的 hook 或 client。生成类型、锁文件和迁移文件按各自工具或持久化约束维护。
