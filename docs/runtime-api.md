# 运行时与云端工作区 API

本文区分本地 Runtime 会话接口与部署时的轻量云适配器。浏览器不导入 `opentopia-core`，通过 HTTP/SSE 使用运行时；产品对象接口见 [产品 API](product-api.md)。

本地 `ConversationService` 接收 `ModelProvider` 与 `ToolRegistry`，从服务端会话绑定选择项目上下文；云端 `/api/turn` 则从 TOS 工作区快照校验片段作用域。两条路径都把模型输出当作不可信输入。

## 本地会话接口

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| GET | `/health` | 健康状态、`mode=fixture|live` 和不含密钥的 `model` 标识；云端另有 `workspaceTools` 数量。 |
| GET | `/api/threads` | 列出会话。 |
| POST | `/api/threads` | 创建会话；请求体可含 `{ "title": "..." }`。 |
| POST | `/api/threads/:id/title` | 按用户首条输入生成标题；带 `prompt` 与 `expectedTitle`。 |
| GET | `/api/threads/:id/messages?limit=61` | 读取最近消息；用 `beforeCreatedAt` 与 `beforeId` 向前翻页。 |
| POST | `/api/threads/:id/messages` | 开始一轮对话；前端发送结构化 `contentParts`（文本与资产引用），返回 `202` 和 `{ message, turnId }`。 |
| POST | `/api/threads/:id/turn/cancel` | 在运行时安全点取消当前轮次；可选请求体 `{ "turnId": "..." }`。 |
| GET | `/api/threads/:id/events?limit=250` | 读取精简事件；`since` 追赶新事件，`before` 向前翻页。 |
| GET | `/api/threads/:id/events/stream?since=N` | SSE；事件有持久 `seq`，可按 `since` 或 `Last-Event-ID` 重放。 |
| GET | `/api/threads/:id/events/:eventId/tool-result` | 仅在展开时读取完整工具结果。 |

消息使用 OpenTopia 的 `Message` JSON 形状；事件是 `{ id, threadId, turnId, seq, createdAt, payload }`，其中 `payload.type` 使用 snake_case。前端处理轮次生命周期、模型与供应商阶段、文本/推理增量、工具活动、用量、取消、完成和错误。供应商请求及响应正文不会持久化或流向浏览器，只保留状态 UI 所需元数据。

本地服务先提交事件再广播。历史读取有分页上限；会话页只携工具结果摘要，展开时从详情接口读取完整结果。浏览器批量处理流事件并按需加载旧历史。下一轮模型输入从规范事件重建原始工具调用 ID 和完整结果，不使用展示摘要。

## 云端工作区与会话

`VIDEOFLOW_CLOUD=1` 时，容器启动需要私有 TOS 配置。浏览器持有随机 UUID v4 工作区密钥，并在下列请求中发送 `X-Videoflow-Workspace-Key`。密钥能访问对应工作区，当前尚无用户账户、成员权限或密钥恢复流程；不要把它写入 URL、日志或公开文档。

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| `GET` | `/api/cloud-workspace` | 返回快照 JSON；`X-Videoflow-Revision` 响应头给出当前 TOS 修订号；未初始化返回 `404`。 |
| `PUT` | `/api/cloud-workspace` | 保存快照。首次创建带 `X-Videoflow-Create: 1`，后续写入带上次读取的 `X-Videoflow-Revision`；成功返回新修订号。 |
| `POST` | `/api/turn` | 发送云端一轮对话。请求包含 `threadId`、`projectId`、`storyboardId`、`message`、最近 `messages` 与 `events`，并带工作区密钥。 |

工作区 PUT 最大 2 MB；缺少写入前提返回 `428`，存储修订冲突返回 `412`，限流返回 `429`。服务端以 TOS 条件写入避免两个浏览器或 AI 工具静默覆盖。浏览器保存待同步标记并在发送对话前冲刷快照；同步失败会在页面显示错误，版本冲突需要先备份并人工处理本地草稿。浏览器本地上传文件位于 IndexedDB，快照中的 `browser-media:` 引用本身不能让其他设备取得原文件。

云端 `POST /api/turn` 可使用 `Accept: text/event-stream`。它先发送 `started`，随后是与本地会话同名的 `AgentEvent` 帧，最后发送 `result` 快照。服务端先从工作区密钥读取 TOS 快照，再校验请求中的项目和片段存在，构建可信上下文并注册七个作用域工具。工具写入后，浏览器重读工作区。云端线程绑定和对话历史当前由浏览器本地存储维护；`/api/threads` 的 SQLite 历史接口不用于这条路径。

云端还实现了产品提案接口的一个子集：列表、详情、确认和取消沿用 `/api/v1/projects/.../proposals` 路径与工作区密钥。提案保存在同一 TOS 文档中。媒体提案确认可在请求中附 `inputs` 图片数据供云端生成服务保存；云端以 TOS 修订重试处理并发，与本地 SQLite 单事务实现不同。完整路径和字段语义见[产品 API 第 6 节](product-api.md#6-ai-会话绑定与提案接口)。

## 产品工作流接入

通过 `CompiledModelContext` 注入服务端选定的项目数据，通过 `ToolRegistry` 注册作用域工具。本地作用域来自持久化线程绑定；云端作用域来自工作区密钥可读的快照与请求选中的片段，不来自模型工具参数。当前云端密钥不是用户身份验证。产品路由和提示词不写入 `server/src/runtime.rs`。

本地与云端适配器均注册七个片段工具：`create_workspace_object`、`save_workspace_object_prompt`、`search_storyboard_assets`、`read_storyboard_asset`、`propose_text_patch`、`propose_image_prompt_change` 和 `propose_video_prompt_change`。基础 Runtime 注册表为空。任何工具 schema 都不接受模型提供的 `projectId` 或 `storyboardId`；三个提案工具记录轮次来源。

`create_workspace_object` 在当前片段的文件夹中创建图片/视频占位符并保存提示词，不排队生成。`save_workspace_object_prompt` 直接保存现有对象的提示词，不创建提案或生成任务。三个提案工具成功仅表示待确认提案已保存；正式脚本或“确认后生成”的媒体改动仍经用户确认接口应用。
云端工具由 `cloud_workspace/tools.rs` 对 TOS 快照执行同名操作；本地工具由 `product/tools/` 经应用服务与 SQLite 执行。新增工具或改变结果格式时必须同时检查两条路径和前端渲染。
