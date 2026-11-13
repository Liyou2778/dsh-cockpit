---
name: dsh-cockpit
description: 安装、解释与排障 DSH 驾驶舱（DeepSeek Harness 本地只读用量仪表盘：token / 成本 / 上下文压力 / 压缩预测 / 任务归因 / 小票 / 团队同步）。当用户询问本机 DSH 用量与花费、想启动或安装驾驶舱、阅读它的报告，或需要定位驾驶舱的数据/隐私/插件/同步问题时使用。不用于安装 DeepSeek Harness 本身、修改 DSH 的模型/鉴权设置，也不用于任何需要读取对话正文或凭据的任务。
---

# DSH 驾驶舱安装与排障

帮助用户把驾驶舱装好、用起来，或定位一个具体问题。默认用用户的语言解释结论，少用内部术语。
本 Skill 是**指导，不是权限**：它不授予读取用户数据、修改 DSH 配置、发布仓库或改变可见性的任何权力。
涉及 `commit` / `push` / `tag` / `release` / 改安全设置时，必须维护者单独明确授权（见仓库 `AGENTS.md`）。

## 先选入口

| 用户要做什么 | 读取什么 |
| --- | --- |
| 问是什么、怎么用、数据/隐私/费用边界 | 仓库 `README.md`、`docs/USER-GUIDE.md`、`docs/PRIVACY.md` |
| 安装、启动、装成 DSH 插件、更新/卸载 | [安装与运行](references/install.md) |
| 打不开、空白页、数据为 0 或 —、插件 404、金额异常 | [按现象排障](references/troubleshooting.md) |
| 需要查代码或改源码 | 仓库 `AGENTS.md` → 按任务路由表进入具体模块与测试 |
| 发布/审计/测试基线 | `scripts/audit-public.mjs`、`docs/TEST-MATRIX.md`、`skills` 目录的验证命令 |

确认当前机器的操作系统与 Node 版本、驾驶舱版本/启动方式（独立端口还是 DSH 插件）、具体症状。
已有信息直接用；不要把一长串问题全抛给用户。先只读检查，用户明确要求修复时才实施修复。

## 红线（任何情况下不可越过）

- **只读 DSH**：绝不写入 `~/.dsh/**`，只允许读 `~/.dsh/sessions/**`；写入仅发生在 `~/.dsh-cockpit/`。
- **不读对话正文**：采集只取 usage 数字与元数据（模型、时间、工具名、会话标题）。不新增、不展示、不导出 message 内容。
- **不读取/不粘贴凭据**：不读取 `auth.json`、API Key、Cookie、keychain 内容；余额模式需要 `DEEPSEEK_API_KEY` 时由用户自己设置，Key 不落盘、不日志。
- **零遥测**：不添加任何上报端点。唯一允许的网络调用是用户显式开启的 DeepSeek 余额查询（以及用户自建的团队同步端点）。
- **不提交真实数据**：真实会话 id、路径、标题、金额、截图不进仓库/issue；回归用 `test/helpers.mjs` 的合成 fixture。
- **不把“修复”做成“清空”**：不默认删除 `~/.dsh-cockpit`、不重装、不关闭系统安全保护；必要改动先说明目标、影响与回退方式。

## 最小验证口令

```bash
node src/cli.mjs doctor                    # 环境自检
node src/cli.mjs status --json             # 驾驶舱状态（字段齐全）
node src/cli.mjs scan --json               # errors=0；sessions>0（可能需 --force）
npm test                                   # 单元/集成测试全绿
node scripts/lint.mjs                      # 零依赖 lint
node scripts/coverage.mjs                  # src/core 行覆盖 ≥70%
node test/e2e/smoke.node.mjs               # 无浏览器 E2E 冒烟（隔离临时 DSH_HOME）
```

## 排障底线

- 先确认版本、启动方式、统计范围（周期/今日/7d/30d/…）、采集时间与脱敏错误，再改配置；每次只验证一个假设。
- “金额是估算不是账单”：未知模型保留 token 但金额显示 `—`，**缺失 ≠ 0**；不要把 `—` 当故障，也不要补 0。
- 插件只是挂载 `/dsh-cockpit` 的同源子路径，不装插件也能独立端口使用；先区分“服务没起来”和“插件没挂上”。
- 不把 `scan --force`、删缓存、换 profile 当作默认修复；先看错误码（`CockpitError.code`）与降级行为。
- 涉及隐私/安全的问题（标题泄露、同步数据边界、通知权限）先解释影响与默认值，不替用户关闭保护或上传数据。
- 无法继续时，给出已检查项、证据（脱敏）与下一步建议，不用“没有报错”当作验收通过。

## 交付时说清楚

给出原因或仍待验证的假设、实际改动、实际验证结果，以及尚需用户操作的一步。
服务启动成功不等于数据正确；测试全绿不等于 GUI/真机验收通过（见 `docs/TEST-MATRIX.md` 双栏）。
不要承诺解决所有问题。

## 参考资料

- [安装与运行](references/install.md)
- [按现象排障](references/troubleshooting.md)
- 仓库入口：`AGENTS.md`；产品说明：`README.md`；测试矩阵：`docs/TEST-MATRIX.md`；API 契约：`docs/API-V2.md`
