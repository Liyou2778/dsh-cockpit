# DSH 驾驶舱（dsh-cockpit）· 产品需求文档（PRD）

> **文档类型**：PRD 大纲框架（Outline for Review）｜ **版本**：v0.2-draft ｜ **状态**：待确认
> **关键约束**：本文档经确认后才进入制作（编码）阶段。当前仓库目录内**没有**任何产品代码。

---

## 0. 文档控制

### 0.1 文档信息

| 项 | 内容 |
|---|---|
| 产品名（暂定） | DSH 驾驶舱 / DSH Cockpit |
| 代号 | `dsh-cockpit` |
| 文档版本 | v0.1-draft |
| 状态 | Draft → 待产品负责人（你）确认 |
| 目标版本 | MVP = v0.1.0；正式可用 = v0.2.0 |
| 作者 | Lead（AI Agent） |
| 评审人 | 你（唯一产品决策人） |
| 基线日期 | 2026-11-01 |
| 参考基线 | DSH 0.1.2-rc.1 / Codex Cockpit v0.3.5 |

### 0.2 修订历史

| 版本 | 日期 | 变更 | 作者 |
|---|---|---|---|
| v0.1-draft | 2026-11-01 | 首版大纲框架，含 8 个待确认决策点 | Lead |
| v0.2-draft | 2026-11-01 | 新增第 16 章「与 Codex Cockpit 的逐步对照与依据溯源」：章节级/功能级/算法级/数据链路/工程方法/制作步骤/决策依据/不采纳清单/依据强度九张对照表 | Lead |

### 0.3 阅读指南

| 读者 | 必读章节 |
|---|---|
| 产品负责人（你） | 1, 2, 5, 6, 11, 15 |
| 后续实现（AI Agent / 我） | 全部，重点 6, 8, 9, 10 |
| 安全/合规评审 | 7.3, 7.4, 11 |
| 使用者 | 3, 9, 14.2 |

### 0.4 术语表（简版，全表见附录 A）

| 术语 | 定义 |
|---|---|
| DSH | DeepSeek Harness，本机会话型 AI 编程代理 |
| 会话（session） | DSH 一次对话的持久化单元，落盘为 `session.v{3,4}.jsonl.zstd` |
| usage | 模型单次响应上报的 token 桶：`inputTokens`（非缓存输入）、`cacheReadTokens`、`cacheWriteTokens`、`outputTokens`、`reasoningTokens` |
| 压力（pressure） | 当前上下文占用 = `inputTokens + cacheReadTokens + cacheWriteTokens`（口径来自 DSH 官方 `dsh-token-meter`） |
| 压缩（compaction） | 上下文接近上限时 DSH 主动裁剪历史；**本产品中作为"额度重置"的对应事件** |
| 配速（pace） | 实际用量相对"按时间线性应消耗量"的偏离 |
| 计划（plan） | 基于剩余与重置风险给出的"今日建议使用量" |
| 预算周期 | 用户设定的统计/规划周期（日/周/月），默认日周期 04:00 换日（可配） |

### 0.5 证据基线（本 PRD 的实测依据）

| 事实 | 实测值 | 来源 |
|---|---|---|
| 本地会话数量 | 119 个（v3: 46 / v4: 73） | `~/.dsh/sessions/**/session.v*.jsonl.zstd` |
| 压缩后体积 | 102.7 MB | 同上 |
| 事件总数 | 102,293 条 | 自研解码器实测 |
| 带 usage 的助手消息 | 16,036 条 | `assistant/message.data.usage` |
| 会话事件类型 | 33 类（turn/step/tool/compaction/subagent…） | 实测枚举 |
| 上下文窗口 | 1,000,000（`deepseek-flash`） | `request/context` 事件 |
| 插件机制 | Cordis：`name + inject + apply(ctx)`，`ctx.webServer` 可注册路由 | 官方 `dsh-endfield-ui` 示例 |
| 插件安装 | `dsh plugin --profile <name> add <spec>` | `dsh --help` |

> **风险提示**：DSH 会话格式与插件 API 均处于 `0.1.2-rc` 阶段，属**内部契约**，存在随版本变更的可能。本 PRD 第 11 章将其列为首要风险并给出适配策略。

---

## 1. 背景与问题定义

### 1.1 产品背景

- **DSH 已进入日常重度使用**：本地已积累 119 个会话、10.3 万事件、1.6 万条带用量记录，单日会话可达数十个。
- **用量不可见**：DSH 只在会话内部展示上下文进度，**没有跨会话、跨日期、按模型/工具/项目的用量视图**。
- **成本不可算**：DeepSeek 按 token 计费（缓存命中/未命中/输出三档），用户无法回答"这个月花了多少钱、钱花在哪个项目上"。
- **节奏不可控**：上下文窗口（1M）什么时候会被压缩、压缩频率多高、当前使用节奏是否健康，均不可观。

### 1.2 问题陈述（按用户可感知程度排序）

| ID | 问题 | 现状 | 影响 |
|---|---|---|---|
| P1 | 不知道今天/本周用了多少 token | 无视图，只能逐会话翻 | 无法做预算，账单意外 |
| P2 | 不知道钱花在哪个项目/任务上 | 无任务级归因 | 优化无抓手 |
| P3 | 不知道当前节奏是否"太快" | 无配速概念 | 后期被压缩打断，返工 |
| P4 | 不知道上下文何时会被压缩 | 只能等系统提示 | 长任务中断，需重新喂上下文 |
| P5 | 没有个人"舒适节奏"沉淀 | 经验不可复用 | 每次都要重新摸索 |

### 1.3 为什么现在（时机）

1. DSH 数据已足够丰富（usage 桶、turn/step、tool/call、compaction、session/title、subagent），**足以支撑分析型产品**；
2. DSH 提供 Cordis 插件机制与 `webServer` 服务，**可以做到"零侵入集成"**；
3. 参考产品 Codex Cockpit 已验证"额度+配速+舒适度"产品模型，**方法论可迁移**，不需要重新验证需求。

### 1.4 对标参考：Codex Cockpit 的复刻边界

复刻对象 = **产品模型 + 算法内核 + 制作方法**（不是 UI 像素级照抄）。

| 复刻维度 | Codex Cockpit 的做法 | 本产品对应策略 |
|---|---|---|
| 数据链路 | 官方额度 API + 本地会话解析 + 第三方预测 | DSH 无公开额度 API → **本地会话为主 + 可选余额 API + 压缩事件替代"重置"** |
| 核心算法 | 线性配速、风险平方前移、疲劳上限、舒适曲线拟合 | **同构移植**（公式与参数在 8.3 给出） |
| 额度重置 | 周额度 04:00 换日 | **压缩事件 = 重置**；预算周期 04:00 换日 |
| 团队共享 | 可选自托管 Cloudflare Worker | 列入 P2，MVP 不做（见 5.1） |
| 制作方法 | 文档驱动、测试即规格、AGENTS.md/Skill、CI 门禁 | **完整复刻**（见 10、13、14） |

---

## 2. 目标与非目标

### 2.1 一句话定位

> **把 DSH 看不见的 token、钱和上下文压力，变成一个每天扫一眼就懂的本地驾驶舱——只读、离线、不打扰。**

### 2.2 目标

| 类型 | ID | 目标 | 衡量方式 |
|---|---|---|---|
| 业务 | O1 | 建立"用量—成本—节奏"的完整观测闭环 | 功能验收全通过 |
| 业务 | O2 | 形成可复用的"个人 AI 使用基线" | 舒适度样本 ≥14 天后生成曲线 |
| 业务 | O3 | 成为 DSH 生态的示范性插件（AI 原生仓库方法论） | 文档/AGENTS/Skill 齐全度自评 ≥90% |
| 用户 | U1 | 3 秒内回答"今天还能用多少" | 首屏关键信息 ≤3 秒可读 |
| 用户 | U2 | 找出 Top3 吃 token 的任务/模型 | 分布卡可下钻 |
| 用户 | U3 | 预判上下文压缩时间，减少中断 | 预测 ETA 有明确置信说明 |

### 2.3 成功指标（在"零遥测"约束下的度量设计）

**约束**：本产品默认**无遥测**（见 7.4），因此不能依赖服务端埋点。度量方案：

| 层级 | 指标 | 定义 | 采集方式 | 目标 |
|---|---|---|---|---|
| 北极星 | 周活跃查看（WAU-view） | 每周至少打开驾驶舱 3 天的用户数 | **本地事件日志**（仅本地，用户可导出/关闭） | MVP 自用场景：≥5 天/周 |
| 驱动 | 首次扫描成功率 | 首次运行完成全量扫描且无错误 | 本地日志 `scan.ok` | ≥99% |
| 驱动 | 首屏耗时 | `/api/status` 冷/热耗时 | 本地日志 `status.latency` | 冷 ≤8s / 热 ≤300ms |
| 护栏 | 误报率 | 用户标记"预测不准"的比例 | 本地日志 `forecast.feedback` | ≤30% |
| 护栏 | 资源占用 | 扫描峰值内存 | 本地日志 `scan.rss` | ≤200MB |

