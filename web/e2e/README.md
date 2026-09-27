# 浏览器与产品验收

从 `web/` 目录运行完整浏览器回归；若同时需要服务端契约测试，运行产品验收命令：

```bash
pnpm test:e2e
pnpm test:acceptance
```

通过 `pnpm test:e2e` 运行时，先构建一次 fixture 服务端，再为每个 spec 启动同一二进制和独立的 Vite 端口、临时数据库。直接运行 Playwright 时仍可由 `cargo run` 启动服务，默认使用 `8789` 和 `5174`，也可用 `PLAYLETFLOW_E2E_API_PORT` 与 `PLAYLETFLOW_E2E_WEB_PORT` 覆盖。
它不会复用本地体验所使用的真实 runtime（默认 `8788`）或开发页面（默认 `5173`）。
每个端口的截图、trace 和 HTML 报告分别写入 `.e2e/results/<webPort>/` 与 `.e2e/report/<webPort>/`，并行运行不会清空其他 spec 的失败现场。

六个产品验收场景均使用确定性 fixture，并按最能暴露真实回归的边界执行：

| 场景 | 自动化用例 |
| --- | --- |
| AC-01 资产引用复制不重复文件 | Rust HTTP 契约测试 `copies_references_without_duplicating_assets_and_replays_idempotently` |
| AC-02 下拉定位当前片段 | Playwright `AC-02：200 个片段时菜单打开即定位第 137 个片段` |
| AC-03 AI 不能直接修改脚本 | Rust API 测试 `product_entry_lists_applies_and_rejects_proposals` 与提案持久化测试 |
| AC-04 冲突阻止静默覆盖 | Rust 事务测试 `stale_target_marks_proposal_conflicted_without_overwriting_user_work` |
| AC-05 提示词确认只生成一次 | Rust 事务测试 `media_and_binding_apply_create_exactly_one_generation_job` |
| AC-06 正确比例预览 | Playwright `AC-06：9:16 媒体缩略图裁切，悬停与主预览完整显示` |

另有 `W2-D` 浏览器用例验证片段切换时创建独立会话、返回时恢复原线程绑定。测试专用服务端由 `--seed-demo-workspace` 写入 200 个固定片段，前端通过 `?fixture=acceptance` 固定以第 137 个片段为当前项。
