# API v2 契约（并行开发基线）

> 版本：v2-final ｜ 日期：2026-11-04
> 状态：**已实现并冻结**（Web / CLI / 同步均按此对齐；v1 字段全部保留）。

## 0. 通用

- Base：独立服务 `http://127.0.0.1:<port>`；DSH 插件挂载在 `/dsh-cockpit`（前端通过 `window.__COCKPIT_BASE__` 拼接）。
- 编码：JSON，UTF-8；时间：ISO-8601 带时区（`2026-11-03T04:00:00+08:00`）。
- 错误：`{ "ok": false, "error": { "code": "...", "message": "..." } }`，HTTP 4xx/5xx。
- 缺失数据一律 `null` / 省略，**禁止**用 0 伪装（缺失≠0）。
- 新增字段只增不改；破坏性变更升 `/api/v3`。

## 1. 通用查询参数（status / history / tasks / projects / insights / receipt / calendar / riskmap）

| 参数 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `range` | string | `cycle` | `cycle`（当前预算周期）｜`today`｜`7d`｜`30d`｜`90d`｜`all`｜`custom` |
| `from` / `to` | `YYYY-MM-DD` | — | 仅 `range=custom` 时必填；按使用日（04:00 换日）闭区间 |
| `model` | string | 全部 | 模型名过滤 |
| `task` | string | 全部 | 任务 key（`/api/tasks` 返回的 `key`） |
| `project` | string | 全部 | 工作区 slug 过滤 |
| `includeSubagents` | bool | `true` | 是否计入子代理会话（`delegationDepth > 0`） |
| `tz` | string | `Asia/Shanghai` | 预留，当前固定 |

## 2. `GET /api/status`

在 v1 基础上追加：

```jsonc
{
  "range": { "kind": "cycle", "start": "ISO", "end": "ISO", "startDate": "2026-11-03", "endDate": "2026-11-03", "label": "今日" },
  "quota": { "...v1 字段...", "isDefaultBudget": true, "dailyCapPercent": 90 },
  "plan": { "...v1...", "dailyCapPercent": 90, "dayTotalPercent": 100 },
  "riskMap": {                       // 配速×风险二维（新增，直接内联，避免多一次请求）
    "current": { "pacePercent": 61.7, "riskPercent": 34 },
    "x": { "min": 0, "max": 120, "label": "配速（已用/建议 %）" },
    "y": { "min": 0, "max": 100, "label": "压缩风险 %" },
    "cells": [ { "x": 50, "y": 25, "suggestedPercent": 40.2 } ]
  },
  "notifications": { "alerts": [ { "id": "budget-warn", "level": "warn|critical|info", "title": "...", "body": "...", "metric": 88.5 } ], "unread": 1 },
  "insights": [ { "id": "dominant-task", "severity": "info|warn", "title": "...", "body": "...", "action": "open-tasks" } ],
  "comfort": { "...v1...", "binned": [ { "bin": "0-20", "avgLevel": 2.1, "count": 4, "efficiency": 0.9 } ], "calendar": [ { "date": "2026-11-03", "level": 3, "tokens": 123, "status": "on_track" } ] },
  "health": { "...v1...", "rangeSessions": 12 }
}
```

> `quota/pace/plan` 始终基于**预算周期**（不随 `range` 变）；`range` 只影响 `totals/breakdown/insights/notifications/comfort` 的统计范围，并在 `range` 字段回显。

## 3. `GET /api/history`

```
?days=30&from&to&range
→ { "range": {...}, "days": [ { "date": "YYYY-MM-DD", "tokens": 0, "costCny": 0, "comfort": null, "status": "on_track|over_pace|unknown", "messages": 0 } ] }
```
`range` 优先于 `days`。

## 4. `GET /api/tasks`（新增，任务级归因）

```
?range&model&project&q&sort=tokens|cost|messages|lastAt&order=desc|asc&page=1&pageSize=20&includeSubagents
→ {
  "range": {...},
  "items": [ {
    "key": "任务稳定 key（sha1 前缀或 slug）",
    "title": "任务标题（可按配置打码）",
    "project": "workspace-slug",
    "models": ["deepseek-flash"],
    "tokens": 123456,
    "costCny": 1.23,
    "messages": 42,
    "lastAt": "ISO",
    "sharePercent": 31.2,
    "subagentTokens": 1234,
    "isSubagent": false
  } ],
  "total": 37, "page": 1, "pageSize": 20
}
```