> 说明：本地日志写入 `~/.dsh-cockpit/metrics.jsonl`，默认开启但**永不外传**；用户在设置中可一键关闭与清空。这是"隐私优先 vs 可度量"的折中，**需你确认（决策 D6）**。

### 2.4 非目标（明确不做）

| 非目标 | 原因 |
|---|---|
| ❌ 不做模型代理 / 不拦截请求 | 只读观测器，零侵入 |
| ❌ 不分析对话内容 / 不读消息正文 | 隐私底线；只取 usage 数字与元数据 |
| ❌ 不做公共 SaaS / 多租户托管 | 与"本地优先"冲突；P2 只做自托管 |
| ❌ 不修改 DSH 行为、不注入系统提示 | 安全与可预期性 |
| ❌ 不做移动端 / 不做 Electron 独立壳 | 复用 DSH Web GUI 与系统浏览器 |
| ❌ 不做团队计费/对账 | 估算非账单（与参考产品一致） |
| ❌ 不做遥测上报、不做账号体系 | 隐私与合规 |

---

## 3. 用户与场景

### 3.1 角色画像

| 角色 | 描述 | 核心诉求 | 优先级 |
|---|---|---|---|
| **R1 重度个人开发者**（主） | 每天 5–50 个 DSH 会话，用 DSH 写代码/写文档/做研究 | 今天用了多少、钱花在哪、别被压缩打断 | P0 |
| **R2 小团队/实验室成员** | 3–10 人共用一台机器或各自机器 | 个人节奏管理 + 后续团队视图 | P1（团队视图 P2） |
| **R3 技术管理者** | 关心成本与产出比 | 成本归因、周期报表 | P2 |

### 3.2 JTBD（Jobs To Be Done）

- 当我**开始一天工作**时，我想知道**今天还剩多少预算/上下文余量**，以便决定是放开跑还是省着用。
- 当我**完成一个项目**时，我想知道**这个项目花了多少 token/钱**，以便优化做法或向他人说明。
- 当我**感觉最近很累**时，我想看到**我的使用节奏与自己记录的体感**，以便调整。
- 当我**上下文快满**时，我想**提前知道压缩风险**，以便主动收尾或开新会话。

### 3.3 场景剧本（S1–S6）

| ID | 触发 | 动作 | 期望结果 |
|---|---|---|---|
| S1 | 早上打开电脑 | 打开驾驶舱（独立页或 DSH 内 /dsh-cockpit） | 双环显示：周期用量 61.7%、上下文压力 41.2%；配速 `over_pace` |
| S2 | 想放开用 | 看"今日建议"卡 | 建议 40.2%（均匀 19.1% + 风险加成 6.4% + 疲劳上限 28%） |
| S3 | 长任务进行中 | 看压缩预测卡 | "预计 ~6.4h 后触发压缩，概率 34%" |
| S4 | 项目结束 | 点"今日小票" | 生成 PNG，含任务/模型明细与合计 |
| S5 | 每天结束 | 记录舒适度（5 档） | 写入本地；14 天后生成个人曲线与 knee |
| S6 | 换电脑/重装 | 导出配置+舒适度记录，导入 | 数据不丢（仅本机 JSON） |

### 3.4 用户旅程

```
首次：dsh-cockpit scan（或插件自动扫描）
  → 检测 ~/.dsh/sessions → 全量解码（冷 ~5-8s）→ 聚合 → 生成首屏
日常：打开页面 → 增量扫描（按文件 mtime/size 缓存）→ 首屏 <300ms
异常：DSH 升级导致格式变化 → 显式"格式不支持"提示，不清空历史，保留只读视图
卸载：删除 ~/.dsh-cockpit 目录 + 插件目录，零残留（附卸载脚本）
```

---

## 4. 竞品与差异化

### 4.1 竞品矩阵

| 能力 | **DSH 驾驶舱（本产品）** | Codex Cockpit | CodexBar（22.9k★） | ccusage（CLI） | DSH 原生 |
|---|---|---|---|---|---|
| 跨会话用量聚合 | ✅ | ✅ | ✅（仅额度） | ✅ | ❌ |
| 成本估算（缓存三档） | ✅ | ✅ | ❌ | ✅ | ❌ |
| 任务/项目级归因 | ✅（会话标题+工作区） | ✅（任务级） | ❌ | 会话/日 | ❌ |
| 配速 / 今日建议 | ✅ | ✅ | 部分 | ❌ | ❌ |
| 上下文压缩预测 | ✅（DSH 独有） | ❌（额度重置） | ❌ | ❌ | 部分（仅当前会话） |
| 舒适度曲线 | ✅ | ✅ | ❌ | ❌ | ❌ |
| 三平台 | ✅（Web/任意 OS） | ✅（桌面） | ❌（macOS） | ✅ | ✅ |
| 零侵入插件集成 | ✅（Cordis） | ❌（独立 App） | ❌ | ❌（CLI） | — |
| 隐私（零遥测） | ✅ | ✅ | 部分 | ✅ | ✅ |

### 4.2 差异化定位（三轴）

1. **DSH 原生气质**：不是"外部工具"，是 DSH 的一部分（同源插件、同一数据源、同一套 turn/step 语义）。
2. **上下文即额度**：把"压缩"建模成"重置"，这是 DSH 独有的分析视角，参考产品做不到。
3. **AI 原生仓库**：AGENTS.md + docs + Skill + CI 门禁，仓库本身可被 Agent 消费与维护（复刻参考产品的制作方法）。

### 4.3 护城河与可复制性

- **可复制性高**：数据源公开、算法公开、无网络依赖 → 1 人 3–5 天可复刻 70%。
- **真实壁垒**：对 DSH 语义（压缩/turn/subagent）的理解深度 + 文档/测试/CI 形成的**长期可维护性** + 先发认知。
- **结论**：本产品定位为**高质量内部工具/生态示范**，不假设商业壁垒。

---

## 5. 范围与版本规划

### 5.1 范围矩阵

| 能力 | MVP (v0.1.0) | P1 (v0.2.0) | P2 (v0.3.x) | Out |
|---|---|---|---|---|
| 会话扫描（v3/v4） | ✅ | | | |
| usage 解析 + 成本估算 | ✅ | | | |
| 按日/模型/工具/会话聚合 | ✅ | | | |
| 配速 + 今日建议 | ✅ | | | |
| 压缩预测 | ✅（启发式） | ✅（校准） | | |
| 舒适度记录 + 曲线 | ✅（记录 + 简单拟合） | ✅（完整拟合+建议） | | |
| Web 仪表盘（双环/趋势/热力/分布/小票） | ✅ | | | |
| CLI（scan/status/plan/serve/report/doctor） | ✅ | | | |
| DSH Cordis 插件（`/dsh-cockpit` 路由） | ✅ | | | |
| 配置/备份/导入导出 | ✅ | | | |
| 增量扫描 + 缓存 | ✅ | | | |
| 多语言（zh/en） | 结构预留 | ✅ | | |
| 团队共享（自托管 Worker） | | | ✅ | |
| 桌面悬浮窗（Tauri） | | | | ❌ 不做（改用浏览器/DSH 内） |
| 官方额度 API 对接 | | ✅（若 DSH 暴露） | | ❌ 无公开接口 |
| 账户余额 API | | ✅（DEEPSEEK_API_KEY） | | |

### 5.2 里程碑与验收门

| 里程碑 | 内容 | 退出条件（Gate） |
|---|---|---|
| **M0 PRD 确认** | 本文档 | 你确认 15 章全部决策 |
| **M1 核心引擎** | reader/collect/pricing/pace/plan/forecast/comfort | `npm test` 全绿；真实数据扫描 119 会话 0 错误 |
| **M2 仪表盘** | 6 个 P0 界面 + 小票 | 首屏 <300ms（热）；空态/错误态可用；无 a11y 阻断 |
| **M3 集成** | CLI + DSH 插件 + 安装脚本 | 插件在 DSH 中可访问 `/dsh-cockpit`；CLI 6 命令可用 |
| **M4 硬化** | 测试矩阵/CI/安全审计/文档 | 覆盖率 ≥80%（core 模块）；`audit:public` 通过；文档齐备 |

### 5.3 复刻对照表（能力级）

