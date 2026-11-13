# 价格与成本估算（PRICING）

> **金额是估算，不是账单。** 官方价格页：<https://api-docs.deepseek.com/zh-cn/quick_start/pricing>
> 本文件核对日期：**2026-11-03** ｜ 计价政策版本：**`PRICING_V2`**

## 1. 口径

```
单次成本 = (未命中输入 × 输入价 + 缓存命中 × 命中价 + 缓存写入 × 未命中输入价 + 输出 × 输出价) / 1,000,000
最终成本 = 单次成本 × 时段系数（高峰 = 1，空闲 = 0.5）
```

- 单位：**人民币 / 百万 tokens**；
- 时段判定按**消息时间戳**（不是按天），因此同一天内可能混合高峰/空闲价；
- 未知模型 → 金额 `null`（界面 `—`），不猜价；必要字段缺失 → `null`（**缺失 ≠ 0**）；
- `reasoningTokens` 已包含在输出计费中，不重复累加。

## 2. 官方价格（高峰价；空闲 = 高峰 × 0.5）

| 模型 | 版本 | 缓存命中输入 | 缓存未命中输入 | 输出 |
|---|---|---:|---:|---:|
| `deepseek-flash` | DeepSeek-V4.1-Flash-1017 | 0.04 | 2.00 | 8.00 |
| `deepseek-v4-pro` | DeepSeek-V4-Pro-0813 | 0.30 | 9.00 | 27.00 |

空闲时段价（×0.5）：flash 0.02 / 1.00 / 4.00；v4-pro 0.15 / 4.50 / 13.50。

**高峰时段**：北京时间 **周一至周五（不含中国法定节假日）09:00–12:00、14:00–18:00**；
其余时段（含周末、法定节假日全天）为空闲。边界为左闭右开（09:00 算高峰、12:00 算空闲）。

> 中国法定节假日无法内置维护 → 通过配置 `pricingPolicy.holidays`（`["2026-10-01", ...]`）补充；未配置时按工作日规则计算。

## 3. 字段映射（DSH usage → 官方计费桶）

| 官方计费项 | DSH `assistant/message.data.usage` | 说明 |
|---|---|---|
| 缓存命中输入 | `cacheReadTokens` | 按命中价 |
| 缓存未命中输入 | `inputTokens` | 按未命中输入价 |
| 缓存写入 | `cacheWriteTokens` | 官方未单列，按未命中输入价计 |
| 输出 | `outputTokens` | 已含推理 token |
| 图片 token | 已并入上述桶 | 不单独计 |

## 4. 模型别名（官方声明）

| 传入名 | 计费模型 |
|---|---|
| `deepseek-flash` | flash（官方推荐名） |
| `deepseek-v4-flash` / `deepseek-v4-flash-vision-exp` | 由 V4.1-Flash 提供服务，按 **Flash 价** |
| `deepseek-v4-pro` | v4-pro |
| `deepseek-pro`（本仓库旧默认名） | 映射到 v4-pro |

## 5. Search / Fetch 服务费（SERVICE_V1，近似计入）

官方：Search / Fetch 各 **5 元 / 1000 次成功请求**（2026-11-01 起）。

- 数据来源：`tool/call` 中 `web_search` / `web_fetch` 的调用，与 `tool/result` 的 `message.source.callId` 配对；`data.error` 存在视为失败；
- **只对成功请求计费**；失败不计费；
- `costCny = 成功次数 × 0.005`；
- ⚠️ **下限估计**：一次 `web_search` 工具调用可能触发多个 provider 请求（官方工具定义 `max_uses: 5`），我们按"成功工具调用 × 1 次"计；
- 是否计入预算：`budget.includeServiceFees`（默认 `true`），仅在**金额预算**口径下影响百分比；token 预算不受影响；
- 展示位置：`status.serviceFees`、`breakdown.services`、小票单独一行、CLI `status`。

## 6. 缺失 usage 时的字符估算（ESTIMATION_V1，默认关闭）

当某些历史消息缺 `usage` 时，可选按官方换算比例估算 token：**中文 ≈0.6 token/字，其他 ≈0.3 token/字符**。

- 默认 `estimation.fallback = "none"`（保持"缺失 ≠ 0"）；
- 开启：`config --set` 或改配置文件 `estimation.fallback = "chars"`；
- 估算结果只写 `status.estimation`（`messages/tokens`），**不计入成本与总量**；
- 隐私：只统计字符数，**不保留文本内容**。

## 7. 不能算的部分（明确声明）

- 未匹配价格的模型 → 只记 token，不记金额。
- 缺 usage 桶的历史事件 → 金额未知（可由 `totalTokens` 反推输入时仍可算）。
- 不推断 Batch / 区域附加费 / 工具调用附加费 / 缓存写入独立价。
- 并发限制、请求错误码的完整分类（仅能从 `llm/retry.failure.code` 观测到 RATE_LIMIT/TRANSPORT/SERVER 等子集）。

## 8. 价格变更流程（维护者）

1. 修改 `src/core/pricing.mjs` 的 `DEFAULT_PRICING`（高峰价）与 `PRICING_REFERENCE_DATE`；
2. **升 `PRICING_VERSION`**（如 `PRICING_V3`）——`state.json` 会因版本不一致自动失效并全量重扫，历史成本用新价重算；
3. 更新本文件与 `CHANGELOG.md`；
4. 跑 `npm test`（价格用例在 `test/algorithms.test.mjs`）。

## 9. 校验

```bash
node src/cli.mjs status --json | # 看 pricingNow（当前时段系数）与 totals
node src/cli.mjs tasks --range 1d # 看任务成本（新价）
npm test                          # 价格公式/高峰/空闲/节假日/别名用例
```

> 与官方账单的对照属于人工验收（见 `docs/TEST-MATRIX.md`）；估算不等同于账单。
