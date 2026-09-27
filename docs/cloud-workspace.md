# 轻量云工作区模块

本文描述 `VIDEOFLOW_CLOUD=1` 的工作区路径。它面向单浏览器或低并发原型，与本地 SQLite 产品服务并行存在；接口字段见[运行时 API](runtime-api.md#云端工作区与会话)，本地产品规则见[产品 API](product-api.md)。

## 模块与数据归属

| 位置 | 责任 |
| --- | --- |
| `server/src/cloud_workspace/mod.rs` | 以工作区密钥读写 TOS 文档，保留快照与提案，按修订条件写入。 |
| `server/src/cloud_workspace/api.rs` | `/api/cloud-workspace` 读写、云端提案列表/详情/处理、请求校验与错误映射。 |
| `server/src/cloud_workspace/tools.rs` | 从服务端快照构建片段上下文，注册七个工具并处理其读写。 |
| `server/src/cloud.rs` | `/api/turn` 校验工作区密钥及片段，注入上下文与工具，返回普通响应或 SSE。 |
| `web/src/workspace/cloudWorkspaceSync.ts` | 浏览器快照初始化、修订跟踪、延迟写入、冲刷与冲突提示。 |
| `web/src/workspace/browserWorkspaceStorage.ts` | `localStorage` 快照副本及本地媒体 URL 的存储形式。 |
| `web/src/workspace/browserMediaFiles.ts` | `IndexedDB` 中的浏览器上传原文件。 |
| `web/src/cloudApi.ts`、`web/src/proposals/proposalClient.ts` | 对话和提案提交前冲刷工作区，提交后重读远端快照。 |

私有 TOS 文档由浏览器生成的 UUID v4 工作区密钥定位。服务端对密钥做 SHA-256 后使用 `agent-workspaces/v1/{digest}.json` 作为对象键；文档包含 `snapshot` 与 `proposals` 两部分。普通浏览器快照保存会保留服务端提案数组。整个文档上限 2 MB。密钥保存在当前浏览器的 `localStorage`，目前相当于访问凭据，尚无账号、授权成员、共享或找回流程。

工作区结构由 `WorkspaceSnapshot` 表示：项目、片段目录、各片段工作区以及对象媒体信息。生产前端使用浏览器 `WorkspaceClient` 更新快照；本地开发构建使用 fixture 加产品 API。生产与开发的分支由 Vite `PROD` 标志决定，不是通过 URL 参数启用云端。

片段复制会为新片段重建资源树和片段私有媒体 ID；浏览器本地上传文件也复制到新媒体 ID 的 IndexedDB 记录。共享资产仍保持共享引用。删除片段会从快照移除其工作区和私有对象媒体；删除最后一个片段时界面补建空白片段。轻量云路径当前没有 30 天软删除恢复。

## 加载、保存和冲突

1. 页面先读取本地快照，云端初始化时带工作区密钥 `GET /api/cloud-workspace`。远端不存在则用本地快照首次创建；远端存在且本地无待同步改动时采用远端快照。
2. 普通编辑先保存到浏览器本地，并标记待同步；同步模块在约 300 ms 后发出 PUT。发送 AI 回合或确认媒体提案前会先冲刷待同步快照。
3. 首次 PUT 带 `X-Videoflow-Create: 1`，后续 PUT 带上次响应的 `X-Videoflow-Revision`。服务端以 TOS 的条件写入保护修订；成功返回新修订号。
4. 版本已变化时返回 `412`。若本地与云端都有不同修改，客户端保留本地草稿并提示先备份、人工处理，不自动合并或覆盖。同步失败在工作区顶部显示错误。
5. 云端工具或提案处理写入后，浏览器重新 GET 快照并更新页面状态。

服务端的 `CloudWorkspaceStore::mutate` 对单文档条件写入最多重试五次。媒体提案确认还会创建独立的生成任务记录；任务创建与工作区文档更新不是一笔数据库事务。修改这一流程时必须明确重试、重复调用和失败恢复语义。

## AI 与媒体边界

云端 `/api/turn` 请求包含 `threadId`、`projectId`、`storyboardId`、消息与最近历史，并附 `X-Videoflow-Workspace-Key`。服务端读取该密钥的文档，检查项目和片段，再把当前片段资源摘要放入可信上下文。工具 schema 不接受模型提供的项目或片段 ID。七个工具与本地模式同名，但云端直接操作 TOS JSON 文档；新增或改变工具时要核对两种实现。

`create_workspace_object` 与 `save_workspace_object_prompt` 直接保存当前片段对象，不启动生成。三个提案工具只创建待确认提案。云端工具目前没有本地 SQLite 工具调用记录的逐调用幂等保证，重复执行创建工具可能创建第二个对象。

浏览器上传原文件留在本机 IndexedDB；快照中的 `browser-media:` 引用不能在另一设备还原文件。云端生成的产物和参考输入由生成服务写入私有 TOS，预览使用短期签名地址。当前浏览器还保存线程绑定和对话历史，TOS 工作区文档不包含完整对话历史。

## 维护与验证

- 修改工作区结构时，核对浏览器 `WorkspaceSnapshot`、TOS 文档读取、AI 资源投影和旧快照加载；不要只更新一侧的类型。
- 修改提案或生成规则时，对照本地 `product/` 与云端 `cloud_workspace/`、`cloud_generation/`，并更新两份 API 文档。
- 服务端测试覆盖作用域资源、脚本修订、工作区密钥格式；前端 Playwright fixture 场景运行在开发模式，不能证明 TOS 同步可用。
- 云端发布前手工核验：首次创建与刷新、两标签页修订冲突、断网后的错误与本地草稿、片段作用域、提案确认后的快照刷新，以及另一设备缺失本地上传文件时的提示。

正式多人协作需要账户和权限、可恢复的工作区密钥/项目归属、原文件云端持久化、跨设备会话历史和跨任务一致性方案；当前轻量云适配器不承诺这些能力。