| Codex Cockpit 能力 | DSH 驾驶舱对应 | 差异与原因 | 版本 |
|---|---|---|---|
| 官方剩余额度 | ①本地预算余量 ②上下文窗口余量 ③可选账户余额 | DSH 无官方额度 API | MVP |
| 重置时间/重置预测 | 压缩预测（ETA + 概率） | 压缩即重置 | MVP |
| 任务级 Token/成本 | 会话级（标题/工作区）+ 工具级 | DSH 有 turn/step 与 tool/call，可细化 | MVP |
| 日历热力图 | 84 天热力图 | 一致 | MVP |
| 小票 PNG | 今日小票 PNG | 一致 | MVP |
| 舒适度曲线 | 5 档体感 + 拟合 k | 一致（公式移植） | MVP/P1 |
| 团队共享 | 自托管 Worker | 推迟 | P2 |
| 自动更新 | 无（本地工具，git pull） | 不需要 | — |

---

## 6. 功能需求（FR）

> 每条需求格式：**目标 / 用户故事 / 规则 / 验收标准（AC，给定-当-则）/ 异常与边界 / 优先级**。

### FR-1 数据采集与归因

- **目标**：只读、增量、可解释地把 DSH 会话文件转成结构化用量记录。
- **用户故事**：作为用户，我希望首次运行即可看到历史全部用量，且之后打开很快。
- **规则**：
  - R1.1 只读访问 `~/.dsh/sessions/**/session.v{3,4}.jsonl(.zstd)`；**任何情况下不写入该目录**。
  - R1.2 支持多帧 zstd 容器（DSH append-batch 格式）+ 尾部明文 JSON；自动识别 magic `28 B5 2F FD`。
  - R1.3 每条 usage 记录归一为：`{sessionId, ts, turn, step, provider, model, inputTokens, cacheReadTokens, cacheWriteTokens, outputTokens, reasoningTokens, totalTokens, costCny|null}`。
  - R1.4 任务归因：会话标题（`session/title`，回退首条用户消息前 40 字）+ 工作区（`cwd` 末段）+ 子代理关系（`delegationDepth/parentSession`）。
  - R1.5 **缺失 ≠ 0**：字段缺失时成本为 `null` 并标记 `partial`，不补 0。
  - R1.6 增量缓存键 = `path + size + mtimeMs`；命中则不重解码。
- **AC**：
  - AC-1.1 给定本地 119 个真实会话，当执行首次扫描，则 `sessionsScanned=119, errors=0`，且 `messagesWithUsage ≥ 16000`。
  - AC-1.2 给定任一 v3 与 v4 文件，当解析，则均能产出相同结构的记录（版本差异被吸收）。
  - AC-1.3 给定损坏/截断文件，当扫描，则跳过并计入 `health.errors`，其余会话正常。
  - AC-1.4 给定二次扫描且文件未变，则耗时 ≤ 首次的 10%（缓存命中）。
- **异常**：DSH 版本升级导致新事件类型 → 未知类型计入 `unknownEventTypes`，不报错；usage 字段改名 → 触发 `schema-drift` 诊断并在 UI 明示"数据可能不完整"。
- **优先级**：P0

### FR-2 额度 / 预算账本

- **目标**：把"还剩多少"变成一条可比较的百分比。
- **口径（三选一，可切换）**：
  1. **预算模式（默认）**：用户设定日/周/月 token 预算或 ¥ 预算 → `remainingPercent = 1 - used/budget`。
  2. **余额模式（可选）**：配置 `DEEPSEEK_API_KEY` 后调用 `GET https://api.deepseek.com/user/balance` → 以余额为额度；无重置时间，周期由预算周期提供。
  3. **上下文模式**：以当前活跃会话的 `contextWindow` 为额度、`pressure` 为已用 → 展示"上下文余量"。
- **规则**：周期边界默认 **Asia/Shanghai 04:00 换日**（可配 `dayStartHour`）；周期内跨天不重置；`remainingPercent ∈ [0,100]`。
- **AC**：
  - AC-2.1 给定日预算 200 万 token、今日已用 123.4 万，则 `remainingPercent=38.3`、`usedPercent=61.7`。
  - AC-2.2 给定无预算配置，则默认预算 = 200 万 token（可改），并在 UI 标"默认值"。
  - AC-2.3 给定余额 API 失败，则回退预算模式并在 UI 显示"余额不可用"，不显示 0 余额。
- **优先级**：P0

### FR-3 配速（Pace）

- **目标**：判断当前消耗速度是否超前于时间进度。
- **规则（移植 Codex Cockpit `calculateQuotaPace`）**：
  - `recommendedUsedPercent = cycleStartUsed + cycleStartRemaining × elapsed/(reset-start)`
  - `averageRate = baselineRemaining / (剩余时长/单位)`，单位按窗口长度取 `hour|day`
  - `overByPercent = max(0, usedPercent − recommendedUsedPercent)`
  - `status = overBy ≤ 0.5% ? on_track : over_pace`；无有效 resetAt → `unknown`
  - 时钟容差 2 分钟、调度容差 0.5%
- **AC**：AC-3.1 给定周期过半、已用 61.7%，则 `recommendedUsedPercent≈50`、`status=over_pace`、`overBy≈11.7`；AC-3.2 无重置时间时 `status=unknown` 且不显示红色告警。
- **优先级**：P0

### FR-4 今日计划（Plan）

- **目标**：给出"今天建议用多少"的可解释数字。
- **规则（移植 Codex Cockpit `planCalibratedRiskQuota`）**：
  - `uniform = remaining / (daysLeft + 1)`
  - `boost = max(0, remaining − uniform) × p²`（p = 压缩风险，0–1，**风险平方前移未来额度**）
  - `softCap = knee × (1 + 1.5p) × (isWeekend ? 0.75 : 1)`
  - `suggested = min(remaining, uniform + boost, softCap)`
  - `knee` 默认 25%（可由舒适度拟合覆盖）
- **AC**：AC-4.1 给定 remaining=38.3、daysLeft=1、p=0.34，则输出与公式一致（允许 ±0.1 舍入）且三项分解可视化；AC-4.2 p=0 时 `boost=0`；AC-4.3 `suggested ≤ remaining` 恒成立。
- **优先级**：P0

### FR-5 上下文压缩预测（Forecast）

- **目标**：预判"什么时候会被压缩"，作为重置预测的对应物。
- **规则**：
  - 基础概率：`base = sigmoid((pressureRatio − 0.6)/0.12) × 100`，`pressureRatio = pressure/contextWindow`
  - 历史校准：近 7 天压缩次数、上周同星期压缩因子（`[0.1,0.7,0.1,0.1,0.1,0.7,0.1]` 的星期风险先验）→ 按 ±12 幅度向经验值移动
  - ETA：`etaHours = (0.92×contextWindow − pressure) / recentGrowthPerHour`（增长率为 0 → null）
  - 输出：`{score∈[2,95], windowHours:24, etaHours|null, factors[]}`，**必须标注"非官方预测"**
- **AC**：AC-5.1 压力 41% 且无历史 → `score < 30`；AC-5.2 压力 85% → `score > 60`；AC-5.3 ETA 为 null 时 UI 显示"—"而非 0；AC-5.4 有 ≥3 次压缩历史时 `source=history` 且列出 factors。
- **优先级**：P0（启发式）→ P1（历史校准）

### FR-6 舒适度与节奏

- **目标**：把主观体感沉淀为个人"舒适曲线"。
- **规则**：
  - 每日记录 1–5 档（很轻松/轻松/刚好/有点撑/很撑），映射到目标效率 `y=(level−1)/4`；已用量 `x=当日预算使用率`
  - 拟合 `η(x;k) = exp(−sharpness × ((max(0, x−k)/(100−k))^power))`，`k` 网格 5–95 步长 1，加权最小二乘，权重 `0.5^(ageDays/14)`
  - `k` 作为疲劳 knee 回灌 FR-4
- **AC**：AC-6.1 合成数据（x 越大体感越差）能恢复 k≈给定值（±10）；AC-6.2 样本 <5 时 `fitted=false` 且不输出建议；AC-6.3 曲线在 UI 可见并标注 knee。
- **优先级**：P0（记录+简单拟合）/ P1（完整）

### FR-7 驾驶舱仪表盘（Web）

- **目标**：一屏回答"今天怎么样"。
- **信息架构（P0 六区）**：① 顶栏（模式/刷新/设置）② 双环（周期用量 + 上下文压力）③ 配速 ④ 今日建议 ⑤ 压缩预测 ⑥ 趋势图 + 热力图 + 分布 + 舒适度 + 小票。
- **AC**：AC-7.1 首屏 6 区全部渲染；AC-7.2 后端不可达时显示横幅且保留上次数据；AC-7.3 键鼠可操作（Tab 顺序、焦点可见）；AC-7.4 768/1280 断点布局正确；AC-7.5 所有数字缺省显示 `—` 不显示 `NaN`。
- **优先级**：P0

### FR-8 小票 / 导出

- **规则**：`GET /api/receipt?days=N` 返回明细；前端 canvas 2× 渲染 PNG（等宽字体、虚线分隔、锯齿边），支持下载与剪贴板。
- **AC**：AC-8.1 PNG 分辨率 ≥2×；AC-8.2 内容含标题/日期/明细/合计；AC-8.3 剪贴板不支持时降级为下载并提示。
- **优先级**：P0