## 5. `GET /api/projects`（新增，工作区维度）

```
?range…… → { "items": [ { "project": "--workspace--", "tokens": 0, "costCny": 0, "sessions": 3, "tasks": 5, "lastAt": "ISO" } ], "total": 4 }
```

## 6. `GET /api/subagents`（新增，子代理树）

```
?range → { "items": [ { "parentSessionId": "...", "parentTitle": "...", "children": [ { "sessionId": "...", "title": "...", "depth": 1, "tokens": 0, "costCny": 0, "lastAt": "ISO" } ] } ], "orphans": [] }
```

## 7. `GET /api/insights`

```
?range → { "items": [ { "id": "dominant-task|cost-spike|context-high|comfort-low|idle|budget-pace", "severity": "info|warn", "title": "...", "body": "...", "metric": 0.0, "action": "open-tasks|open-calendar|open-settings" } ] }
```

## 8. `GET /api/calendar`

```
?month=YYYY-MM（默认当前月）&project&model
→ { "month": "2026-11", "days": [ { "date": "YYYY-MM-DD", "tokens": 0, "costCny": 0, "comfort": null, "sessions": 0, "topTasks": [ { "title": "...", "tokens": 0 } ], "topModels": [ { "model": "...", "tokens": 0 } ] } ] }
```

## 9. `GET /api/receipt` / `POST /api/receipt`

GET 参数：`range|from|to|days|tasks=key1,key2|models=x,y|title`
POST body：同 GET 参数（用于长选择列表）。

```jsonc
{
  "title": "DSH 驾驶舱 · 小票",
  "range": {...},
  "lines": [ { "label": "任务或模型名", "kind": "task|model", "tokens": 0, "costCny": 0, "messages": 0 } ],
  "totalTokens": 0, "totalCostCny": 0, "generatedAt": "ISO",
  "notes": ["金额为估算，非账单"]
}
```

## 10. `GET/POST /api/comfort`

GET：`{ "entries": [ { "date": "YYYY-MM-DD", "level": 1-5, "note": "", "updatedAt": 0 } ], "fit": { "fitted": true, "k": 25 }, "binned": [...], "calendar": [...] }`
POST：`{ "level": 1-5, "note": "", "date": "YYYY-MM-DD?" }` → `{ "ok": true, "entries": [...] }`

## 11. `GET /api/backup` / `POST /api/restore`（新增）

GET → `{ "schemaVersion": 2, "exportedAt": "ISO", "config": {...}, "comfort": {...}, "preferences": {...} }`
POST body = 上述结构（`schemaVersion` 必须匹配或可迁移）→ `{ "ok": true, "restored": ["config","comfort"] }`；校验失败 400。

## 12. `GET /api/notifications` / `POST /api/notifications/read`（新增）

GET → `{ "settings": { "enabled": true, "budgetWarn": 80, "budgetCritical": 95, "compactionScore": 70, "dailyCap": 90 }, "alerts": [ ... ], "unread": 0 }`
POST `{ "ids": ["a","b"] }` 或 `{ "all": true }` → `{ "ok": true }`（已读状态本地存储）

## 13. `GET /api/config` / `POST /api/config`（v2 扩展）

```jsonc
{
  "schemaVersion": 2,
  "budget": { "axis": "budget|balance|context", "mode": "daily|weekly|monthly", "tokens": 2000000, "costCny": 0, "dayStartHour": 4,
              "dailyCapPercent": 90, "dayTotalPercent": 100, "tokensBudgetDefault": true },
  "pricing": { "deepseek-flash": { "input": 2, "cacheRead": 0.2, "cacheWrite": 2, "output": 3 } },
  "pricingOverrides": {},
  "ui": { "maskTitles": false, "language": "zh|en", "theme": "dark|light|auto", "fontScale": 1, "density": "comfortable|compact" },
  "notify": { "enabled": true, "budgetWarn": 80, "budgetCritical": 95, "compactionScore": 70, "dailyCap": 90 },
  "sync": { "enabled": false, "endpoint": "", "spaceLabel": "", "autoPush": false },
  "comfort": { "minSamples": 5, "halfLifeDays": 14 },
  "server": { "host": "127.0.0.1", "port": 7777 },
  "metrics": { "enabled": true }
}
```
POST 为合并式保存（只传变更分组即可）。

## 14. `POST /api/rescan` → `{ "ok": true, "durationMs": 0 }`（v1 保留）

