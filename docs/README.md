# PlayletFlow 文档索引

从需求到实现，推荐按以下顺序阅读：

1. [产品需求](product-requirements.md)：术语、用户流程、状态规则与验收标准。
2. [当前架构与模块边界](architecture.md)：代码归属、依赖方向和关键流程。
3. [产品 API 语义](product-api.md)与 [OpenAPI 3.1 契约](openapi.json)：`/api/v1` 产品对象、请求、响应、错误与并发规则。
4. [运行时 API](runtime-api.md)：会话、历史事件、SSE 和 Runtime 接口。
5. [生成接入](volcengine-generation.md)：图片/视频生成、存储、配置及失败处理。
6. [UI 设计规范](ui-design-system.md)：视觉变量、组件与交互要求。
7. [历史模块与多 Agent 实施计划](modules-and-agent-plan.md)：第一阶段的设计与任务划分；当前实现以架构文档和代码为准。

团队提交流程、编码约定、接口同步表及检查命令见 [贡献指南](../CONTRIBUTING.md)。浏览器验收场景见 [e2e/README.md](../web/e2e/README.md)。

## 接口契约的维护

产品 API 的机器可读来源是 `docs/openapi.json`。修改接口时同步更新语义文档和服务端 HTTP 测试，再运行：

```bash
cd web
pnpm contract:generate
pnpm contract:check
pnpm typecheck
```

生成文件 `web/src/productApi/generated.ts` 不手工修改。运行时会话与 SSE 接口由 `runtime-api.md` 描述，不混入产品 OpenAPI。接口兼容规则见 [产品 API 文档第 10 节](product-api.md#10-兼容与演进规则)。