### FR-9 CLI

| 命令 | 说明 | 退出码 |
|---|---|---|
| `dsh-cockpit scan [--json]` | 扫描并输出摘要 | 0/1 |
| `dsh-cockpit status [--json]` | 打印首屏同源数据 | 0/1 |
| `dsh-cockpit plan` | 打印配速/计划/预测 | 0 |
| `dsh-cockpit report --days 30 [--md]` | Markdown 周期报告 | 0 |
| `dsh-cockpit serve --port 7777 [--open]` | 启动仪表盘 | 0 |
| `dsh-cockpit comfort <1-5> [--note]` | 记录舒适度 | 0 |
| `dsh-cockpit config [--set k=v]` | 查看/修改配置 | 0 |
| `dsh-cockpit doctor` | 环境/权限/格式自检 | 0/1 |
| `dsh-cockpit install-plugin [--profile web] [--dry-run]` | 安装 DSH 插件 | 0/1 |

- **AC**：AC-9.1 所有命令 `--help` 可用；AC-9.2 非交互环境不阻塞；AC-9.3 输出同时支持人类可读与 `--json`。
- **优先级**：P0

### FR-10 DSH 插件集成

- **规则**：Cordis 插件 `name='dsh-cockpit'`，`inject=['webServer']`，`apply(ctx)` 内 `ctx.effect(() => ctx.webServer.register({kind:'prefix', path:'/dsh-cockpit', handler}))`；handler 复用 `src/server.mjs` 的请求处理器（静态 + API）。
- **AC**：AC-10.1 插件加载后 `GET /dsh-cockpit` 返回仪表盘；AC-10.2 `GET /dsh-cockpit/api/status` 返回同构 JSON；AC-10.3 卸载插件不残留路由；AC-10.4 安装命令 `dsh plugin --profile web add <spec>` 可直接使用（安装文档给出）。
- **优先级**：P0

### FR-11 配置与偏好

- 配置文件：`~/.dsh-cockpit/config.json`（版本化 schema）；状态/缓存：`~/.dsh-cockpit/state.json`；舒适度：`~/.dsh-cockpit/comfort.json`；全部**原子写**（tmp+rename）。
- 可配项：预算模式/额度、价格表覆盖、`dayStartHour`、时区、端口、日志开关、语言。
- **AC**：AC-11.1 配置文件损坏时使用默认值并备份原文件；AC-11.2 并发写不产生半损文件；AC-11.3 配置迁移有 `schemaVersion`。
- **优先级**：P0

### FR-12 诊断与健康

- `health` 字段：`sessionsScanned/errors/durationMs/cacheHitRate/unknownEventTypes/schemaDrift`；`doctor` 命令检查 Node 版本、zstd 支持、目录权限、端口占用、DSH 目录存在性。
- **AC**：AC-12.1 缺少 `~/.dsh` 时给出可操作提示（而非崩溃）；AC-12.2 Node 不支持 zstd 时明确报错并给出版本要求。
- **优先级**：P0

### FR-13 团队共享（P2，本期不实现）

- 设计约束（先记录，避免未来返工）：自托管 Cloudflare Worker + D1；只同步聚合快照；非 E2E 加密需显式披露；默认关闭共享；≤32 设备；令牌哈希入库。**MVP 不做，仅保留接口抽象 `sync-adapter`。**

---

## 7. 非功能需求（NFR）

### 7.1 性能预算

| 场景 | 预算 | 说明 |
|---|---|---|
| 冷扫描（119 会话 / 103MB） | ≤ 8s | 单核，含 zstd 解码 |
| 热扫描（无变化） | ≤ 300ms | 缓存命中 |
| `/api/status` 热响应 | ≤ 300ms | 内存聚合 |
| 首屏可交互 | ≤ 1.5s | 本地服务 |
| 峰值内存 | ≤ 200MB | 扫描期间 |
| 增量文件数上限 | 4000 | 超出截断并提示 |

### 7.2 可靠性

- 只读原则：**never write to `~/.dsh`**（用测试守护：临时目录 + 只读断言）。
- 容错：单文件失败不影响全局；未知事件类型跳过；格式漂移触发降级视图。
- 降级矩阵：见 8.6。

### 7.3 安全

- 信任边界：本机用户即信任主体；**不监听 0.0.0.0**（默认 `127.0.0.1`）；无鉴权的本地 HTTP 仅绑定回环。
- 无密钥读取：默认不读任何凭据；余额模式仅在用户显式设置 `DEEPSEEK_API_KEY` 时读取环境变量，且**不落盘、不日志**。
- 输出脱敏：不显示对话正文；会话标题按需显示（可配置"标题打码"）。
- 依赖：零运行时依赖（Node 内置模块），降低供应链面。

### 7.4 隐私与合规

| 数据 | 分类 | 处理 |
|---|---|---|
| usage 数字 | L1 | 本地存储 |
| 会话标题/工作区名 | L2（可能含项目/客户名） | 本地存储；UI 可打码；不导出到小票外 |
| 对话正文/工具参数 | L3 | **不读取、不存储** |
| 凭据 | L4 | 不读取（余额模式仅内存使用 env） |
| 本地事件日志 | L1 | 可关闭/清空；永不上传 |

- 零遥测；数据出境：不适用（无上传）；用户可一键导出/删除全部本地数据。

### 7.5 兼容性

| 维度 | 要求 |
|---|---|
| OS | Windows 10+ / macOS 13+ / Linux（x64） |
| Node | ≥22.15（`node:zlib` zstd）；DSH 内置运行时优先 |
| DSH | 0.1.2-rc.1 起；`session v3/v4` 双支持；格式漂移检测 |
| 浏览器 | Chromium 120+ / Safari 17+ / Firefox 121+ |
| 无依赖 | 不引入 npm 运行时依赖 |

### 7.6 可访问性与 i18n

- a11y：语义化标签、`role="img"`+`aria-label`、焦点可见、对比度 ≥4.5:1、`prefers-reduced-motion`。
- i18n：中文优先，字符串集中管理（`src/i18n.mjs`），预留 en。

### 7.7 可维护性

- 模块边界：`core`（纯函数，无 IO）/ `io`（文件、HTTP）/ `ui`（web）/ `plugin`（DSH）。
- 测试即规格：核心算法必须有"公式 → 数值"测试；测试:源码行 ≥0.7:1。
- 政策版本号：`PACE_POLICY_VERSION`、`PLAN_POLICY_VERSION`、`FORECAST_POLICY_VERSION`、`COMFORT_FIT_VERSION`，改算法必须升版本。

---

## 8. 技术方案摘要（PRD 附录级）

### 8.1 架构

```
DSH 会话文件 (~/.dsh/sessions, 只读)
   │  zstd 多帧解码 + JSONL
   ▼
reader ──► collect(增量缓存) ──► aggregates(日/模型/工具/会话)
   │                                   │
   ├─ pricing(内置价表/覆盖) ──────────┤
   │                                   ▼
   └─ pace / plan / forecast / comfort(纯函数)
                                       │
                                       ▼
                              buildStatus() → JSON
                                 │            │
                          CLI   │            │  HTTP handler
                                 ▼            ▼
                         终端输出        Web 仪表盘 / DSH 插件(/dsh-cockpit)
```

### 8.2 数据模型

- `SessionSummary`：`{id, cwd, version, createdAt, title, delegationDepth, parentSession, byDay, byModel, tools, compactions, context, lastAt, firstAt}`
- `UsageRecord`：见 FR-1.3
- `Aggregate`：`{byDay: Record<date, Metrics>, byModel, byTool, totals}`
- `Metrics`：`{inputTokens, cacheReadTokens, cacheWriteTokens, outputTokens, reasoningTokens, totalTokens, costCny|null, messages}`
- `Config`：`{schemaVersion, budget:{mode,tokens,costCny,dayStartHour}, pricing, comfortMin, ui:{maskTitles,language}, server:{port,host}}`
- `State`：`{schemaVersion, files:{[key]:{size,mtimeMs,summary}}, lastScanAt, events:[]}`

### 8.3 算法规格（与参考产品同构）

| 算法 | 公式/规则 | 版本号 |
|---|---|---|
| 成本 | `cost = (uncached×in + cacheRead×cacheRead + cacheWrite×cacheWrite + output×out)/1e6`（¥/1M）；未知桶 → `null` | `PRICING_V1` |
| 配速 | 见 FR-3 | `PACE_V1` |
| 计划 | 见 FR-4 | `PLAN_V1` |
| 预测 | 见 FR-5 | `FORECAST_V1` |
| 舒适 | 见 FR-6 | `COMFORT_FIT_V1` |
| 日界 | Asia/Shanghai，`dayStartHour` 默认 4 | `DAY_V1` |