## 15. CLI 对齐（新增命令）

```
dsh-cockpit tasks [--range 30d|--model x|--q 关键字|--sort tokens|--page 1|--json]
dsh-cockpit projects [--range]
dsh-cockpit insights [--range]
dsh-cockpit calendar [--month YYYY-MM]
dsh-cockpit backup [--out file.json]
dsh-cockpit restore <file.json> [--dry-run]
dsh-cockpit watch [--interval 60] [--once]     # 轮询并打印/触发通知
dsh-cockpit notify [--json]                    # 查看当前告警
```

## 16. 前端区块映射（Web 必须实现）

| 区块 | 数据源 |
|---|---|
| 顶栏 + 范围条 | `/api/status.range` + range 参数 |
| 双环 | `quota` / `context` |
| 配速 / 今日建议 / 压缩预测 | `pace` / `plan` / `forecast` |
| 风险热力图（配速×风险） | `riskMap`（二维色块 + 当前位置点） |
| 洞察列表 | `insights` |
| 通知铃铛 | `notifications` + `/api/notifications/read` |
| 趋势 | `/api/history`（跟随 range；可切 token/¥） |
| 热力日历 | `/api/history?range=90d`；点击某天 → `/api/calendar` 详情 |
| 任务表 | `/api/tasks`（搜索/排序/分页） |
| 项目表 | `/api/projects` |
| 子代理树 | `/api/subagents` |
| 模型/工具 Top5 | `status.breakdown` |
| 舒适度 | `/api/comfort`（拟合 + 分箱 + 历史日历） |
| 小票 | `/api/receipt`（POST 选择条件）→ canvas PNG |
| 设置抽屉 | `/api/config` v2 分组 |
| 主题 / 字体 / 语言 | `ui.theme` / `ui.fontScale` / `ui.language` |

## 17. 版本与兼容

- 旧字段全部保留（v1 客户端仍可工作）。
- `config.schemaVersion` 1→2 由 `src/core/config.mjs` 迁移；备份/恢复同时兼容 v1。

## 18. v2.1 增补（P1/P2/P3，向后兼容）

### 18.1 `GET /api/status` 新增字段

```jsonc
{
  "serviceFees": {
    "rows": [ { "kind": "webSearch", "label": "Search", "success": 146, "failed": 12, "costCny": 0.73 } ],
    "requests": 343, "failed": 45, "costCny": 1.715, "cycleCostCny": 0,
    "version": "SERVICE_V1", "unitPriceCny": 0.005,
    "approximation": "按成功工具调用计数；一次 web_search 可能触发多个 provider 请求，结果为下限估计"
  },
  "reliability": {
    "retries": 120, "rateLimit": 57, "toolResults": 20579, "toolErrors": 554,
    "byCode": { "RATE_LIMIT": 57, "TRANSPORT": 39, "SERVER": 24 },
    "toolErrorRate": 0.0269, "retriesPerMessage": 0.0071, "window": "全部"
  },
  "estimation": {
    "enabled": false, "policy": { "fallback": "none", "cnCharTokenRatio": 0.6, "enCharTokenRatio": 0.3 },
    "messages": 0, "tokens": 0, "note": "按字符数启发式估算，仅供参考，未计入成本"
  }
}
```

`totals` 新增：`rangeServiceFeesCny`、`rangeTotalCostCny`；`breakdown.services` 同 `serviceFees`。
`quota` 新增：`includesServiceFees`、`serviceFeesCny`（仅金额预算口径影响百分比）。

### 18.2 `GET/POST /api/config` 新增

```jsonc
{
  "budget": { "...": "...", "includeServiceFees": true },
  "estimation": { "fallback": "none|chars", "cnCharTokenRatio": 0.6, "enCharTokenRatio": 0.3 }
}
```

### 18.3 `GET/POST /api/receipt` 新增

`lines` 可能包含 `kind: "service"` 的行；响应新增 `totalModelCostCny`、`totalServiceFeesCny`、`service`。

### 18.4 CLI

`status` 支持 `--range/--from/--to/--model/--project/--task`，并展示服务费与可靠性行。

## 19. v2.2 增补：官方余额（实时对账）

### 19.1 `GET /api/balance`

| 参数 | 说明 |
|---|---|
| `refresh=1` | 绕过 15s TTL，强制实时取数 |

