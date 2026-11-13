# 测试矩阵（TEST-MATRIX）

> 复刻参考产品 `docs/TEST-MATRIX.md` 的双栏结构：**自动化检查 ≠ 人工验收**。
> CI 全绿不代表 GUI/真机验收通过。
> 本文件是指导，不是权限：验收结论需如实记录，不以“没有报错”代替人工验收。

## 1. 分层矩阵

| 层 | 自动化检查 | 仍需人工 |
|---|---|---|
| 会话解码 | `test/session-reader.test.mjs`（多帧 zstd / 明文 / 尾部 / 损坏行 / 有界发现） | 真实 DSH 升级后的新格式（v5）回归 |
| 领域算法 | `test/algorithms.test.mjs`（定价、日界、配速、计划、预测、舒适度） | 预测是否“符合直觉”（产品判断） |
| 采集编排 | `test/integration.test.mjs`（聚合、未知模型、buildStatus） | 超大会话（>1GB）下的内存观测 |
| HTTP API v1 | `test/integration.test.mjs`（status/config/comfort/receipt/rescan/404） | 浏览器兼容（Safari/Firefox） |
| HTTP API v2 | `test/v2.test.mjs`（range/tasks/projects/subagents/insights/calendar/notifications/backup/restore/riskmap）+ `test/e2e/smoke.node.mjs --strict` 契约断言 | 真实数据下的字段完整性与边界日期 |
| 团队同步 | `test/sync.test.mjs` + `test/sync-wiring.test.mjs`（快照脱敏、单调守卫、令牌、设备上限、撤销、server 接线） | 自建 Worker/D1 部署、两台真实设备互通、撤销 ≠ 删除 |
| DSH 插件 | `test/integration.test.mjs`（薄封装契约 + `/dsh-cockpit` 挂载 + BASE 注入） | 真实 DSH 启动 + 访问 + 卸载无残留 |
| Web UI v1 | 静态契约检查（DOM id 交叉引用、无硬编码 `/api/`、`__COCKPIT_BASE__`）；headless Chrome 渲染截图（`docs/dashboard.png`） | 双环动效、小票剪贴板、断点布局、键盘可达、hover tooltip |
| Web UI v2 | `test/e2e/cockpit.spec.ts`（Playwright：首屏/范围切换/任务搜索排序/小票/设置保存）+ `scripts/lint.mjs` 的 HTML 资源/重复 id 检查 | 主题/字号/密度/i18n 视觉、风险热力图 tooltip、日历下钻模态、通知授权降级 |
| 质量门禁 | `node scripts/lint.mjs`（语法/禁用词/行宽/JSON/YAML/HTML）、`node scripts/coverage.mjs`、`npm run audit:public` | 门禁阈值本身是否合理（产品/维护者判断） |
| CI | `.github/workflows/ci.yml`：3 OS × Node 22/24，Linux 额外 UTC / Asia/Shanghai / America/Los_Angeles | Runner 与真实桌面环境差异（DPI、输入法、透明窗口） |
| 发布 | `node --test "test/*.test.mjs"` + `lint` + `coverage` + `doctor` + `audit:public` | 真机首扫性能、真实账单对照 |

## 2. v2 能力矩阵（自动化 vs 人工）

| 能力 | 自动化检查 | 仍需人工 |
|---|---|---|
| 范围切换（周期/今日/7d/30d/90d/all/自定义） | `cockpit.spec.ts`：点击 30d → 请求带 `range=30d`、`aria-pressed` 切换、刷新后保持；`smoke.node.mjs` 断言 status/history 范围回显 | 自定义日期边界（04:00 换日）、URL hash 分享/回退、区间空数据 |
| 任务表 | E2E：搜索 `Alpha` 行数下降且命中、点费用列触发 `sort=cost`/aria-sort/顺序变化；`v2.test.mjs` 任务归因与分页 | 展开行明细、占比条、标题打码、超长任务名换行 |
| 项目表 | `v2.test.mjs` + smoke `GET /api/projects` 载荷 | Tab 切换、列对齐、空项目/单项目 |
| 子代理树 | `v2.test.mjs` 子代理树聚合 + smoke `GET /api/subagents` | 折叠交互、父子 token 占比、孤儿会话展示 |
| 洞察 | `v2.test.mjs` 洞察生成 + smoke `GET /api/insights` | severity 配色、action 跳转（open-tasks/settings） |
| 通知 | `v2.test.mjs` 阈值/未读 + smoke `GET /api/notifications` | 系统通知授权/拒绝降级、全部已读交互、断网重连 |
| 备份 / 恢复 | `v2.test.mjs` 备份 schema/恢复校验 + smoke `GET /api/backup`；CLI `backup`/`restore --dry-run` | 真实备份 → 恢复 → 重启后数据一致；损坏/跨版本备份 400 提示 |
| 日历下钻 | `v2.test.mjs` 日历聚合 + smoke `GET /api/calendar` | 月份切换、点日模态、空日期与跨月边界 |
| 小票构建器 | E2E：点击生成 → `/api/receipt` 200 且 `lines/totalTokens/generatedAt` 字段；`v2.test.mjs` 选择与合计 | 2× PNG 视觉/中文字体、下载与剪贴板降级、长标题截断 |
| 风险热力图 | smoke 断言 `status.riskMap`；`v2.test.mjs` 矩阵计算 | canvas 色块/tooltip/坐标轴可读性、当前位置点 |
| 舒适度扩展 | `algorithms.test.mjs`（拟合/分箱）+ `v2.test.mjs` | 分箱柱状图、历史日历、样本不足空态 |
| 设置 v2 | E2E：改 Token 预算 → `POST /api/config` 200 → 刷新后保持；`v2.test.mjs` 分组合并保存 | 主题 dark/light/auto、字号/密度、i18n 中英切换、滑块与校验错误 |
| 同步（团队共享） | `sync.test.mjs`（脱敏快照/单调/令牌/上限/撤销/CORS/限流 fail-closed）、`sync-wiring.test.mjs`（server 接线、push 不含会话 id/工作区） | 自建 Worker 部署、真机双设备、管理员可读的明文边界披露、撤销流程 |
| i18n / 主题 | 静态检查 `data-i18n` 键存在（人工抽查）+ E2E 仅覆盖 zh 默认 | en 全量文案、RTL、`prefers-color-scheme`、reduced-motion |

