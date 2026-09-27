# Wave 3 Agent D 验收矩阵

统一执行：

```bash
pnpm test:acceptance
```

通过 `pnpm test:e2e` 运行时，每个 spec 都使用独立的 fixture API、Vite 端口和临时数据库。直接运行 Playwright 时默认使用 `8789` 和 `5174`，也可用 `PLAYLETFLOW_E2E_API_PORT` 与 `PLAYLETFLOW_E2E_WEB_PORT` 覆盖。
它不会复用本地体验所使用的真实 runtime（默认 `8788`）或开发页面（默认 `5173`）。

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
