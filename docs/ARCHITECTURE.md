# 架构（ARCHITECTURE）

## 1. 分层

```
┌───────────────────────────────────────────────────────────────┐
│ 表现层                                                         │
│   终端：src/cli.mjs          Web：web/（零构建单页）            │
│   DSH：dsh-plugin/index.js（Cordis，挂 /dsh-cockpit）           │
├───────────────────────────────────────────────────────────────┤
│ 接口层  src/server.mjs  ← 同一 handler 服务 CLI/插件/测试        │
├───────────────────────────────────────────────────────────────┤
│ 编排层  src/core/index.mjs  buildStatus() / buildReceipt()      │
├───────────────────────────────────────────────────────────────┤
│ 领域层（纯函数，可单测）                                         │
│   pricing / pace / plan / forecast / comfort / time / collect    │
├───────────────────────────────────────────────────────────────┤
│ IO 层（唯一有副作用的地方）                                      │
│   session-reader（只读 DSH）  config/state（原子写驾驶舱目录）    │
└───────────────────────────────────────────────────────────────┘
```

**唯一数据流**：会话文件 → 摘要（增量缓存）→ 周期聚合 → 配额/配速/计划/预测 → JSON → 三种表现层。
CLI 与 Web 消费**同一份 JSON**，不存在两套口径。

## 2. DSH 会话格式（关键实现知识）

- 路径：`~/.dsh/sessions/<project-slug>/<session-dir>/session.v{3,4}.jsonl[.zstd]`
- `.zstd` 是**连续多帧容器**（单文件可达 2,000+ 帧，每帧是一次 append-batch），尾部可能跟随明文 JSON 行。
  一次性 `zstdDecompress` 只能解第一帧 → 必须扫描 magic(`28 B5 2F FD`) 逐帧解压（`session-reader.mjs`）。
- 关键事件：
  | 事件 | 用途 |
  |---|---|
  | `session` | 头：id / cwd / createdAt / delegationDepth / parentSession |
  | `session/title` | 会话标题（任务归因，可打码） |
  | `request/context` | provider / model / contextWindow（1,048,576） |
  | `assistant/message` | `data.usage` 四桶 + `message.source.model` |
  | `tool/call` | 工具名（分布统计） |
  | `compaction/prune` | `shadowedTokenCount`（压缩 = 重置事件） |
  | `subagent/catalog` | 子代理关系（P1 用于树状归因） |

**只读保证**：`session-reader.mjs` 不 import 任何写 API；测试有只读断言。

## 3. 增量缓存

- 键：`path|size|mtimeMs`；命中直接复用 `summary`（`state.json`）。
- 首次全量 5.3s / 命中 0.13s（124 会话、约 110MB）。
- 缓存损坏或 `schemaVersion` 不匹配 → 全量重扫，**不删用户配置/舒适度**。

## 4. HTTP API（`src/server.mjs`）

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/status` | 首屏全量（可 `?force=1` 强制重扫） |
| GET | `/api/history?days=30` | 日序列 |
| GET/POST | `/api/config` | 读/写（合并式保存） |
| POST | `/api/comfort` | `{level:1-5,note?}` |
| GET | `/api/receipt` | 小票数据 |
| POST | `/api/rescan` | 强制重扫 |
| GET | `/api/health` | 健康与版本 |

安全：只绑 `127.0.0.1`；POST 校验 `Origin` 为本机；请求体 ≤256KB；静态资源路径穿越拦截。
`mountBase` 参数让同一 handler 既服务根路径（CLI）也服务 `/dsh-cockpit`（插件）；HTML 注入 `window.__COCKPIT_BASE__`。

## 5. 目录结构

```
dsh-cockpit/
├── src/core/          纯函数与 IO（见上）
├── src/cli.mjs        9 个命令
├── src/server.mjs     HTTP handler + startServer
├── web/               index.html / app.js / styles.css（零构建）
├── dsh-plugin/        Cordis 插件薄封装
├── scripts/           audit-public.mjs（发布前审计）
├── test/              node:test（单元 + 集成 + HTTP）
└── docs/              PRD / MODEL / PRICING / PRIVACY / ARCHITECTURE / TEST-MATRIX / USER-GUIDE / DECISIONS
```

## 6. 失败矩阵

| 失败 | 行为 |
|---|---|
| `~/.dsh` 不存在 | 空态 + 指引；`doctor` 给出具体路径 |
| Node < 22.15 | `ZSTD_UNSUPPORTED` 结构化错误，给出最低版本 |
| 单会话损坏/超大 | 跳过并计入 `health.errors`，其余正常 |
| 格式漂移（未知事件） | 忽略未知类型，计数留痕（P1 扩展 `unknownEventTypes`） |
| 配置损坏 | 备份 `.corrupt-<ts>` 后回退默认 |
| 端口占用 | 自动 +1 探测（最多 10 次） |
| 余额 API 失败 | 回退预算模式 + 警告，不显示 0 余额 |
