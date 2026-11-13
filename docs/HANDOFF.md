# 交接说明（HANDOFF）

> 最后更新：2026-11-04 00:05（Asia/Hong_Kong）
> 状态：**v0.2.0 全量技术移植完成**（PARITY P0/P1/P2 已落地），真实数据验收与 E2E 全绿。

---

## 1. 当前进度

| 阶段 | 状态 | 证据 |
|---|---|---|
| P1 参考产品研究 | ✅ | `../codex-cockpit-research/`（SHA-1 校验 + 4 报告 + 终稿） |
| P2 DSH 侦察 | ✅ | 会话格式 / usage 语义 / Cordis 插件 |
| P3 PRD v0.2 | ✅ | `docs/PRD.md`（17 章 + 依据溯源） |
| M1 核心引擎 | ✅ | `src/core/*`（含 range/aggregate/insights/riskmap/notify/calendar/backup） |
| M2 仪表盘 v2 | ✅ | `web/` 3,640 行（app 1617 + html 387 + css 798 + lib 974）；真实数据渲染截图 `docs/dashboard-v2.png`；E2E 5/5 |
| M3 集成 | ✅ | CLI 19 命令 / API v2（23 路由）/ DSH 插件 / 同步 API |
| M4 硬化 | ✅ | 80 测试、E2E 5、lint 0 错、覆盖率 89.9%、CI 矩阵、Skills、文档 14 篇 |
| P2 团队同步 | ✅ 默认关闭 | `cloud/usage-sync-worker` + `src/sync/client.mjs` + 36 测试 + `docs/SYNC.md` |

## 2. 验收基线（2026-11-04 本机）

| 项 | 结果 |
|---|---|
| 测试 | **80 tests / 79 pass / 1 skip** |
| E2E | **5/5**（首屏/范围/任务表/小票/设置） |
| lint | 0 错误（60 条冻结文件行宽告警） |
| 覆盖率 | src/core **89.90%**（阈值 70%） |
| audit:public / doctor | 通过 / 通过 |
| 真实数据 | 124 会话 / 16,287 usage / 0 错误；7 天 4.49 亿 token / ¥107；31 个任务 |
| Web 渲染 | 1440×2200 真实数据渲染成功（`docs/dashboard-v2.png`） |

## 3. 下一步（P1 增量，非阻塞）

1. `insights.mjs` 覆盖率 66% → 补分支用例到 ≥80%。
2. 并发扫描（worker_threads）——会话量增长后再做。
3. 团队同步 Web UI 深度（当前设置抽屉只读展示，push/pull 走 CLI/API）。
4. i18n 完整性校验（key 覆盖率测试）。

## 4. 关键事实

- 会话：`~/.dsh/sessions/<slug>/<session-dir>/session.v{3,4}.jsonl.zstd`，多帧 zstd + 尾部明文。
- usage：`assistant/message.data.usage` 四桶；`total = input + cacheRead + cacheWrite + output`。
- 上下文：`request/context.contextWindow`；压力 = input+cacheRead+cacheWrite。
- 压缩：`compaction/prune.shadowedTokenCount`（重置事件）。
- 日界：Asia/Shanghai 04:00；`range` 只影响统计范围，额度/配速/计划始终按预算周期。
- 插件：`name + inject:[webServer] + apply(ctx)`，挂 `/dsh-cockpit`。
- 同步：令牌只走 `DSH_COCKPIT_SYNC_TOKEN`；默认关闭；非 E2E 加密。

## 5. 风险

| 风险 | 状态 | 缓解 |
|---|---|---|
| DSH 会话格式漂移 | 监控 | 适配层隔离 + 显式警告 |
| 插件 API rc 变更 | 监控 | 插件 ≤60 行，只依赖 webServer |
| 成本非账单 / 预测启发式 | 已知 | 文档三处声明 + 界面标注 |
| 同步合规（非 E2E） | 已知 | 默认关闭 + 显式披露 + 仅聚合 |
| 默认预算偏低 | 已知 | `isDefaultBudget` 提示 + 设置抽屉 |
