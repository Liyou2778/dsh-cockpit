# 模型与算法规格（MODEL）

> 原则：**公式即规格**。任何算法改动必须升政策版本号并保留旧数值用例（见 `AGENTS.md`）。
> 移植自 [Codex Cockpit](https://github.com/HouSiyuan2001/codex-cockpit)（MIT），逐步对照见 `docs/PRD.md` 第 16 章。

## 0. 数据到指标

```
DSH 会话事件 (assistant/message.data.usage)
  ├─ inputTokens        非缓存输入
  ├─ cacheReadTokens    缓存读取
  ├─ cacheWriteTokens   缓存写入
  ├─ outputTokens       输出（含推理时为输出总量；reasoningTokens 另行给出，不重复计费）
  └─ totalTokens        = input + cacheRead + cacheWrite + output
```

- 上下文压力（与 DSH 官方 `dsh-token-meter` 一致）：`pressure = inputTokens + cacheReadTokens + cacheWriteTokens`
- 日界：`cycleDateKey(ts, dayStartHour=4)`，Asia/Shanghai。

## 1. 成本（`PRICING_V2`）

```
单次 = (未命中输入 × input + 缓存命中 × cacheHit + 缓存写入 × cacheWrite + 输出 × output) / 1e6
最终 = 单次 × 时段系数（高峰 1 / 空闲 idleRatio，官方 0.5）
```

- 价格单位 **¥ / 百万 tokens**，`DEFAULT_PRICING` 存**高峰价**（官方 2026-11-03 价：flash 2 / 0.04 / 8；v4-pro 9 / 0.30 / 27）；
- **时段按消息时间戳判定**：北京时间工作日 09:00–12:00、14:00–18:00 为高峰，其余（周末/节假日全天）空闲；节假日由 `pricingPolicy.holidays` 配置；
- 模型别名：`deepseek-v4-flash*` → flash；`deepseek-pro` → v4-pro；
- **未知模型 → `null`**；必要桶缺失 → `null`（缺失 ≠ 0）；
- Search/Fetch 按次计费**未纳入**（会话事件无该信息，见 `OFFICIAL-FACTS.md`）。

## 2. 配速（`PACE_V1`，移植 `quotaPace.ts:126-212`）

```
elapsedRatio       = (now − cycleStart) / (reset − cycleStart)
recommendedUsed    = cycleStartUsed + cycleStartRemaining × elapsedRatio
dailyBudget        = remaining × (到今日结束时长 / 到重置时长)
overBy             = max(0, used − recommendedUsed)
status             = overBy ≤ 0.5% ? on_track : over_pace
averageRate        = remaining / (剩余小时数)   // unit 由窗口长度决定
```

容差：调度 `0.5%`、时钟 `2min`；超出重置时间 → `unknown`（不误报超速）。

## 3. 今日计划（`PLAN_V1`，移植 `dynamicQuota.ts:149-165`）

```
uniform   = remaining / (daysLeft + 1)
boost     = max(0, remaining − uniform) × p²          // p = 压缩风险 / 100
softCap   = knee × (1 + 1.5p) × (isWeekend ? 0.75 : 1)
suggested = min(remaining, uniform + boost, softCap)
```

- `p²` 的含义：风险越高，越应该"把未来额度前移"到现在用（参考产品原语义）。
- `knee` 默认 25%；舒适度拟合成功后使用个人 k（`COMFORT_FIT_V1`）。
- 恒有 `suggested ≤ remaining`。

## 4. 压缩预测（`FORECAST_V1`，结构移植 `reset_forecast.rs:166-271`）

```
ratio   = pressure / contextWindow
base    = sigmoid((ratio − 0.6) / 0.12) × 100
recent  = 近 7 天压缩次数
score  += clamp((min(recent×18, 95) − base) × 0.25, −12, +12)     // 历史校准
score  += 4 if 周内先验偏高（周二/周六）                            // WEEKDAY_HAZARD
score   = clamp(score, 2, 95)
etaHours = (0.92×contextWindow − pressure) / growthPerHour         // growth≤0 → null
```

`source = history | pressure`；输出必须标注"非官方预测"。

## 5. 舒适度（`COMFORT_FIT_V1`）

```
target y = (level − 1) / 4                        // level ∈ 1..5
η(x; k)  = x ≤ k ? 1 : exp(−sharpness × ((x−k)/(1−k))^power)
sharpness = 4.3, power = 1.5
拟合：k ∈ [5,95] 网格搜索，最小化 Σ w·(η(x;k) − y)²，w = 0.5^(ageDays/14)
建议今日目标 = k × (1 + 1.5×risk) × (weekend ? 0.75 : 1)
```

- 样本 < `comfort.minSamples`（默认 5）→ 不拟合，`k=null`；
- k 回灌 `PLAN_V1` 的 `knee`。

## 6. 参数表

| 参数 | 默认 | 位置 |
|---|---|---|
| `idleRatio` | 0.5 | `pricing.mjs` / `pricingPolicy` |
| 高峰时段 | 工作日 `[9,12],[14,18]`（北京时间） | `pricingPolicy.peakWindows` |
| 法定节假日 | 空（需手动配置） | `pricingPolicy.holidays` |
| `SCHEDULE_TOLERANCE_PERCENT` | 0.5 | `pace.mjs` |
| `CLOCK_TOLERANCE_MS` | 120000 | `pace.mjs` |
| `DEFAULT_FATIGUE_KNEE_PERCENT` | 25 | `plan.mjs` |
| `WEEKDAY_HAZARD` | `[0.1,0.7,0.1,0.1,0.1,0.7,0.1]` | `forecast.mjs` |
| `COMFORT_HALF_LIFE_DAYS` | 14 | `comfort.mjs` |
| `dayStartHour` | 4 | `config.mjs` |
| 默认预算 | 2,000,000 tokens | `config.mjs` |
| 有界扫描 | 4000 文件 / 单文件 64MB | `session-reader.mjs` |

## 8. Search / Fetch 服务费（`SERVICE_V1`）

```
serviceFee = 成功调用次数 × 0.005（元/次，官方 5 元/1000 次）
success = tool/result 存在且无 data.error，且对应 tool/call 名为 web_search / web_fetch
```

- 失败调用不计费；`budget.includeServiceFees`（默认 true）决定是否进入金额预算；
- **下限估计**：一次 `web_search` 可能触发多个 provider 请求，本产品按工具调用次数计。

## 9. 可靠性指标（来自 `llm/retry`）

```
retries       = llm/retry 事件数
byCode        = failure.code 分组（RATE_LIMIT / TRANSPORT / SERVER / …）
rateLimit     = byCode.RATE_LIMIT（即 429 重试）
toolErrorRate = tool/result.error / tool/result
retriesPerMessage = retries / assistantMessages
```

仅覆盖 DSH 持久化的重试子集；完整 HTTP 状态码与并发数不可观测。

## 10. 缺失 usage 的字符估算（`ESTIMATION_V1`，默认关闭）

```
tokens ≈ CJK字符数 × 0.6 + 其他字符数 × 0.3     // 官方换算比例
```

- 仅当 `estimation.fallback = "chars"` 时启用；结果写 `status.estimation`，**不计入成本与总量**；
- 只统计字符数，不保留文本；
- 默认 `none`，保持"缺失 ≠ 0"。

## 11. 校准与验证

- 单元测试对公式做数值断言（`test/algorithms.test.mjs`）：配速、计划、预测边界、舒适度恢复 k。
- 真实数据验收：124 会话、16,224 条 usage、0 错误（`CHANGELOG.md` 基线）。
- **不做**：不把压缩预测当官方数据；不把估算金额写成账单；不对缺失数据补 0。
