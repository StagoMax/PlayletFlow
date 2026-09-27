# 协作与贡献指南

本仓库以可审阅的小步修改维护产品流程。提交前先阅读 [当前模块边界](docs/architecture.md)、[产品需求](docs/product-requirements.md)和相关接口文档；历史实施计划在 [modules-and-agent-plan.md](docs/modules-and-agent-plan.md)，不作为当前代码结构的唯一依据。

## 开发流程

1. 在 Issue 或 PR 中写明问题、复现方式、受影响模块和预期行为。修复前先确认根因与模块归属。
2. 每个 PR 聚焦一个可验证目标；重构与功能变更尽量分开。保留既有行为时，用现有测试或新增针对边界的测试证明兼容性。
3. 修改模块公开接口时，同步更新调用方、契约、语义文档和测试。不要从 UI、HTTP 路由或 AI 工具直接绕过应用服务写数据库。
4. PR 描述写清变更原因、主要修改、验证命令及结果、兼容性影响和后续事项。请另一位成员审阅跨模块边界、数据迁移和外部 API 变更。
5. 审阅意见解决后再合并；避免在未通过检查时仅以本地运行正常作为合并依据。

## 代码约定

- Rust：使用 `cargo fmt`；领域、应用、基础设施与 API 的依赖方向见架构文档。错误使用现有 `ProductError` 等边界类型，持久化写入保持事务、修订检查和幂等语义。
- TypeScript：保持 `strict`、未使用变量和未使用参数检查通过；从 `docs/openapi.json` 生成产品 API 类型，不手改 `web/src/productApi/generated.ts`。
- 组件负责展示和交互；可复用的树操作、状态转换、网络调用放在对应模块的函数、hook 或 client 中。避免跨模块读取内部状态。
- 文件只承担一个主要职责。超过约 500 行时审视可提取的职责；手写代码超过 1000 行需要在 PR 中说明。不要为了行数拆散紧密相关的逻辑。
- 删除代码前确认引用、对外契约、持久化兼容和历史数据读取需求。旧数据迁移及兼容路径需要有明确退出条件，不能按“看起来没调用”直接删除。

## 接口与文档同步

| 修改范围 | 同步内容 |
| --- | --- |
| `/api/v1` 产品接口 | `docs/openapi.json`、`docs/product-api.md`、生成类型、服务端 HTTP 测试 |
| `/api/threads`、SSE、运行时事件 | `docs/runtime-api.md`、相关前后端类型与测试 |
| 模块职责或依赖 | `docs/architecture.md`；必要时更新本指南 |
| 用户可见流程 | `docs/product-requirements.md`、相关验收用例 |
| 生成供应商或配置 | `docs/volcengine-generation.md`、`.env.example` |

兼容新增字段可以沿用现有版本；删除字段、改变字段含义或收紧枚举时，先提出版本与迁移方案。数据库迁移须包含升级测试，必要时提供回滚说明。密钥只放服务端环境变量，不提交到仓库。

## 本地检查

在仓库根目录执行：

```bash
cargo fmt --manifest-path server/Cargo.toml --all -- --check
cargo clippy --manifest-path server/Cargo.toml --all-targets --locked -- -D warnings
cargo test --manifest-path server/Cargo.toml --locked
cd web
pnpm install --frozen-lockfile
pnpm build
pnpm test:assets-proposals
pnpm test:preview
pnpm test:conversation-activity
```

浏览器行为或核心流程发生变化时，安装 Chromium 后运行 `pnpm test:e2e`。用例与产品验收的对应关系见 [e2e/README.md](web/e2e/README.md)。PR 的检查列表也保存在 [模板](.github/PULL_REQUEST_TEMPLATE.md)。
