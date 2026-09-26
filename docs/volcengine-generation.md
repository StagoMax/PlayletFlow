# Seedream / Seedance 生成接入

本接入保持“AI 只提议、用户确认后才生成”的既有边界。AI 提案确认和用户直接修改提示词后生成，都会先固化正式提示词与生成规格、创建 `generation_jobs` 并写入 outbox；任何火山方舟网络请求都由事务外的生成 worker 执行。

## 调用链

1. 用户确认图片或视频提示词提案，或在媒体检查器中修改提示词并主动生成。
2. 数据库在同一事务中更新提示词，创建 `waitingForProvider` 任务并写入 `generation.requested`。任务会固化模型、输入素材模式和输出参数，重试不会偷偷切换模型。
3. `GenerationWorker` 领取事件，根据目标媒体类型路由：
   - 图片：调用 Seedream `POST /images/generations`。接口同步返回短期图片 URL。
   - 视频：调用 Seedance `POST /contents/generations/tasks`。接口返回异步任务 ID。
4. 图片立即转存；视频由 `GenerationMonitor` 调用 `GET /contents/generations/tasks/{id}` 轮询，成功后转存。
5. 转存成功后，在一个本地数据库事务中创建结果 `media_items`、关联资产引用（适用时）、把任务标记为 `succeeded` 并写出事件。

方舟图片和视频 URL 只有短期有效期，不能直接作为持久媒体地址保存。当前本地运行时将产物以流式方式下载到 `VIDEOFLOW_MEDIA_DIR`，并通过同源只读路由提供预览。正式云部署应实现同一个 `GeneratedMediaStore + MediaAccessProvider` 端口，把产物转存到 TOS 并返回短期签名 URL；不要依赖 Vercel 实例文件系统。

## 配置

在服务端进程环境中设置：

```dotenv
ARK_API_KEY=...
```

完整可选项见根目录 `.env.example`。未配置 `ARK_API_KEY` 时不启动生成 worker，已确认任务保持 `waitingForProvider`，以后配置密钥并重启即可继续处理。

2026-09-17 后创建的 ModelArk API Key 控制台会显示 `API Key ID` 和 `API Key Secret`。HTTP Bearer 鉴权使用 Secret；ID 只用于识别和管理密钥。仓库根目录的 `ApiKey*.txt` 已加入忽略规则，不要把 Secret 放入 `VITE_` 变量、浏览器 Local Storage、接口响应或 Git。

## 当前生成策略

- `GET /api/v1/generation-models` 返回服务端批准的模型和能力，前端不允许提交任意模型字符串。
- 默认图片模型为 Seedream 5.0 Pro，默认视频模型为 Seedance 2.5；用户可在确认提案或直接生成前改选模型。
- Seedream 支持纯提示词或多张参考图。默认单图、2K、关闭组图。
- Seedance 支持纯提示词、严格首/尾帧、参考关键帧三种模式。严格首尾帧自动使用 `adaptive` 画幅；参考关键帧按 `reference_image` 发送。
- 方舟规定严格首/尾帧模式与参考图模式互斥，应用层会在创建任务前校验，不能混发。
- 视频默认 `720p`、`16:9`、5 秒、无音频；模型、分辨率、画幅、时长和音频选择都会写入不可变任务快照。
- `mediaPrompt` 按目标媒体的 `kind` 选择图片或视频模型。
- `assetBindingPrompt` 生成分镜私有派生图片，并在成功事务中更新 `derived_media_id`。

输入快照只保存媒体 ID，不保存会过期的 URL。worker 提交任务前通过 `GenerationInputResolver` 取得对象存储的短期 HTTPS 签名地址。这样重试时可重新签名，同时不会接受用户提交的任意 URL，避免 SSRF 和跨项目素材引用。

## 纯 Web 面试部署（无需 ECS / PostgreSQL）

当前仓库另有一条轻量云路径：Vite 前端与 Rust 容器服务一起部署到 Vercel，私有 TOS 桶同时保存任务 JSON、首尾帧/参考关键帧和最终产物。它不使用实例文件系统，也不要求常驻 worker：

1. 浏览器只把用户选中的现有图片素材和生成选项发到同源 Rust API，任何云密钥都不会进入 `VITE_` 变量或响应。
2. API 把不可变请求和输入图写入 TOS，然后调用 Seedream 或 Seedance。任务状态在 `jobs/{jobId}.json`，最终产物在 `outputs/{jobId}/`。
3. Seedream 会在创建请求内完成并转存；Seedance 返回任务 ID。浏览器轮询同源任务接口，每次 GET 只推进一次方舟查询，所以不需要后台进程。
4. 预览使用一小时 TOS 签名 GET URL；桶保持私有，仅配置 GET/HEAD CORS。

云路径暴露与本地产品接口兼容的三个端点：

- `GET /api/v1/generation-models`
- `POST /api/v1/projects/{projectId}/storyboards/{storyboardId}/media/{mediaId}/generations`
- `GET /api/v1/projects/{projectId}/generation-jobs/{jobId}`

服务端需要 `ARK_API_KEY`、`TOS_ACCESS_KEY`、`TOS_SECRET_KEY`、`TOS_BUCKET`、`TOS_REGION` 与 `TOS_ENDPOINT`。可先设置这些环境变量并运行 `cargo run --manifest-path server/Cargo.toml -- --bootstrap-tos`，幂等创建私有桶并写入浏览器预览所需的 CORS。

这条模式适合面试演示和低并发 Web 产品原型。它用对象存储替代数据库，省掉服务器与 PostgreSQL，但不提供用户账户、跨设备项目状态、复杂查询，也没有数据库事务/队列级的并发领取保证。若进入正式多人生产环境，再把任务状态迁移到 PostgreSQL，并用队列或持久工作流驱动生成；TOS adapter 和前端接口可以继续复用。

## 可靠性说明

应用侧通过 outbox、领取状态和生成任务 ID 防止普通重放。火山方舟视频创建接口的公开契约没有声明幂等键；`X-Client-Request-Id` 只用于日志串联，不等同于幂等保证。因此进程若恰好在“方舟已创建任务、但本地尚未保存任务 ID”的窗口崩溃，重启后仍可能重复创建一次视频任务。生产环境应通过供应商回调/任务对账补偿或可幂等的中间任务服务进一步收窄该窗口，并设置方舟侧额度与告警。

## 官方接口

- 图片生成：<https://docs.volcengine.com/docs/ark/image-generation-api?lang=zh>
- 创建视频任务：<https://docs.volcengine.com/docs/ark/create-video-generation-task-api?lang=zh>
- 查询视频任务：<https://docs.volcengine.com/docs/ark/get-video-generation-task-api?lang=zh>
- Base URL 与鉴权：<https://docs.volcengine.com/docs/ark/base-url-and-authentication?lang=zh>
