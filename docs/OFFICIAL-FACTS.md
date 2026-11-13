# 官方事实与本产品的取舍映射

> 来源：DeepSeek 官方 API 文档（价格页 / Token 用量 / 限速与隔离 / 首次调用 / 错误码），2026-11-03 核对。
> 目的：**明确哪些官方事实已纳入产品行为，哪些无法纳入及原因**——避免"看起来支持其实没算"的误导。

## 1. 已纳入

| 官方事实 | 数值/规则 | 产品落地 |
|---|---|---|
| 模型与价格 | flash：命中 0.04 / 未命中 2 / 输出 8；v4-pro：0.30 / 9 / 27（¥/M，高峰） | `src/core/pricing.mjs` `PRICING_V2` |
| 高峰/空闲 | 工作日 09–12、14–18 高峰；其余 ×0.5；节假日空闲 | `isPeak()` + `pricingPolicy`（含 `holidays` 配置） |
| 旧模型名 | `deepseek-v4-flash*` 按 Flash 计费 | `MODEL_ALIASES` |
| 上下文长度 | 1M | 每个会话从 `request/context.contextWindow` 读取（实测 1,048,576） |
| 图片 token | 已包含在 usage | 直接使用 usage 桶 |
| 输出长度 | 最大 384K | 不单独展示；usage.outputTokens 已反映 |
| 模型名 | `deepseek-flash` / `deepseek-v4-pro` | 价格表与别名归一 |
| **模型版本号** | `deepseek-flash` = **DeepSeek-V4.1-Flash-1017**；`deepseek-v4-pro` = **DeepSeek-V4-Pro-0813** | 写入 `PRICING.md` 与 `status` 说明，便于对账时锁定版本 |
| **能力位** | JSON/Tool/Responses/Anthropic API 均支持；FIM 仅非思考；**图像理解仅 flash** | 文档标注；预测/成本说明中区分视觉输入场景 |
| **官方余额 API** | `GET https://api.deepseek.com/user/balance`（Bearer API Key；返回 total/granted/topped_up） | **实时对账**（显式开启）：打开/刷新取最新值，24h `Δ官方余额` vs 本地估算；Key 仅环境变量、不落盘 |
| **上下文缓存语义** | 默认开启；按"缓存前缀单元"落盘/命中；受 **SWA（Sliding Window Attention）** 影响，长对话命中率可能低于直觉 | 在 PRICING/PRIVACY 说明 `cacheReadTokens` 是计费命中量，不等于全部历史被缓存 |
| **官方 Agent Harness** | `deepseek-ai/deepseek-harness`（MIT，Cordis 插件架构，文档站 + `docs/architecture.md` + `SAFETY.md`） | 本产品作为其插件运行；插件写法与生命周期以其官方文档为准 |
| **官方 tokenizer** | `deepseek-ai/deepseek-recipe` 附带 tokenizer 与 prompt 渲染 | P3 字符启发式的**升级路径**：接入官方 tokenizer 做精确估算（可选依赖、默认关） |
| **Search / Fetch 计费** | 5 元 / 1000 次成功请求 | `tool/call(web_search\|web_fetch)` × 成功结果，**近似计入**（下限估计，一次搜索可能触发多次 provider 请求） |
| **错误码（部分）** | 429/5xx/超时/传输 | `llm/retry.failure.code`：RATE_LIMIT / TRANSPORT / SERVER 可观测并统计 |
| **Tokenizer 换算** | 中文 ≈0.6、英文 ≈0.3 token/字符 | 作为**可选估算**（`estimation.fallback=chars`，默认关闭、不计成本），仅用于缺失 usage 的消息 |

## 2. 未纳入（及原因）

| 官方事实 | 数值/规则 | 为什么不纳入 |
|---|---|---|
| 并发限制 | flash 2500 / v4-pro 500 | 本产品不代理请求，无法观测并发；429 发生在 DSH 内部，只能通过重试事件间接看到 |
| 错误码（完整分类） | 400/401/402/422/429/500/503 | 会话事件只暴露重试子集（RATE_LIMIT/TRANSPORT/SERVER），无请求级状态码 |
| `user_id` 隔离 | 内容安全/KVCache/调度隔离 | DSH 云端配置决定，本地会话不可见 |
| 请求保活（空行 / `: keep-alive`） | 传输层行为 | 与用量统计无关 |
| 离线 tokenizer 包 | `deepseek_tokenizer.zip` | 零依赖原则；已用字符启发式替代（可选、默认关） |
| Base URL（OpenAI/Anthropic） | `https://api.deepseek.com` 等 | 仅余额查询用到 `api.deepseek.com/user/balance` |

## 3. 若未来要补齐（按优先级）

| 优先级 | 能力 | 前置条件 |
|---|---|---|
| P1 | 并发/完整错误码统计 | DSH 持久化请求级状态码与并发信息 |
| P2 | 离线 tokenizer 精确估算 | 接入 `deepseek-recipe` 的 tokenizer（可选依赖，需评审零依赖例外） |
| P3 | Search/Fetch 精确次数 | DSH 暴露 provider 级调用计数（当前按工具调用次数下限估计） |

## 4. 维护约定

- 官方价格或计费规则变化：改 `pricing.mjs` + 升 `PRICING_VERSION`（缓存自动失效重算）+ 更新本文件与 `PRICING.md`；
- 官方新增模型：加 `DEFAULT_PRICING` 条目与（如需要）别名；
- 任何"未纳入"项若要转为纳入，必须在本文档移除并说明数据来源。