### 8.4 接口契约（HTTP）

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/status` | 首屏全量（见附录 B 示例） |
| GET | `/api/history?days=30` | 日序列 |
| GET/POST | `/api/config` | 读/写配置 |
| POST | `/api/comfort` | `{level:1-5, note?}` |
| GET | `/api/receipt?days=1` | 小票数据 |
| POST | `/api/rescan` | 强制重扫 |
| GET | `/api/health` | 健康与诊断 |

统一错误：`{ok:false, error:{code, message}}`，HTTP 4xx/5xx；**任何错误不得返回 0 值伪装**。

### 8.5 状态与缓存

- 缓存键 `path|size|mtimeMs`；`state.json` 原子写；启动时校验 `schemaVersion`，不匹配则重建缓存（不删用户数据）。
- 扫描并发：串行（磁盘 IO 主导），单文件超时 2s 跳过。

### 8.6 失败模式与降级矩阵

| 失败 | 表现 | 降级 |
|---|---|---|
| `~/.dsh` 不存在 | 无数据 | 显示空态 + 安装指引 |
| zstd 不支持 | 启动失败 | 明确报错 + Node 版本要求 |
| 会话格式漂移 | 部分字段缺失 | 降级视图 + `schemaDrift` 标记 |
| 余额 API 失败 | 余额不可用 | 回退预算模式 |
| 端口占用 | 启动失败 | 自动 +1 探测（最多 10 次） |
| 配置损坏 | 读取异常 | 备份 + 默认值 |

---

## 9. 交互与视觉规范

### 9.1 信息架构（IA）

```
驾驶舱（单页）
├── 顶栏：品牌 / 模式徽章 / 最后刷新 / 刷新 / 设置
├── 双环：周期用量 │ 上下文压力
├── 配速卡：on_track / over_pace / unknown
├── 今日建议卡：建议% + 三分解 + 风险%
├── 压缩预测卡：概率 / ETA / factors / gauge
├── 趋势（30d 柱 + 7d 均线）
├── 热力（84d）
├── 分布：模型 / 工具 / 会话 Top5
├── 舒适度：5 档记录 + 拟合曲线
└── 小票：生成 PNG（下载/剪贴板）
```

### 9.2 关键界面（P0）

| 界面 | 线框要点 | 状态 |
|---|---|---|
| U1 驾驶舱主屏 | 见 9.1；≥1280 三列 | 空/加载/正常/降级/错误 |
| U2 设置抽屉 | 预算模式、额度、价格表、打码开关、语言 | 保存中/成功/校验失败 |
| U3 小票预览 | 2× canvas，撕纸边 | 生成中/成功/剪贴板降级 |
| U4 CLI 输出 | 表格对齐、颜色可选、`--json` | — |
| U5 DSH 内页 | `/dsh-cockpit` 同源渲染 | 与 U1 一致 |
| U6 空态/首次引导 | 一键扫描按钮 + 数据目录提示 | — |

### 9.3 设计 tokens

| Token | 值 |
|---|---|
| 背景 | `#0b0f14`；卡片 `rgba(255,255,255,0.04)` + `backdrop-filter: blur(14px)` |
| 强调色 | 青 `#37e0c8`（健康）/ 紫 `#8b7cf6`（信息）/ 琥珀 `#f5b942`（预警）/ 红 `#f2545b`（超限） |
| 圆角 | 18–22px；边框 1px `rgba(255,255,255,0.08)` |
| 字体 | 系统栈；数字 `tabular-nums` |
| 动效 | ≤200ms ease-out；`prefers-reduced-motion` 关闭 |
| 间距 | 4px 网格 |

---

## 10. 验收与测试策略

### 10.1 Definition of Done

- [ ] 功能：本文 FR 的 AC 全部通过
- [ ] 测试：core 模块覆盖率 ≥80%；`npm test` 全绿
- [ ] 真实数据：119 会话扫描 `errors=0`，`messagesWithUsage ≥ 16000`
- [ ] 性能：8.1 预算达标（冷/热/内存）
- [ ] 安全：`audit:public` 通过（无真实数据/密钥进入仓库）
- [ ] 文档：README/AGENTS/MODEL/PRICING/PRIVACY/ARCHITECTURE/TEST-MATRIX 齐备
- [ ] 插件：DSH 内 `/dsh-cockpit` 可用并已在文档写明安装/卸载

### 10.2 测试矩阵

| 层 | 内容 | 工具 |
|---|---|---|
| 单元 | reader/pricing/pace/plan/forecast/comfort | `node:test` |
| 集成 | collect + buildStatus（合成 fixture） | `node:test` |
| 真实数据 | 119 会话冒烟（只读、脱敏断言） | `node:test` + 开关 |
| 性能 | 冷/热耗时、内存 | 内建计时 |
| 安全 | 只读断言、无密钥落盘、脱敏 | 专项测试 |
| 兼容 | v3/v4、截断文件、未知事件 | fixture 矩阵 |
| 前端 | 空态/错误态/断点/键盘 | 手工清单 + 可选 Playwright（P1） |

### 10.3 真实数据端到端验收脚本（拟）

```bash
node src/cli.mjs scan --json          # 断言 sessionsScanned=119, errors=0
node src/cli.mjs status --json        # 断言 quota/pace/plan/forecast 字段齐全
node src/cli.mjs doctor               # 断言 exit=0
node --test test/                     # 全绿
```

### 10.4 测试数据与隐私规则

- 仓库内**只允许合成 fixture**（伪造 session id/title/usage）；真实会话数据只在本机临时目录使用，`.gitignore` 排除。
- 测试中禁止打印真实标题/路径。

---

## 11. 风险登记册

| ID | 风险 | 概率 | 影响 | 缓解 | Owner |
|---|---|---|---|---|---|
| R1 | DSH 会话格式（v5）或 usage 字段变更 | 高 | 高 | 版本探测 + schema-drift 降级 + 适配层隔离；锁定测试基线 | 实现 |
| R2 | Cordis/插件 API 变更（rc 阶段） | 中 | 中 | 插件层薄（≤50 行）只依赖 `webServer.register`；CLI/Web 独立可用 | 实现 |
| R3 | 首次扫描慢/内存高 | 中 | 中 | 有界扫描 + 增量缓存 + 进度提示 | 实现 |
| R4 | 成本估算与真实账单偏差 | 高 | 中 | 价表可配 + 明确"估算非账单" + 显示价表核对日期 | 产品 |
| R5 | 预测不准（压缩预测为启发式） | 高 | 低 | 标注"非官方预测" + 置信说明 + 反馈日志 | 产品 |
| R6 | 本地 HTTP 端口暴露 | 低 | 中 | 只绑 127.0.0.1 + 无写接口默认 + CSRF 简单 token（P1） | 安全 |
| R7 | 隐私泄露（标题含客户名） | 中 | 高 | 标题打码开关 + 默认不导出标题到小票（可配） | 产品 |
| R8 | 单人维护/无人接手 | 中 | 中 | 文档+AGENTS+测试完备，降低接手成本 | 治理 |

---

## 12. 依赖与假设

| 类型 | 内容 | 校验方式 |
|---|---|---|
| 假设 | DSH 会话目录仍为 `~/.dsh/sessions` | `doctor` 探测 + 可配置 |
| 假设 | usage 语义 `total = input + cacheRead + cacheWrite + output` | 真实数据抽样校验 |
| 假设 | 用户接受"本地 HTTP + 浏览器"形态 | 决策 D1 |
| 依赖 | Node ≥22.15（zstd） | `doctor` |
| 依赖 | DSH 插件系统（仅插件模式） | 安装脚本 + 回滚 |

---

## 13. 发布与交付

### 13.1 交付物

| # | 交付物 | 形式 |
|---|---|---|
| 1 | 源码仓库（`dsh-cockpit/`） | ESM，零运行时依赖 |
| 2 | CLI | `npx dsh-cockpit` / 全局链接 |
| 3 | Web 仪表盘 | `web/`（零构建） |
| 4 | DSH 插件包 | `dsh-plugin/` + 安装脚本 |
| 5 | 文档包 | README/AGENTS/MODEL/PRICING/PRIVACY/ARCHITECTURE/TEST-MATRIX/CHANGELOG |
| 6 | CI | `.github/workflows/ci.yml` |

### 13.2 安装矩阵

| 方式 | 命令 | 说明 |
|---|---|---|
| 直接运行 | `node src/cli.mjs serve` | 无需安装 |
| 全局 | `npm link` / `npm i -g .` | `dsh-cockpit` 命令 |
| DSH 插件 | `dsh plugin --profile web add <path>` + 补丁 | 提供脚本与回滚 |

### 13.3 版本与回滚

- 语义化版本；`schemaVersion` 独立于产品版本。
- 回滚：插件卸载 + 删除 `~/.dsh-cockpit`；不触碰 DSH 数据。

---

## 14. 运营与支持

