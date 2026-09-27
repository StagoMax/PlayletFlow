# PlayletFlow 文档索引

从需求到实现，推荐按以下顺序阅读：

1. [产品需求](product-requirements.md)：术语、用户流程、状态规则与验收标准。
2. [当前架构与模块边界](architecture.md)：代码归属、依赖方向和关键流程。
   云端快照、TOS 修订同步和浏览器本地数据另见 [轻量云工作区模块](cloud-workspace.md)。
3. [产品 API 语义](product-api.md)与 [OpenAPI 3.1 契约](openapi.json)：本地 `/api/v1` 产品对象、请求、响应、错误与并发规则；产品文档另标注云端提案适配差异。
4. [运行时与云端工作区 API](runtime-api.md)：本地会话、历史事件、SSE，以及云端 `/api/turn` 和 `/api/cloud-workspace`。
5. [生成接入](volcengine-generation.md)：图片/视频生成、存储、配置及失败处理。
6. [UI 设计规范](ui-design-system.md)：视觉变量、组件与交互要求。
7. [历史模块与多 Agent 实施计划](modules-and-agent-plan.md)：第一阶段的实施记录，不能作为当前结构、功能状态或待办清单。

团队提交流程、编码约定、接口同步表及检查命令见 [贡献指南](../CONTRIBUTING.md)。浏览器验收场景见 [e2e/README.md](../web/e2e/README.md)。

## 接口契约的维护

本地产品 API 的机器可读来源是 `docs/openapi.json`。修改本地接口时同步更新语义文档和服务端 HTTP 测试，再运行：

```bash
cd web
pnpm contract:generate
pnpm contract:check
pnpm typecheck
```

生成文件 `web/src/productApi/generated.ts` 不手工修改。云端专用工作区和 Runtime 接口当前由 `runtime-api.md` 与路由测试描述，不要误认为它们已包含在产品 OpenAPI 中。同名产品路径在本地与云端分别由 `product/api/` 和 `cloud_workspace/` 实现；修改提案或工具语义时要核对两条路径。接口兼容规则见 [产品 API 文档第 10 节](product-api.md#10-兼容与演进规则)。
