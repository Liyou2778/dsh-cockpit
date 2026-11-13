# 使用说明（USER-GUIDE）

## 1. 三步上手

```bash
# 1) 看一眼（自动扫描 ~/.dsh/sessions）
node src/cli.mjs status

# 2) 设置你的每日预算（重要：默认 2,000,000 tokens 可能偏低）
node src/cli.mjs config --set budget.tokens=10000000

# 3) 打开仪表盘
node src/cli.mjs serve --open
```

首次扫描约 5 秒（124 个会话）；之后走缓存，几百毫秒。

## 2. 每个数字是什么意思

| 卡片 | 含义 | 读法 |
|---|---|---|
| **本周期用量** | 当前预算周期内的 token（或 ¥）占预算比例 | 周期默认「今日 04:00 → 次日 04:00」 |
| **上下文压力** | 最近一次请求的上下文占用 / 窗口大小（1,048,576） | 越高越接近被压缩 |
| **配速** | 实际用量 vs 按时间线性应消耗量 | `on_track` 健康；`over_pace` 用快了 |
| **今日建议** | 综合剩余、压缩风险、疲劳膝点给出的建议用量 | 分解为「均匀 + 风险加成」，另有上限 |
| **压缩预测** | 未来 24h 触发上下文压缩的概率与预计时间 | 启发式，用于提前收尾 |
| **舒适度** | 你对当天节奏的主观体感（1–5） | 14 天后可拟合出个人曲线 |

## 3. 常见问题

**Q：数字和 DSH 界面不一致？**
A：本工具默认 **04:00 换日**（可在 `config --set budget.dayStartHour=0` 改为自然日），且统计的是"模型上报的 usage 桶"，与界面内的上下文进度不是同一口径。

**Q：金额显示 `—`？**
A：模型不在参考价表或该条记录缺 usage 桶。开箱内置了 `deepseek-flash/pro/reasoner/chat`，其他模型请在设置里补价格，或接受"只统计 token"。

**Q：扫描很慢/内存高？**
A：首扫需解码约 100MB zstd。之后按 `path|size|mtime` 增量；可看 `status --json` 的 `health.scanDurationMs`。

**Q：插件装上后 404？**
A：确认两件事：① `dsh plugin --profile web add "file:.../dsh-plugin"` 成功；② profile 的 `cordis.patch.yml` 有 `dsh-cockpit` 条目。用 `dsh --profile web --dump-config` 检查。

**Q：会读取我的对话内容吗？**
A：不会。只解析 `assistant/message.data.usage`、`tool/call` 名称、`session/title` 等元数据；正文不进入任何存储。见 `docs/PRIVACY.md`。

**Q：能看别的机器/团队吗？**
A：MVP 只统计本机；团队共享属于 P2（见 PRD FR-13）。

**Q：怎么显示官方余额？**
A：① 终端设置 `DEEPSEEK_API_KEY`（只读环境变量，不落盘）；② `dsh-cockpit config --set balance.enabled=true`；③ `dsh-cockpit balance --refresh` 验证。之后打开仪表盘即实时取数，点「刷新」强制最新；底部会显示「官方余额」与 24h 对账偏差。

**Q：怎么用团队功能？**
A：先自托管 Worker（见 `docs/SYNC.md` §3），然后本机一键建空间：
```powershell
$env:DSH_COCKPIT_BOOTSTRAP_SECRET = "<Worker secret>"
node src/cli.mjs sync init --endpoint https://<worker>.workers.dev --name dev-a
$env:DSH_COCKPIT_SYNC_TOKEN = "ccs_..."   # 令牌只显示一次
node src/cli.mjs sync push
node src/cli.mjs sync invite              # 第二台设备用
```
第二台：配置同一 endpoint + `sync.enabled=true` → `sync enroll --invite CCI-...`。入组后任务区出现「成员」Tab：成员今日用量、共享计划占比、改名/移除。共享计划是**建议性**的，不会拦截请求。

**Q：如何卸载？**
A：插件：`dsh plugin --profile web remove dsh-cockpit-plugin` 并从 `cordis.patch.yml` 删除条目；数据：删除 `~/.dsh-cockpit`。不会影响 DSH 与你的会话。

## 4. 配置速查

```bash
dsh-cockpit config                                        # 查看
dsh-cockpit config --set budget.tokens=10000000           # 日 token 预算
dsh-cockpit config --set budget.costCny=20                # 或按金额预算
dsh-cockpit config --set budget.mode=weekly               # daily | weekly | monthly
dsh-cockpit config --set budget.axis=context              # budget | balance | context
dsh-cockpit config --set ui.maskTitles=true               # 标题打码
dsh-cockpit config --set metrics.enabled=false            # 关闭本地日志
dsh-cockpit config --set balance.enabled=true              # 开启官方余额（需 DEEPSEEK_API_KEY）
dsh-cockpit config --set balance.ttlMs=15000               # 余额缓存防抖（手动刷新始终绕过）
dsh-cockpit config --set balance.reconcileWindowMs=3600000 # 对账窗口（1h–7d；默认 24h）
dsh-cockpit sync members                                   # 团队成员（本机实时 + 远端快照）
dsh-cockpit sync plan --daily-token-cap 20000000 --day-total-percent 90  # 共享计划（建议性）
dsh-cockpit sync rename <deviceId> --name 我的笔记本        # owner 或本人
dsh-cockpit sync remove <deviceId>                         # 仅 owner，撤销令牌
dsh-cockpit balance --refresh                              # 立即取一次官方余额
```