### 14.1 文档体系（复刻"AI 原生仓库"制作方法）

| 文档 | 面向 | 内容 |
|---|---|---|
| README.md | 人 | 定位、截图、快速开始、隐私声明、限制 |
| AGENTS.md | Agent | 任务路由、授权边界、禁止事项 |
| docs/MODEL.md | 人+Agent | 算法公式、参数、版本号、非目标 |
| docs/PRICING.md | 人 | 价表来源、核对日期、不可算项 |
| docs/ARCHITECTURE.md | 开发者 | 模块边界、数据流、失败矩阵 |
| docs/PRIVACY.md | 合规 | 数据分级、采集范围、零遥测 |
| docs/TEST-MATRIX.md | 质量 | 自动化 vs 人工清单 |
| docs/USER-GUIDE.md | 用户 | 三步上手、FAQ |
| CHANGELOG.md | 维护 | 版本记录 |

### 14.2 排障剧本（FAQ 十问）

1. 打开是空白 → 检查 `dsh-cockpit doctor`；端口占用会自动 +1。
2. 数字为 0 → 是否有 DSH 会话；是否 `~/.dsh/sessions` 为空。
3. 金额显示"—" → 未知模型/缺 usage 桶（设计如此）。
4. 扫描很慢 → 首次正常，二次走缓存；可看 `health.durationMs`。
5. 预测不准 → 启发式，仅供参考；可记录反馈。
6. 插件 404 → 确认 profile 与 patch 生效；`dsh --dump-config` 检查。
7. 升级 DSH 后数据异常 → 看 `schemaDrift`；等待适配版本。
8. 想隐藏项目名 → 设置"标题打码"。
9. 如何卸载 → `dsh plugin --profile web remove ...` + 删目录。
10. 会不会上传数据 → 不会；无网络出口（余额模式除外）。

### 14.3 反馈流程

- 本地 `dsh-cockpit report --md` 生成脱敏报告用于 issue；禁止粘贴真实会话/密钥。

---

## 15. 决策记录与待确认清单（**需你逐条确认**）

| ID | 决策点 | 选项 | 推荐 | 影响 |
|---|---|---|---|---|
| **D1** | 交付形态 | A) CLI+Web 独立（推荐先做）B) 仅 DSH 插件 C) 两者同版 | **C**（Web/CLI 为主，插件薄封装） | 决定 M1–M3 顺序 |
| **D2** | "额度"主口径 | A) 自设预算（推荐）B) 账户余额 C) 上下文窗口 D) 三口径并存 | **D**（默认 A，可切 C；B 可选） | 决定 FR-2 复杂度 |
| **D3** | 数据读取 | A) 仅 `~/.dsh/sessions`（只读）B) 也读 projcache/storages | **A** | 隐私面与兼容性 |
| **D4** | 团队共享 | A) MVP 不做，P2 再做 B) 进 MVP | **A** | 工期 +3~5 天 |
| **D5** | 价格表 | A) 内置参考价（¥/1M，标注 provisional）+ 可配 B) 仅用户配置 | **A** | 首次体验 vs 准确性 |
| **D6** | 遥测/度量 | A) 零遥测 + 本地事件日志（推荐）B) 完全无日志 | **A** | 可度量性 |
| **D7** | 语言 | A) 中文优先 + i18n 结构预留 B) 仅中文 C) 中英双语 | **A** | 工作量 |
| **D8** | 会话标题 | A) 显示但可打码 B) 默认打码 C) 不显示 | **A** | 可用性 vs 隐私 |

> **请回复**：`D1=A, D2=D, D3=A, D4=A, D5=A, D6=A, D7=A, D8=A` 这类形式（可直接全部采纳推荐）。确认后我按 M1→M4 顺序开工。

---

## 16. 与 Codex Cockpit 的逐步对照与依据溯源（Traceability）

> 本章回答一个问题：**这份 PRD 的每一步，凭什么这么写？** 每一条都能回溯到参考产品的具体代码、配置、文档或实测数据，或明确标注为"因 DSH 现实而改造"。这不是致敬章节，而是设计审计轨迹。

### 16.1 溯源方法与依据强度分级

| 项 | 做法 | 产出/位置 |
|---|---|---|
| 源码取证 | 克隆 + 逐文件抓取 293 个文本文件，与仓库 git tree 逐字节校验 **SHA-1 293/293 一致** | `codex-cockpit-research/repo/` |
| 专项评审 | 四路并行深潜：前端 / Rust 原生层 / 安全合规 / 工程运营 | `codex-cockpit-research/reports/*.md` |
| 实测 | 前端 vitest 实跑 79 文件 / **595 用例 / 588 通过**；Rust 220 个 `#[test]` 静态统计 | `reports/_test-run.txt` |
| 元数据 | Releases / 贡献者 / issues / tags / 语言构成 | `codex-cockpit-research/meta/*.json` |

**依据强度分级**（本章所有结论标注等级）：

| 等级 | 含义 | 例 |
|---|---|---|
| **A** | 代码级实证：读过源文件具体行 | `quotaPace.ts:172-176` 配速公式 |
| **B** | 配置/文档级实证 | `TEST-MATRIX.md:32-40` 自动化 vs 人工双栏 |
| **C** | 工程判断/推断（需实测验证） | "压缩预测对用户有价值" |

### 16.2 章节级对照：PRD 每一章从哪来

| PRD 章节 | Codex Cockpit 的依据 | 迁移动作 |
|---|---|---|
| 0 文档控制 | 参考产品 `docs/PROJECT-SUMMARY.md` 的"一页说清边界"写法（A） | 直接复刻"先声明边界"的文档习惯 |
| 1 背景与问题 | README 定位（"额度焦虑"）+ 实际下载画像（Windows exe 占 69–75%）（A/B） | 把"额度焦虑"翻译成 DSH 的"token/成本/上下文不可见" |
| 2 目标与非目标 | 参考产品明确"不是 OpenAI 官方产品""不能增加额度"（B） | 复刻"诚实非目标"结构 |
| 3 用户与场景 | 参考产品真实用户画像（个人开发者为主、13 forks、3057 下载）（A） | 画像从 Windows 桌面用户改为 DSH 用户 |
| 4 竞品与差异化 | 我做的竞品矩阵（CodexBar 22.9k★ / ccusage / 上游 Quota Float）（A） | DSH 侧无同类，差异化改为"原生插件 + 上下文视角" |
| 5 范围与版本 | 参考产品 v0.3.0-beta.1 → v0.3.5 的能力演进节奏（A） | 取其"先本地、后团队"的版本策略 |
| 6 功能需求 | 逐条移植/改造（见 16.3）（A） | 13 个 FR，标注保真度 |
| 7 非功能需求 | 有界采集参数（`codex_project_usage.rs:18-25`）、只读边界、三时区测试（A） | 参数级照搬，场景改为本地扫描 |
| 8 技术方案 | 三层架构 + 领域层纯函数 + IPC 治理（`bridge.ts`）（A） | IPC 改为 HTTP handler；领域层 1:1 |
| 9 交互与视觉 | 双环（`QuotaCard.tsx`）、热力日历（`UsageCalendar`）、小票（`customTaskCard.ts`）（A） | 保留信息架构，重写为 Web/DOM 实现 |
| 10 验收与测试 | `TEST-MATRIX.md` 双栏 + "CI 绿≠GUI 通过"（B）；595/220 用例规模（A） | 复刻矩阵结构，缩小规模 |
| 11 风险登记册 | 我的安全评审 3 项 High + bus factor=1 + 无 PR CI（A） | 反向输入：本产品规避同类风险 |
| 12 依赖与假设 | 参考产品依赖 Codex CLI 登录态（`codex.rs:69`）（A） | 改为依赖 DSH 会话目录 |
| 13 发布与交付 | `release.yml` 三段式 + 六源版本一致性 + 制品断言（A） | 简化：纯 Node 无跨平台构建，保留"验证先于发布" |
| 14 运营与支持 | 26 篇 docs + 双 Skill + `AGENTS.md` 授权模型（A/B） | 复刻"AI 原生仓库"文档体系 |
| 15 决策记录 | 见 16.8 逐条溯源 | — |

### 16.3 功能级对照：13 个 FR 的保真度

> 保真度：**移植**（思想/公式 1:1）｜**改造**（因 DSH 数据现实而变）｜**新增**（参考产品没有）｜**不采纳**。

