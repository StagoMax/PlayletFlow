# 当前架构与模块边界

本文记录当前代码的职责和改动入口。产品范围见 [需求文档](product-requirements.md)；HTTP 语义见 [产品 API](product-api.md)和[运行时 API](runtime-api.md)；机器可读的产品接口以 [OpenAPI](openapi.json) 为准。

## 依赖方向

```text
浏览器组件 → 模块 client → HTTP API → 应用服务 → 领域规则
                                           ↓
                                    仓储/供应商端口
                                           ↑
                                 SQLite/媒体/模型适配器

AgentRuntime → 产品工具适配器 → 产品应用服务
```

产品领域不依赖 HTTP、SQLite、React 或模型供应商。路由负责解析与映射请求，应用服务负责用例、项目作用域、修订与事务边界，基础设施负责持久化和外部服务。AI 工具通过应用服务操作产品对象；脚本和提示词提案的确认规则由服务端执行。

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
| `web/src/workspace/fixtureWorkspaceClient.ts` | 演示/开发模式的 `WorkspaceClient` 适配 | 处理状态、持久化叠加与后端调用，不存放大块演示数据 |

`App.tsx` 负责顶层组合。前端不复制服务端的权限、提案确认或生成任务状态机规则。

## 功能模块改动入口

| 功能 | 前端入口 | 服务端入口 | 契约与回归 |
| --- | --- | --- | --- |
| 项目、片段与脚本 | `workspace/`、`storyboards/` | `product/api/storyboards.rs` → `application/storyboards.rs` | `product-api.md` 第 3 节；`storyboards_tests.rs` |
| 资源树与对象媒体 | `navigator/`、`workspace/workspaceNodeClient.ts`、`preview/` | `product/api/workspace_nodes.rs`、`workspace_media.rs` → 对应应用服务 | OpenAPI 的 `workspace-nodes` 与媒体路径；`workspace_nodes_tests.rs`、`object-media-workspace.spec.ts` |
| 共享资产与引用 | `assets/` | `product/api/assets/` → `application/assets.rs` | `product-api.md` 第 4 节；资产 HTTP 测试 |
| 会话与引用 | `chat/`、`composer/` | `api.rs`、`product/api/workspace_threads.rs` | `runtime-api.md` 与线程绑定 OpenAPI；`conversation-topia.spec.ts` |
| AI 提案 | `proposals/` | `product/tools/` → `application/proposals.rs` → `api/proposals.rs` | `product-api.md` 第 6、7 节；提案测试 |
| 图片与视频生成 | `generation/`、`preview/` | `product/application/generation/`、`infrastructure/volcengine_generation.rs` | `volcengine-generation.md`；生成任务与浏览器测试 |

资产库组件目前可单独复用，接入工作区时应通过 `AssetWorkspaceClient`，不要让资源树直接依赖资产 UI 的内部状态。

## 关键流程与验证

1. **编辑内容**：前端带 `expectedRevision` 提交；服务端拒绝过期修订，成功后更新工作区。
2. **AI 提案**：Runtime 工具创建提案，用户审阅后调用确认接口，服务端原子地应用或返回冲突。
3. **媒体生成**：应用服务创建任务，基础设施调用供应商并归档结果；工作区按任务状态刷新预览。
4. **资源树**：前端本地树运算负责展示，持久化节点由产品 API 维护，不能只改客户端树而假定保存成功。

验证入口：`cargo test --locked`、`pnpm build`、各 `pnpm test:*` 脚本；浏览器验收矩阵见 [`web/e2e/README.md`](../web/e2e/README.md)。新增模块应在此文档说明职责与允许的依赖，不必为目录结构创建空占位文件。

## 文件规模观察

当前没有超过 1000 行的手写源文件。`web/src/styles.css` 仍聚合了工作区布局、资源树和画布样式；后续修改这些区域时应按实际组件归属继续迁入模块样式，并保持导入顺序和视觉验收。`WorkspaceProvider.tsx` 负责组合状态与副作用，新增长流程优先放进有单一职责的 hook 或 client，避免继续扩大 Provider。生成类型、锁文件和迁移文件按各自工具或持久化约束维护，不按手写源码行数拆分。