```jsonc
{
  "enabled": true,            // 是否已显式开启（config.balance.enabled）
  "available": true,          // 本次是否成功拿到官方余额
  "source": "official-api",
  "currency": "CNY",
  "total": 110.0, "granted": 10.0, "toppedUp": 100.0, "isAvailable": true,
  "fetchedAt": "2026-11-03T16:40:03.877Z",
  "cached": false, "ageMs": 0, "ttlMs": 15000,
  "policyVersion": "BALANCE_V1",
  "snapshots": [ { "at": 1793..., "currency": "CNY", "total": 110, "granted": 10, "toppedUp": 100 } ],
  "error": null               // 失败时: { code: "BALANCE_NO_API_KEY|BALANCE_UNAUTHORIZED|BALANCE_TIMEOUT|...", message }
}
```

未开启时返回 `{ enabled:false, available:false, reason:"DISABLED", hint:"..." }`（HTTP 200）。

### 19.2 `GET /api/status` 的 `balance` 段

在 19.1 字段基础上增加：

```jsonc
{
  "reconciliation": {
    "available": true,
    "windowMs": 86400000,        // 配置的窗口（balance.reconcileWindowMs）
    "mode": "full",              // full | since-first
    "windowActualMs": 86400000,  // 实际基线到当前的时长
    "baselineAt": "2026-11-02T08:00:00.000Z",
    "baselineTotal": 100,
    "currentAt": "2026-11-03T08:00:00.000Z",
    "currentTotal": 90,
    "officialSpend": 10,
    "localSpend": 9.5,
    "drift": 0.5,
    "driftPercent": 5,
    "topupDetected": false,
    "note": "官方余额为账户级口径；本地估算含服务费，按日近似"
  }
}
```

- `mode=full`：窗口起点前有快照，严格按 `windowMs` 对账；
- `mode=since-first`：无完整窗口时回退"自首个快照起"（要求首个快照距今 ≥1h），`windowActualMs` 为实际跨度；
- 首个快照距今不足 1h：`available:false` + `note` 提示。

`status?refresh=1` 会让余额查询绕过 TTL（其它数据不受影响）。

### 19.3 `GET/POST /api/config` 新增

```jsonc
{ "balance": { "enabled": false, "ttlMs": 15000, "timeoutMs": 6000, "reconcileWindowMs": 86400000 } }
```

### 19.4 CLI

`node src/cli.mjs balance [--refresh] [--json]`；`status` 增加「官方余额」行。

## 20. v2.3 增补：团队（设备即成员 + 共享计划）

> 均要求 `sync.enabled=true` 且已 enroll；未开启时返回 `{ enabled:false, reason:"SYNC_DISABLED", hint }`（HTTP 200）。

### 20.1 `GET /api/sync/members`

```jsonc
{
  "ok": true,
  "enabled": true, "offline": false,
  "space": { "name": "team", "plan": { "dailyTokenCap": 20000000, "dayTotalPercent": 90, "note": "" } },
  "self": "device-owner-01",
  "members": [
    {
      "deviceId": "device-alice",
      "displayName": "Alice-笔记本",
      "role": "member",
      "isSelf": false,
      "revoked": false,
      "lastSeenAt": "2026-11-03T08:00:00.000Z",
      "lastDay": { "date": "2026-11-03", "tokens": 5000, "costCny": 1.2 },
      "today": { "tokens": 5000, "costCny": 1.2 },
      "source": "snapshot",            // live（本机实时）| snapshot（远端快照）
      "planPercent": 2.5
    }
  ],
  "plan": { "dailyTokenCap": 20000000, "dayTotalPercent": 90, "note": "" },
  "totals": { "members": 2, "devices": 2, "todayTokens": 6000, "todayCostCny": 1.6, "planUsedPercent": 0.03, "dayTotalPercent": 90 },
  "capturedAt": "2026-11-03T16:00:00.000Z"
}
```

离线时 `{ enabled:true, offline:true, error:{code,message}, members:[] }`。

### 20.2 写操作

| 端点 | 方法 | body | 说明 |
|---|---|---|---|
| `/api/sync/members/rename` | POST | `{deviceId, displayName}` | owner 可改任意成员；member 只能改自己 |
| `/api/sync/members/remove` | POST | `{deviceId}` | 仅 owner；撤销设备令牌（历史快照保留） |
| `/api/sync/space` | GET | — | 读取空间名 + 共享计划 |
| `/api/sync/space` | PUT | `{spaceName?, plan:{dailyTokenCap,dayTotalPercent,note}}` | 仅 owner |