| FR | Codex Cockpit 的对应实现 | 本产品做法 | 保真度 | 关键差异与依据 |
|---|---|---|---|---|
| FR-1 采集与归因 | `codex_project_usage.rs`：有界只读扫描、`Counts::delta` 累计差分、fork 去重、`session_index.jsonl` 任务名（A） | 有界只读扫描 + zstd 多帧解码 + usage 归因 | **改造** | **关键差异**：DSH 的 `assistant/message.usage` 已是"单次桶"，**不需要累计差分**；但新增了 zstd 帧容器（2269 帧/文件）与 v3/v4 双版本 |
| FR-2 额度账本 | `codex.rs:23` `wham/usage` + `rate_limits.primary/secondary`（A） | 预算 / 余额 / 上下文三口径 | **改造** | DSH 无官方额度 API（实测仅 `request/context.contextWindow`）→ 以"预算"为主口径 |
| FR-3 配速 | `quotaPace.ts:172-176` 线性推荐 + 容差（A） | 同公式 | **移植** | 参数照搬：调度容差 0.5%、时钟容差 2 分钟 |
| FR-4 今日计划 | `dynamicQuota.ts:154-157` uniform+p²+softCap（A） | 同公式（knee 可被舒适度覆盖） | **移植** | `p` 的语义改为"压缩概率" |
| FR-5 压缩预测 | `reset_forecast.rs:166-271` 校准风险 + 星期先验 + clamp[2,95]（A） | 压力 sigmoid + 历史校准 + ETA | **改造** | "重置" → "压缩"（DSH 的 `compaction/*` 事件是真实重置点） |
| FR-6 舒适度 | `comfortFeedback.ts`（`COMFORT_FIT_VERSION=p020-fixed-score-k-v6`）+ 14 天半衰期（A） | 5 档记录 + 拟合 k 回灌计划 | **移植** | 目标函数改为"体感等级 → 效率" |
| FR-7 仪表盘 | `QuotaCard.tsx` 双环 / 趋势 / 热力 / 分布（A） | Web 单页（零构建） | **改造** | 不用 Tauri；可被 DSH 插件同源托管 |
| FR-8 小票 | `customTaskCard.ts:27,105` canvas 2× + `ClipboardItem`（A） | 同方案 | **移植** | — |
| FR-9 CLI | 参考产品无 CLI（B） | 8 条命令 + `--json` | **新增** | 为脚本化/CI 与无 GUI 场景 |
| FR-10 DSH 插件 | 参考产品是独立 App（B） | Cordis 插件 + `webServer.register` | **新增** | 借鉴其 `capabilities/default.json` 的**最小权限**思想 |
| FR-11 配置 | `preferences.ts` 逐字段归一化 + 迁移（A） | 版本化 schema + 原子写 + 损坏备份 | **移植** | 同"不可信输入"防御 |
| FR-12 诊断 | `AppDiagnostics` + `audit:public` + `doctor` 思路（A/B） | `health` 字段 + `doctor` 命令 | **改造** | 增加 `schemaDrift`/`unknownEventTypes` |
| FR-13 团队共享 | `cloud/usage-sync-worker`（296 行 + 4 迁移 + 9 测试）+ `SYNC-CONTRACT-V2`（A） | **MVP 不做**，仅留 `sync-adapter` 抽象 | **不采纳（本期）** | 其安全评审 3 项 High 均与共享数据相关（见 16.8 D4） |

### 16.4 算法级对照：公式怎么来的

| 算法 | 参考实现（行号） | 原公式/规则 | DSH 适配 | 保真度 | 验收对应 |
|---|---|---|---|---|---|
| 成本估算 | `codex_project_usage.rs:701-719`；`LOCAL-PRICING.md:37-49` | `(非缓存输入×输入价 + 缓存读×缓存价 + 输出×输出价)/1e6`；>272k 长上下文倍率 | 保留三档；**删除 272k 倍率**（DeepSeek 无此档） | 改造 | FR-2 / AC-2.2 |
| 配速 | `quotaPace.ts:126-212` | `recommended = cycleStartUsed + cycleStartRemaining × elapsed/total`；`dailyBudget = remaining × horizon/remainingMs`；超速 >0.5% 判 over | 同构；周期来自预算配置 | **移植** | FR-3 / AC-3.1 |
| 计划 | `dynamicQuota.ts:149-165` | `uniform=R/(d+1)`；`boost=max(0,R-uniform)×p²`；`softCap=knee×(1+1.5p)×周末0.75`；取 min | 同构；`p`=压缩概率；`knee` 由舒适度覆盖 | **移植** | FR-4 / AC-4.1 |
| 风险前移 | `dynamicQuota.ts:155` | `p²` 前移未来额度 | 同构 | **移植** | FR-4 |
| 星期先验 | `dynamicQuota.ts:6` | `[0.1,0.7,0.1,0.1,0.1,0.7,0.1]` | 改为"压缩星期风险"先验 | 改造 | FR-5 |
| 重置概率→时间 | `quotaPace.ts:37-53` | `E = p×min(保证剩余, 窗口/2) + (1−p)×保证剩余` | 改为 ETA = `(0.92×contextWindow − pressure)/增长速率` | 改造 | FR-5 / AC-5.3 |
| 风险校准 | `reset_forecast.rs:166-271` | 基础概率 + 经验校准 ±12 + 星期调整 + clamp[2,95] | 同结构，输入换成压力比与压缩历史 | 改造 | FR-5 / AC-5.4 |
| 舒适曲线 | `dynamicQuota.ts:200-230` `smoothKneeEfficiency`；`comfortFeedback.ts` | `η(x;k)=exp(−sharpness·((x−k)/(1−k))^power)`；加权拟合 k；14 天半衰期 | 同构（softplus 膝点简化为幂次膝点） | 移植/简化 | FR-6 / AC-6.1 |
| 缺失≠0 | `codex_project_usage.rs:2027-2038,1491-1505` | `missing_model_price` 与 `cost_context_unavailable` 分开；仅 `total==0` 才置 `Some(0)` | 成本 `null` + `partial` 标记 | **移植（语义）** | FR-1 / AC-1.x |
| 日界 | `usageDay.ts`（Intl `Asia/Shanghai` + 04:00） | 自然日与 04:00 使用日双口径 | 保留：统计用自然日，周期用 `dayStartHour` | **移植** | NFR / FR-2 |
| 有界采集 | `codex_project_usage.rs:18-25` | 4000 文件 / 256MB / 单行 2MB / 8s / 1 万行元数据 | 参数级照搬（见 NFR 7.1） | **移植** | NFR 7.1 |

### 16.5 数据链路对照：三条链路如何映射

| 参考产品链路 | 实现位置 | DSH 对应链路 | 差异 |
|---|---|---|---|
| ① 官方额度 API | `codex.rs:23` `wham/usage` + Bearer（A） | **无对应**（DSH 无公开额度 API） | 以"预算/余额"替代 |
| ② 本地 CLI 兜底 | `codex.rs:641-700` `codex app-server --stdio` JSON-RPC（A） | **无对应** | DSH 无等价本地守护协议 |
| ③ 会话内嵌快照 | `codex.rs:168-206` 从 `token_count.rate_limits` 反推（A） | ✅ `assistant/message.usage` + `request/context`（实测 16,036 条） | 主链路；且 DSH 的 usage 是权威单次桶 |
| ④ 第三方预测 | `website_reset_probability.rs` + `reset_forecast.rs`（A） | ✅ 本地压缩历史（`compaction/prune` 含 `shadowedTokenCount`） | **自给自足**，无需第三方网络 |
| ⑤ 凭证读取 | `codex.rs:69` 读 `~/.codex/auth.json`（A） | ❌ 不读任何凭据 | 隐私增强：余额模式仅读 env |

> **结论**：参考产品是"三链路冗余"，本产品是"单链路 + 自校准"。这带来一个明确取舍——**不依赖网络、不碰凭据（隐私更好），但缺少独立的官方真值校验**（成本永远是估算）。PRD 7.4 与 11(R4) 已记录该取舍。

### 16.6 工程方法对照：制作方法怎么复刻

| 参考产品的做法 | 证据 | 本产品对应 | 说明 |
|---|---|---|---|
| 文档驱动（26 篇 docs） | `docs/` 26 篇（A） | 8 篇核心文档（按规模等比缩小） | 保留"分类 + 索引 + 边界声明"结构 |
| `AGENTS.md` = 授权边界 | "commit/push/tag/release/signing 是独立授权边界"（B） | 1:1 复刻，并加"禁止粘贴真实会话" | 面向 Agent 的第一入口 |
| 双 Skill（支持 / 部署） | `skills/codex-cockpit` + `skills/cloudflare-sync`（A） | MVP 先 `AGENTS.md`+docs；P1 补 `skills/dsh-cockpit/SKILL.md` | 团队共享未做，故部署 Skill 推迟 |
| `TEST-MATRIX.md` 双栏 | "Automated checks / Manual checks still required"（B:32-40） | 1:1 复刻结构 + "CI 绿 ≠ 人工验收通过" | 避免虚假质量信号 |
| `audit:public` 防泄漏扫描 | `scripts/audit-public.mjs`（A） | 复刻：扫描真实路径/密钥/大文件/真实会话 id | 发布前门禁 |
| 六源版本一致性 | `release.mjs` 校验 package/lock/Cargo/tauri 等（A） | 复刻：package.json / PRD / CHANGELOG 一致性 | 本产品无多语言构建，源数减少 |
| 三段式 CI 门禁 | `release.yml:14-171`（A） | 简化为单段 CI（verify） | 保留"验证先于发布"的时序 |
| 三时区测试 | `release.yml:16-20`（A） | 保留 `Asia/Shanghai` + `UTC` 断言日界 | 日界算法必须时区无关可测 |
| 政策版本号 | `DYNAMIC_POLICY_VERSION=p020-t027-…`（A） | `PACE_V1/PLAN_V1/FORECAST_V1/COMFORT_FIT_V1` | 改算法必须升版本 + 跑旧用例 |
| 有界采集参数 | `codex_project_usage.rs:18-25`（A） | 1:1（4000 文件 / 8s / 2MB 行） | 防御式解析 |
| 制品数量断言 | `release.yml:149-152`（A） | 复刻到"验收脚本断言" | 防止"发了但缺件" |
| 诚实限制声明 | `SECURITY.md:5` "not a production security review"（B） | README/PRIVACY 主动写"估算非账单""预测非官方" | 复刻"不美化"文风 |

