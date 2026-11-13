# 安装与运行

> 前提：**Node.js ≥ 22.15**（`node:zlib` zstd 解码需要）。项目零运行时依赖，不需要 `npm install` 即可运行。
> 本文件是操作指导，不是权限：改动用户 DSH 目录、安全设置或发布仓库都需要用户/维护者明确授权。

## 0. 确认当前环境

```bash
node --version        # 需 ≥ 22.15
node src/cli.mjs doctor
```

`doctor` 会检查 Node 版本、`~/.dsh/sessions` 可读性、驾驶舱 home 可写性、端口与配置是否合法。
Windows 路径用 PowerShell 时可直接运行；macOS/Linux 同理。不要把 `~/.dsh` 的真实路径、会话标题贴进公开渠道。

## 1. 独立运行（推荐，不装插件）

```bash
# 终端看一眼（只读）
node src/cli.mjs status
node src/cli.mjs plan
node src/cli.mjs scan            # 首次或数据变化后

# 打开 Web 仪表盘：默认 http://127.0.0.1:7777/
node src/cli.mjs serve --open
node src/cli.mjs serve --port 7800   # 端口被占用时换一个
```

首次使用建议先 `scan`，再按实际用量设置预算（未设置时使用默认 2,000,000 tokens/日，`doctor` 与仪表盘会提示）：

```bash
node src/cli.mjs config --set budget.tokens=10000000
node src/cli.mjs config --set budget.mode=daily     # daily | weekly | monthly
node src/cli.mjs config                            # 查看全部配置
```

退出服务：前台终端 `Ctrl+C`。服务只监听 `127.0.0.1`，不对外暴露。

## 2. 安装为 DSH 插件（可选）

插件把仪表盘挂在 DSH Web GUI 同源子路径 `/dsh-cockpit`，不占独立端口。
先备份/检查：默认 **dry-run**，只打印步骤，不写文件。

```bash
# 步骤 1：预览
node src/cli.mjs install-plugin --profile web

# 步骤 2：确认后执行（会先备份 profile 的 cordis.patch.yml，再写入插件条目）
node src/cli.mjs install-plugin --profile web --apply
```

手工等价操作：

```bash
dsh plugin --profile web add "file:<绝对路径>/dsh-cockpit/dsh-plugin"
# 再在 ~/.dsh/profiles/web/cordis.patch.yml 追加：
#   - insert:
#       - id: dsh-cockpit
#         name: 'dsh-cockpit-plugin'
```

重启 DSH 后访问 `http://127.0.0.1:<gui端口>/dsh-cockpit`。
**这是对用户 DSH profile 的写入**：只在用户明确同意时执行 `--apply`；失败时不要反复重试或替换 profile 文件。
不装插件也完全可用（独立端口），不要默认替用户安装。

## 3. 数据与写入边界（安装时先说明）

| 路径 | 读写 | 内容 |
| --- | --- | --- |
| `~/.dsh/sessions/**/session.v*.jsonl(.zstd)` | **只读** | 采集 usage 数字与元数据 |
| `~/.dsh-cockpit/config.json` | 读写 | 预算、价格、界面、通知、同步开关 |
| `~/.dsh-cockpit/state.json` / 缓存 / `comfort.json` / `metrics.jsonl` | 读写 | 扫描状态、舒适度、本地事件日志 |

环境变量可整体改道（用于测试/多实例，**不要指向真实 DSH 目录做实验**）：

```bash
# PowerShell
$env:DSH_HOME="$env:TEMP\cockpit-demo\dsh-home"
$env:DSH_COCKPIT_HOME="$env:TEMP\cockpit-demo\cockpit-home"

# bash
export DSH_HOME=/tmp/cockpit-demo/dsh-home
export DSH_COCKPIT_HOME=/tmp/cockpit-demo/cockpit-home
```

没有会话数据时仪表盘应显示空态（`—` / 0 条），而不是报错或伪造数据。

## 4. 安装后的验收清单

```bash
node src/cli.mjs doctor
node src/cli.mjs status --json    # quota / pace / plan / forecast 字段齐全，health.errors=0
node src/cli.mjs scan --json      # sessionsScanned>0、errors=0
npm test                          # 30+ 测试全绿（真实数据冒烟默认 SKIP）
node scripts/lint.mjs
node scripts/coverage.mjs
node test/e2e/smoke.node.mjs      # 需要先能启动服务；使用隔离临时目录
```

浏览器验收：打开页面 → 双环/配速/计划/预测有数 → 切换范围 → 任务表搜索排序 → 生成小票 → 修改设置并刷新后保持。
自动化全绿不等于 GUI/真机验收通过，按 `docs/TEST-MATRIX.md` 的双栏执行。

浏览器 E2E（可选，需要 Playwright Chromium）：

```bash
npm i --no-save --no-package-lock @playwright/test
npx playwright install chromium
npx playwright test            # 端口 7811 + 隔离 DSH_HOME，见 playwright.config.ts
```

若 `@playwright/test` 未安装，`test/e2e/smoke.node.mjs` 是纯 Node 的可执行替代。

## 5. 更新与回退

- 零运行时依赖：更新 = 替换代码 checkout/发布包，再重启 `serve` 或 DSH。
- 配置有 `schemaVersion`，升级时由 `src/core/config.mjs` 自动迁移；跨大版本回退前先备份：
  `node src/cli.mjs backup --out cockpit-backup.json`（v2），回退验证用 `restore --dry-run`。
- 回退前保留当前 `~/.dsh-cockpit` 与备份文件（备份含配置/舒适度/偏好，不含对话）；不要把备份提交到仓库或上传到公共位置。
- 旧版不保证读取新版配置；回退后跑一次 `doctor` 与 `status` 再判断是否正常。

## 6. 卸载

1. 插件方式：从 profile 的 `cordis.patch.yml` 删除 `dsh-cockpit` 条目，再
   `dsh plugin --profile <name> remove dsh-cockpit-plugin`，重启 DSH。
2. 停止 `serve` 进程（前台 `Ctrl+C`）。
3. 用户确认不再需要本地状态后，才删除 `~/.dsh-cockpit`（先做备份）；**不要**删除或修改 `~/.dsh`。
4. 删除 checkout/安装目录。

卸载不涉及云端数据：团队同步由用户自建的 Worker 管理，撤销设备 ≠ 删除已上传快照，按 `docs/SYNC.md` 说明处理。

## 7. 遇到问题

见 [按现象排障](troubleshooting.md)。报告问题时附：操作系统与 Node 版本、启动方式、复现步骤、脱敏错误、是否装插件；
**不要附**真实会话 id/标题、`~/.dsh` 内容、API Key、完整配置文件。