### 20.3 Worker 协议

见 `docs/SYNC.md` §1.1：`GET /v1/members`、`POST /v1/members/rename`、`GET|PUT /v1/space/settings`；D1 迁移 `0002_space_settings.sql` 新增 `spaces.settings`。

## 21. v2.4 增补：团队 v2（组员↔多设备 / 版本化配置 / 每日共享计划）

### 21.1 `GET /api/sync/members` 新增字段

```jsonc
{
  "space": { "name": "team", "plan": {...}, "settingsRevision": 2,
             "settings": { "schemaVersion": 2, "groups": [{ "id": "grp_lee", "name": "李工", "deviceIds": ["dev-a","dev-b"] }], "plan": {...} } },
  "people": [
    { "personId": "grp_lee", "name": "李工", "self": true, "devices": [...], "deviceCount": 2,
      "today": { "tokens": 5000000, "costCny": 1.0 }, "consumedPercent": 50,
      "planValue": 45, "planRevision": 1, "planTokens": 4500000,
      "planUtilizationPercent": 111.1, "overPlan": true }
  ],
  "unassignedDevices": [ { "deviceId": "...", "displayName": "...", "today": {...} } ],
  "dayPlan": {
    "available": true, "revision": 2,
    "basis": { "localDate": "2026-11-04", "anchorAt": "...", "remainingPercent": 40, "resetsAt": "..." },
    "recommendation": 45.0, "risk": { "value": 40, "revision": 1 },
    "people": [ { "personId": "grp_lee", "value": 45, "revision": 1, "manual": true } ],
    "totalAllocated": 45.0, "overRecommended": false
  },
  "members": [ { "configRevision": 2, "configStale": false, "...": "..." } ]
}
```

### 21.2 写接口

| 端点 | 方法 | body | 说明 |
|---|---|---|---|
| `/api/sync/shared` | GET | — | 读取版本化共享配置（revision + settings） |
| `/api/sync/shared` | PUT | `{revision, settings}` | 仅 owner；409 `SETTINGS_CONFLICT` |
| `/api/sync/dayplan` | POST | `{basis, initialRisk?, change?}` | 每日计划 seed/修改；409 `PLAN_CONFLICT`，403 `PLAN_PERSON_DENIED` |

CLI：`sync groups list|add|rename|remove|assign|unassign`；`sync dayplan`（查看 / `--risk N` / `--person <id> --value N`）。

### 21.3 Worker 协议

`GET|PUT /v1/shared-settings`、`POST /v1/heartbeat`、`POST /v1/daily-plan`；D1 迁移 `0005_shared_contract_v2.sql`。

### 21.4 个人成本分摊与共享价格表

`people[]` 追加：

```jsonc
{
  "personCostCny": 1.0, "costShare": 0.8333, "allocatedPercent": 50,
  "missingDeviceIds": [], "coverage": "complete"
}
```

`totals` 追加：`sharedUsedPercent`、`totalKnownCostCny`、`costCoverage`（complete/partial）。

共享配置新增：

```jsonc
{
  "pricing": { "deepseek-flash": { "input": 2, "cacheHit": 0.04, "cacheWrite": 2, "output": 8 } },
  "costPolicy": "shared-pricing-v1"
}
```

CLI：`sync pricing publish`（owner 发布本机价格）、`sync pricing status`（漂移对比）、`sync pricing adopt`（采用共享价格并清计价缓存重算）。

### 21.5 任务聚合与可选舒适度（v0.7.0）

| 端点 | 方法 | body | 说明 |
|---|---|---|---|
| `/v1/task-stats` | POST | `{days:[{date, tasks}]}` | 仅任务数量（0–10000），不含标题 |
| `/v1/comfort` | POST | `{level:1-5, note?≤120, day?}` | 按设备所属组员归属；可选同步 |

`GET /api/sync/members` 追加：`taskStats.byDevice`、成员 `todayTasks`、`comfort[]`、`sharedChannels`。
本地开关：`sync.shareTasks` / `sync.shareComfort`（默认 true）/ `sync.maskTaskTitles`（默认 true）；CLI `sync comfort <1-5>`。

`POST /v1/tasks`：`{day, tasks:[{key,title?,tokens?,costCny?,lastAt?}]}`（≤200）；成员列表返回 `tasks.rows`。