### 16.7 制作步骤对照：M0–M4 每一步用到什么

| 步骤 | 参考产品的输入 | 本步产出 | 验收依据 |
|---|---|---|---|
| **M0 PRD** | `PROJECT-SUMMARY.md`（边界写法）+ `TEST-MATRIX.md`（验收结构）+ 我的四份评审 | 本文档 | 你确认 D1–D8 |
| **M1 核心引擎** | `quotaPace.ts` / `dynamicQuota.ts` / `reset_forecast.rs` / `comfortFeedback.ts` / `codex_project_usage.rs`（公式与参数） | `src/core/*`（纯函数）+ 单元测试 | 公式数值测试 + 真实 119 会话扫描 |
| **M2 仪表盘** | `QuotaCard.tsx`（双环）、`UsageCalendar`（热力）、`customTaskCard.ts`（小票）、`DailyUsageTrend`（趋势） | `web/`（零构建单页） | 首屏 6 区 + 空态/错误态 + 性能预算 |
| **M3 集成** | `capabilities/default.json`（最小权限）+ `README.md:69-84`（Agent 安装提示词） | CLI + DSH 插件 + 安装/卸载脚本 | `/dsh-cockpit` 可访问 + CLI 8 命令 |
| **M4 硬化** | `release.yml`（门禁）、`audit-public.mjs`、`TEST-MATRIX.md` | CI + 审计脚本 + 全套文档 | DoD 清单（10.1） |

### 16.8 决策级对照：D1–D8 的推荐值是怎么推出来的

| 决策 | 推荐 | 依据（参考产品的具体事实或教训） |
|---|---|---|
| **D1** 形态 | CLI+Web 为主，插件薄封装 | 参考产品用 Tauri 独立 App 成功（196★ / 3057 下载，A），证明"仪表盘形态"有效；但 DSH 自带 Web GUI 与 Cordis 插件，**再做桌面壳是重复投入**（C） |
| **D2** 额度口径 | 预算为主，余额/上下文并存 | 参考产品是"官方额度 + 本地历史 + 第三方预测"三链路（A）→ 多口径并存被验证可行；DSH 缺官方链路，故以预算兜底 |
| **D3** 只读 | 仅读 `~/.dsh/sessions` | `AGENTS.md` 明确"local-first credential boundary、只读"（B）；`PRIVACY.md` 明示采集范围（A） |
| **D4** 团队共享 | MVP 不做 | 其 Worker 复杂（296 行 + 4 迁移 + 9 测试，A），且安全评审 3 项 High **全部与共享数据相关**（默认开启、明文 D1、无保留期，A）→ 不在 MVP 重犯 |
| **D5** 内置价表 | 内置参考价 + 可配 | `LOCAL-PRICING.md` 的教训："旧测试包只带少量模型价格 → 新安装只看到 Token 没有金额"（B）→ 必须内置默认值 |
| **D6** 零遥测 + 本地日志 | 采纳 | `PRIVACY.md:19` "No dedicated analytics telemetry"（A）+ 我需要在无遥测下度量（C） |
| **D7** 中文优先 | 采纳 | 真实下载画像 Windows 个人开发者占 69–75%（A）；参考产品把"北京时间日界"做成一等公民（A） |
| **D8** 标题可打码 | 采纳 | `PRIVACY` 主动披露"任务标题可能含客户名"（B）+ 安全评审指出默认开启共享任务明细（A） |

### 16.9 明确不采纳清单（反模式，避免照抄缺陷）

| 参考产品的问题 | 证据 | 本产品的处理 |
|---|---|---|
| 巨型组件 | `App.tsx` 1,204 行 / 27 useState / 单次传 56 props；`QuotaCard.tsx` 1,377 行（A） | 前端按卡片组件化，禁止单文件 >400 行 |
| i18n 三套并行 | 439 处 `zh ?` 内联三元 + 字典 + 自建 labels（A） | 统一 `i18n.mjs`，禁止内联三元 |
| 无 PR 级 CI | 仅 tag 触发的 `release.yml`（A） | 第一步建 `ci.yml`（push/PR） |
| 无 lint/格式化/覆盖率 | 全树无 eslint/prettier/coverage（A） | 预留 lint 脚本 + 覆盖率门禁（P1） |
| 任意路径 IPC | `export/import_app_data` 接受任意路径（A，我已亲自核验） | 导出/导入固定目录 + 白名单 + 大小上限 |
| 字符串错误 | 158 处 `Result<_, String>`（A） | 错误码 + 结构化错误对象 |
| 未签名/未公证分发 | Mac ad-hoc、Windows 无 Authenticode（A） | 本地工具无需分发签名；如分发明确声明（C） |
| bus factor=1 | 4 贡献者，作者占 89% commits（A） | 文档 + AGENTS + 测试降低接手成本（C） |

### 16.10 依据强度与待验证项

| 类别 | 结论 | 强度 | 验证方式 |
|---|---|---|---|
| 配速/计划/预测/舒适公式 | 可移植且数学自洽 | A | M1 数值测试 |
| 有界采集参数 | 可照搬 | A | NFR 性能实测 |
| DSH usage 语义（total=input+cacheRead+output） | 已用 16,036 条真实数据抽样验证 | A | M1 真实扫描断言 |
| 压缩预测的业务价值 | "提前知道会被压缩"有助于收尾 | **C** | M2 后自用 2 周反馈 |
| 成本估算与真实账单一致性 | 仅估算 | **C** | 与 DeepSeek 账单对照（R4） |
| 插件 API 稳定性 | rc 阶段可能变 | **C** | 安装冒烟 + 回滚脚本 |
| 余额 API 可用性 | 需用户自备 Key，非默认路径 | **C** | 可选功能，失败降级 |

### 16.11 反向收益：把参考产品的"缺陷"变成设计输入

1. **三项 High 安全发现 → 本产品零网络出口、零凭据读取、零运行时依赖**（供应链面最小化）。
2. **无 PR CI → M4 之前先建 CI**（顺序反过来）。
3. **stringly 错误 → core 层统一错误码**，UI 可分类展示。
4. **bus factor=1 → 文档/AGENTS/Skill 成为一等交付物**，而不是附属品。
5. **证据替代签名身份的教训 → 本产品不承诺"生产级安全"，只承诺"可审计的本地只读"**（诚实边界）。

> **一句话**：Codex Cockpit 给了我们**被验证过的产品模型与算法内核**，我和它的对照关系是"**移植内核、改造数据层、拒绝其工程反模式、复刻其制作方法**"。

---

## 17. 附录

### 附录 A 术语全表
（略：见 0.4，正式版补齐 30 个术语）

### 附录 B `/api/status` 示例（契约基线）
（略：与 8.4 及前端契约一致，正式版内联完整 JSON）

### 附录 C 参考与证据
- 参考产品：Codex Cockpit v0.3.5（`HouSiyuan2001/codex-cockpit`，MIT）
- DSH 版本：`@deepseek-ai/dsh@0.1.2-rc.1`
- 官方包内证据：`dsh-token-meter`（usage 投影）、`dsh-session-persistence-jsonl`（zstd 格式）
- 本地实测：119 会话 / 102.7MB / 102,293 事件 / 16,036 条 usage

### 附录 D 评审检查表（Review Checklist）
- [ ] 目标与非目标是否清晰、可验收
- [ ] 每个 FR 是否有 AC
- [ ] NFR 是否有量化预算
- [ ] 风险是否有缓解与 owner
- [ ] 决策点是否全部确认
- [ ] 隐私边界是否可被测试守护

---

**下一步**：等你确认 15 章（D1–D8）。确认后我立即进入 M1（核心引擎），并按里程碑交付；任何范围变更走本文档修订历史。