## 3. 自动化基线（本机，2026-11-03，v2 并行开发中）

> 数字随并行任务变化，以实际命令输出为准；下表为本次工程能力补齐后的实测值。

| 项 | 结果 | 门槛 |
|---|---|---|
| `node --test "test/*.test.mjs"` | 80 测试 / 79 通过 / 1 跳过（真实数据冒烟默认 SKIP） | 全绿 |
| `node scripts/lint.mjs` | 通过：0 错误、60 告警（冻结文件既有超长行，仅告警） | exit 0 |
| `node --check` 覆盖 | `src/`、`scripts/`、`web/`（含 `web/lib/`）、`test/` 根目录、`dsh-plugin/` 共 40 个 `.mjs/.js` | 0 语法错误 |
| `node scripts/coverage.mjs` | `src/core/**` 行覆盖 **89.90%**（2457/2733 行，21 文件）；全部文件 90.72% | ≥70% |
| `npx playwright test` | **5/5 通过**（Chromium 156.0.8078.4；端口 7811；隔离临时 `DSH_HOME`） | 5/5 |
| `node test/e2e/smoke.node.mjs --strict` | 26 通过 / 0 告警 / 0 失败（页面 DOM id + v1/v2 共 10 个 API） | 0 失败 |
| `npm run audit:public` | 通过（0 命中） | 0 命中 |
| CI 矩阵 | 3 OS × Node 22/24；Linux 额外 3 时区（UTC / Asia/Shanghai / America/Los_Angeles） | 配置已落地，待远端首跑 |
| `/api/status` 契约字段 | v2 契约字段（range/quota/plan/riskMap/notifications/insights/comfort/health…）由 smoke 断言存在 | 0 缺失 |
| Web 静态契约 | `web/index.html` 181 个 DOM id / 0 重复；本地资源引用 2 个全部存在 | 0 缺失 |
| 真实会话扫描（v1 基线，v2 未复测） | 124 会话 / 16,224 usage / 0 错误；首次全量 5.3s、缓存 0.13s、status 47ms | errors=0 |
| `doctor` | 通过 | exit 0 |

## 4. 测试数据规则

- 仓库只允许**合成 fixture**（`test/helpers.mjs`：伪造 id/title/usage；`test/e2e/seed.mjs`：10 个跨 45 天的合成会话）；
- E2E/冒烟的 `DSH_HOME`、`DSH_COCKPIT_HOME` 必须指向系统临时目录（`<tmp>/dsh-cockpit-e2e/`），绝不写真实 `~/.dsh`；
- 真实会话数据只在本地临时目录使用，`.gitignore` 排除 `test/fixtures/real/`；
- 测试输出不得打印真实标题/路径；E2E 产物写入 `.cockpit-e2e/`（已被 `.gitignore` 的 `.cockpit-*` 规则覆盖）。

## 5. 回归触发条件

| 变更 | 必须重跑 |
|---|---|
| 改 `src/core/session-reader.mjs` | session-reader + integration + 真机 `scan --json` |
| 改任一核心算法模块 | 对应测试 + `plan`/`status` 数值抽查 + coverage（core ≥70%） |
| 改 `src/server.mjs` / v2 API | integration + v2 + sync-wiring + `smoke.node.mjs --strict` + 手工打开页面 |
| 改 `web/`（含 `web/lib/`） | `node scripts/lint.mjs` + `npx playwright test` + 手工：主题/断点/键盘/小票 |
| 改 `src/sync/` 或 `cloud/` | `test/sync*.test.mjs` + 两台设备/Worker 手工冒烟 |
| 改配置 schema / 备份格式 | 迁移测试 + `doctor` + `backup`/`restore --dry-run` |
| 升级 DSH | 全量测试 + `scan --json` + 插件安装冒烟 |
| 改 `scripts/` / `.github/` / `skills/` | `node scripts/lint.mjs` + 改动的脚本本身 + `test/e2e/smoke.node.mjs` |

## 6. 一键门禁

```bash
node --test "test/*.test.mjs"   # 单元/集成（不含 test/e2e）
node scripts/lint.mjs           # 零依赖 lint
node scripts/coverage.mjs       # src/core 行覆盖 ≥70%
npm run audit:public            # 发布前防泄漏
node test/e2e/smoke.node.mjs    # 纯 Node E2E 冒烟（无浏览器）
npx playwright test             # 5 条主路径（需 @playwright/test + Chromium）
```

E2E 依赖需 Lead 统一写入 `package.json`（`@playwright/test` devDependency）；未安装时以 `smoke.node.mjs` 作为可执行替代。
