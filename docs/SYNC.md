# 团队共享（可选同步）· SYNC

> 状态：**P2 可选模块，默认关闭**；对应需求 `docs/PRD.md` FR-13 / 决策 D4。
> 实现：`src/sync/client.mjs`（Node 客户端）+ `cloud/usage-sync-worker/`（Cloudflare Workers + D1）。
> 测试：`test/sync.test.mjs`（36 例）；写作用域之外的代码（core / server / web / 根 package.json）**没有改动**。
>
> ⚠️ **先读第 2 节数据边界**：本方案**不是端到端加密**。空间成员与 Cloudflare 账号管理员可读同步数据；
> 只适合小团队自托管、且团队已就"聚合用量共享"达成一致的场景。

---

## 0. 一分钟判断该不该开

| 适合 | 不适合 |
|---|---|
| 2–32 台设备的小团队，想一起看 token/成本总量 | 需要 E2E 加密 / 合规审计留痕 |
| 有 Cloudflare 账号，愿意自托管 Worker + D1 | 不能接受"管理员理论上可读" |
| 只关心聚合数字（日期、模型、总量） | 想同步会话标题、任务明细、对话内容 |

**默认关闭**：`config.sync.enabled=false` 时，`src/sync` 不会发出任何网络请求；
整个仓库默认仍是"零遥测、只读本地"的形态（见 `docs/PRIVACY.md`）。

---

## 1. 架构与接口

```
本地 DSH sessions（只读）
  → src/core buildStatus()        ← 不修改
  → buildSnapshotFromStatus()     ← 只投影聚合字段
  → src/sync/client.mjs  ──HTTPS──→  cloud/usage-sync-worker  ──→  D1
                                            ↑ Bearer ccs_…
                                      GET /v1/snapshots
  ← mergeRemote() 按设备取 _ts 最新，汇总团队总量
```

### 1.1 Worker 路由（`cloud/usage-sync-worker/src/index.js`）

| 方法与路径 | 鉴权 | 说明 |
|---|---|---|
| `POST /v1/spaces` | bootstrap secret **或** owner Bearer | 无 Bearer 时用 `x-bootstrap-secret` 创建空间并成为 owner；带 Bearer 时由 owner 生成新邀请码 |
| `POST /v1/enroll` | 邀请码 | 邀请码换设备令牌；单次使用、24h 过期、空间 ≤32 设备 |
| `POST /v1/snapshots` | Bearer | 上传本设备聚合快照；`payload_hash` 去重 + `_ts` 单调守卫 |
| `GET /v1/snapshots` | Bearer | 拉取本空间全部设备的最新快照（含 `revoked` 标记） |
| `POST /v1/devices/revoke` | Bearer（仅 owner） | 撤销其他设备；撤销 ≠ 删除快照 |
| `GET /v1/members` | Bearer | 成员列表（设备即成员）+ 各设备最新快照摘要（`lastDay`/`totals`） |
| `POST /v1/members/rename` | Bearer（owner 或本人） | 重命名成员（1–40 字符） |
| `GET /v1/space/settings` | Bearer | 读取空间设置（共享计划） |
| `PUT /v1/space/settings` | Bearer（仅 owner） | 修改空间名 / 共享计划（`dailyTokenCap`、`dayTotalPercent`、`note`） |
| `GET /v1/shared-settings` | Bearer | 读取版本化共享配置（组员↔多设备 + plan + revision） |
| `PUT /v1/shared-settings` | Bearer（仅 owner） | 发布共享配置；`revision` CAS，冲突 409 `SETTINGS_CONFLICT` |
| `POST /v1/heartbeat` | Bearer | 设备上报采用的 `configRevision`（成员列表标记 `configStale`） |
| `POST /v1/daily-plan` | Bearer | 每日共享计划：basis seed + person/risk 独立修订 + 行级 CAS（冲突 409 `PLAN_CONFLICT`） |

所有响应为 JSON：成功 `{ "ok": true, ... }`，失败 `{ "ok": false, "error": { "code", "message" } }`，错误码稳定（见 §10）。

### 1.2 D1 表（`migrations/0001_init.sql` + `0002_space_settings.sql` + `0005_shared_contract_v2.sql`）

- `spaces`：空间 + **单活邀请码**（`invite_hash` / `invite_expires_at` / `invite_used_at`，只存 SHA-256）；`settings`（JSON，0002，legacy plan）；`shared_settings`（JSON，0005，v2 契约：groups + plan）、`settings_revision`（CAS 版本）。
- `members`：每设备一行（**设备即成员**）；`token_hash TEXT NOT NULL UNIQUE`（**明文令牌永不入库**）、`display_name`（成员名，可改）、`role ∈ {owner,member}`、`revoked_at`；`sync_info` / `heartbeat_at`（0005，设备上报的配置版本）。
- `daily_plans`（0005）：`space_id + day + cycle` 主键，`value`（basis + 每人份额 + risk）、`revision`（行级 CAS）。

### 1.2c 组员模型与每日共享计划（v2，对齐 Codex Cockpit）

- **组员 ↔ 多设备**：`shared_settings.groups = [{id,name,deviceIds[]}]`；owner 发布，同一设备只能属于一个组员。
- **版本化配置**：`settings_revision`；设备通过 `POST /v1/heartbeat` 上报采用的版本，列表返回 `configStale`。
- **每日共享计划**：`POST /v1/daily-plan`，value = `{ basis:{localDate,anchorAt,remainingPercent,resetsAt}, people:{personId:{value,revision}}, risk:{value,revision} }`；
  首个设备 seed 基线；person/risk 修订独立；行级 CAS；person 只能改"设备列表包含自己"的组员，risk 任意成员可改。
- 客户端公式（`src/sync/dayplan.mjs`，与 Codex 一致）：`U=min(R,R/D×f)`、`shared=min(R,U+(R−U)p²f)`；自动份额=建议÷人数，手动覆盖不重分配他人；planning 日边界北京 00:00。
- **个人成本分摊**：`costShare = personCost / totalKnownCost`，`allocatedPercent = 共享已用% × costShare`；成本缺失标 `coverage=partial`（缺失 ≠ 0）。
- **共享价格表**：`shared_settings.pricing` + `costPolicy`；owner `sync pricing publish`，设备 `sync pricing adopt`（清计价缓存后重扫），`sync pricing status` 看漂移。
- **可选通道（默认关闭）**：`sync.shareTasks` → `POST /v1/task-stats`（仅任务数量，无标题）；`sync.shareComfort` → `POST /v1/comfort`（1–5 等级 + 可选备注，按组员归属）。
- `snapshots`：每设备一条最新快照；`payload`（聚合 JSON）、`payload_hash`、`_ts`、`updated_at`，主键 `(space_id, device_id)`。

### 1.2b 成员与共享计划（v0.4.0）

- **成员 = 设备**：不依赖 DSH 账号体系；`display_name` 即成员名，owner 可改任意成员，member 只能改自己。
- **共享计划**：空间级 `plan`（`dailyTokenCap` 绝对 Token 上限、`dayTotalPercent` 建议百分比、`note`）；**建议性**，不做请求层限流（DSH 侧无法拦截，已在 UI 标注）。
- **成员视图**：本机用实时 `buildStatus` 数据（`source=live`），远端设备用最新快照 `lastDay`（`source=snapshot`）；同设备多快照只取最新。
- 权限边界：读成员/计划 = 任意活跃成员；改名 = owner 或本人；改计划/撤销 = 仅 owner。

### 1.3 唯一上传物：聚合快照

`buildSnapshot()` 输出固定白名单字段（见下）；Worker 端再做一次白名单校验，未知字段直接 `400 SNAPSHOT_INVALID`。

```jsonc
{
  "schemaVersion": 1,
  "generatedAt": "2026-11-03T04:00:00.000Z",
  "_ts": 1793656800000,                          // epoch 毫秒，单调守卫用
  "days":   [ { "date": "2026-11-01", "tokens": 1200, "costCny": 0.35 } ],
  "models": [ { "model": "deepseek-flash", "tokens": 2000, "costCny": 0.56 } ],
  "totals": { "tokens": 2000, "costCny": 0.56 }
}
```

**不包含**：会话 id、会话标题、工作区路径 / cwd、对话正文、工具参数、provider 凭据（API Key）。
`缺失 ≠ 0`：拿不到的 `tokens` / `costCny` 用 `null` 表达，不补 0。

---

## 2. 数据边界与隐私（必读）

| 项 | 事实 |
|---|---|
| 传输 | HTTPS（TLS）；**客户端只允许本机 `http://127.0.0.1` 调试**，其它 http 端点会被拒绝 |
| 存储 | D1 中快照是**明文 JSON**；令牌/邀请码只存 SHA-256 |
| 谁能读 | 空间内任何持有有效令牌的成员都能 `GET` 到全部设备快照；Cloudflare 账号管理员/支持人员理论上可访问 D1 及其备份 |
| 加密 | **非端到端加密**。Worker 与 D1 能看到快照明文；本模块不提供 E2E 承诺 |
| 元数据 | `spaceName` / `displayName` / `deviceId` 由团队自填，会随空间元数据存储在 D1；建议用代号而不是真实姓名 |
| 上报内容 | 只有 §1.3 的聚合数字 + 模型名（模型名会暴露"用了哪些模型"，但不含对话内容） |

与 `docs/PRIVACY.md` 的关系：不开同步时本工具仍然**零外传**；开启后同步是**用户显式选择**的可选外传通道
（另一个可选通道是余额查询）。同步**不**包含 L2 的标题/路径，因此 `ui.maskTitles` 与同步正交。

**合规提示**：
- 员工监控 / 工会协商 / 客户保密协议需**事先评估**，必要时取得书面同意。
- Cloudflare 是全球网络，可能涉及跨境传输与数据驻留要求；若团队有硬性要求，请勿启用。
- 保留期、删除义务、备份管理由**运营者（部署 Worker 的团队）**负责，本模块不自动过期、不自动删除。

---

## 3. 自托管部署（Cloudflare Workers + D1）

前置：Node ≥22.15、Cloudflare 账号；`wrangler` 通过 `npx wrangler@4` 使用（worker 的 `package.json` 已声明为 devDependency，**不是运行时依赖**）。

### 3.1 创建资源

```powershell
cd cloud/usage-sync-worker
Copy-Item wrangler.example.toml wrangler.toml

# 1) 创建 D1 数据库（输出里的 database_id 填进 wrangler.toml）
npx wrangler d1 create dsh-cockpit-sync

# 2) 建表（--local 先在本地 D1 自检，--remote 才是线上）
npx wrangler d1 migrations apply dsh-cockpit-sync --remote

# 3) bootstrap secret（≥32 字节随机串；只放 Cloudflare secret，不要写进仓库）
node -e "console.log(require('node:crypto').randomBytes(32).toString('base64url'))"
npx wrangler secret put BOOTSTRAP_SECRET
```

### 3.2 配置 `wrangler.toml`

**方案 A：Workers Paid（$5/月，推荐公网/多人使用）** — 复制 `wrangler.example.toml`：

- `[vars] ALLOWED_ORIGIN`：允许调用的浏览器 Origin（协议 + 主机 + 端口必须精确匹配，逗号分隔多个）。
  纯 Node 客户端不带 `Origin` 头，不受 CORS 限制；但若从浏览器页面调用，必须加入白名单。
  **该变量必须非空**：缺失时 Worker 对所有请求 fail-closed 返回 `503`，即使只用 Node 客户端也要填一个占位值。
- `[vars] SPACE_DEVICE_LIMIT`：只能调低（硬上限 32）。
- **不要删除** `AUTH_RATE_LIMITER` / `API_RATE_LIMITER` 两个限流绑定：缺失时 Worker 会 fail-closed 返回 `503`。
- `BOOTSTRAP_SECRET` 不要写在 `[vars]` 或 `wrangler.toml` 里，用 `wrangler secret put`。

**方案 B：Workers Free（免费计划，个人/≤3 台设备）** — 复制 `wrangler.free-plan.toml`：

- 免费计划不支持 Rate Limiting 绑定，因此该模板**不声明**两个 limiter，并设置：
  - `ALLOW_NO_RATE_LIMITER = "1"`：显式开启"限流降级"（其余鉴权、邀请、设备上限、快照校验全部照常）；
  - `workers_dev = true`：使用 `https://<worker>.<子域>.workers.dev`；
  - 响应头会带 `x-cockpit-degraded: no-rate-limiter` 作为标记。
- ⚠️ 降级模式没有请求频率限制：仅建议个人/可信小团队使用；公网暴露或队伍更大请用方案 A。

### 3.3 部署与冒烟（CLI 一键）

```powershell
# 方案 A：npx wrangler deploy（wrangler.example.toml）
# 方案 B：Copy-Item wrangler.free-plan.toml wrangler.toml 后再 deploy
npx wrangler deploy
# 得到 https://dsh-cockpit-usage-sync.<你的子域>.workers.dev
```

本机先设置一次 bootstrap secret（只用于创建空间，不落盘）：

```powershell
$env:DSH_COCKPIT_BOOTSTRAP_SECRET = "<与 Worker secret 一致的值>"
node src/cli.mjs sync init --endpoint https://dsh-cockpit-usage-sync.<你的子域>.workers.dev --name dev-a --space-name team
```

预期输出（**令牌只显示这一次**）：

```
空间已创建  team  spc_xxx
本机设备    device-xxxxxxxx（owner）
邀请码      CCI-xxxxxxxxxxxxxxxx  24h 内有效，单次使用
访问令牌    ccs_xxxxxxxx...
```

然后把令牌放进环境变量（当前终端）：

```powershell
$env:DSH_COCKPIT_SYNC_TOKEN = "ccs_xxx..."   # 不要写入 config/仓库/profile
node src/cli.mjs sync push                    # 首次推送聚合快照
node src/cli.mjs sync invite                  # 给第二台设备生成邀请码
```

本地联调：`npx wrangler dev`（默认 `http://127.0.0.1:8787` + 本地 D1），endpoint 用
`http://127.0.0.1:8787`（客户端只允许本机 http）；`sync init --endpoint http://127.0.0.1:8787`。

> Worker 本身不含任何第三方运行时依赖；`wrangler` 只在部署机器上使用。

---

## 4. 客户端配置与用法

### 4.1 配置（默认关闭）

`~/.dsh-cockpit/config.json` 的 `sync` 组（schemaVersion 2）：

```jsonc
"sync": { "enabled": false, "endpoint": "", "spaceLabel": "", "autoPush": false,
          "deviceId": "", "deviceName": "" }
```

**首选 `sync init` 自动写入**（endpoint/spaceLabel/deviceId/deviceName 一次配置好）；
手动配置（第二台设备）时：

```powershell
dsh-cockpit config --set sync.endpoint=https://dsh-cockpit-usage-sync.<你的子域>.workers.dev
dsh-cockpit config --set sync.enabled=true
dsh-cockpit sync enroll --invite CCI-xxxxxxxxxxxxxxxx --name dev-b
```

enroll 成功后会打印 **设备令牌（只显示这一次）**，把它放进环境变量后即可 `sync push`。

### 4.2 设备令牌（不放 config.json）

核心 config schema **没有** token 字段（避免明文秘密落盘到普通配置文件）。用环境变量提供：

```powershell
$env:DSH_COCKPIT_SYNC_TOKEN = "ccs_…"   # 当前会话
```

`createSyncClientFromConfig(config, options)` 优先取 `options.token`，其次环境变量 `DSH_COCKPIT_SYNC_TOKEN`。
注意：带 `ccs_` 令牌的环境变量不要写入 shell profile / 仓库 / CI 明文。

### 4.3 Node 用法示例

```js
import { loadConfig } from "./src/core/config.mjs";
import { buildStatus } from "./src/core/index.mjs";
import {
  buildSnapshotFromStatus,
  createSyncClientFromConfig,
  mergeRemote,
} from "./src/sync/client.mjs";

const { config } = loadConfig(process.env);
// sync.enabled=false 时这里会抛 SYNC_DISABLED（默认关闭，不会联网）
const client = createSyncClientFromConfig(config, { token: process.env.DSH_COCKPIT_SYNC_TOKEN });

const status = await buildStatus();                 // 既有核心出口，未改动
const snapshot = buildSnapshotFromStatus(status);   // 只保留聚合字段
await client.push(snapshot);                        // 服务端去重 + 单调守卫

const team = mergeRemote(await client.pull());      // 按设备取 _ts 最新
console.log(team.totals);                           // { devices, tokens, costCny }
```

新设备加入：

```js
const client = createSyncClient({ endpoint, fetchImpl });
const { token } = await client.enroll({ inviteCode: "CCI-…", displayName: "dev-b", deviceId: "device-b-01" });
```

### 4.4 错误处理

`SyncError` 带稳定 `code` / `status` / `retryable` / `detail`。建议：

- `retryable === true`（网络、超时、429、5xx）已由客户端自动指数退避重试（默认 2 次，`retryBaseMs` 可调）；
- 4xx 不重试：按 code 分类提示（如 `DEVICE_REVOKED` 需要重新 enroll；`SNAPSHOT_STALE` 检查设备时钟）；
- 同步失败**不得**影响本地驾驶舱：调用方 catch 后可降级为"仅本地"。

---

## 5. 安全设计（实现要点）

| 威胁 | 对策 |
|---|---|
| 数据库泄漏 → 令牌泄漏 | 令牌/邀请码只存 SHA-256；明文只在创建响应里返回一次 |
| 邀请码暴力枚举/外泄 | 96bit CSPRNG、24h 过期、**单次使用**（单条 UPDATE 原子消费）；签发新码使旧码失效（单活） |
| 暴力请求 | `AUTH_RATE_LIMITER` / `API_RATE_LIMITER` 绑定；**缺失即 503 fail-closed**，不会"先跑通再补" |
| 越权 | 所有查询带 `space_id` 隔离；撤销仅 owner；不允许撤销自己（避免空间失联） |
| SQL 注入 | 全部 `prepare().bind()` 参数化，无字符串拼接 SQL |
| 快照覆盖/重放 | `payload_hash` 幂等去重 + `_ts` 单调守卫（D1 内用 `json_extract(payload,'$._ts')` 二次校验，缩小读写竞态） |
| 数据外泄到服务端 | 快照白名单校验（未知字段 400）；错误信息不回显字段值；客户端发送前投影 + 服务端白名单校验 |
| 跨站读取 | CORS 仅回显 `ALLOWED_ORIGIN` 白名单；非白名单 Origin → 403；未配置 → 503 |
| DoS | 请求体 ≤256KiB；`days ≤400` / `models ≤100`；设备 ≤32；错误统一 500 不带堆栈 |
| 令牌进日志 | Worker 不打印令牌/请求体；限流 key 用令牌哈希或 IP；运维者请勿把完整请求头导入第三方日志 |

**撤销 ≠ 删除**：`revoke` 只让令牌立即失效（`401 DEVICE_REVOKED`），历史快照仍在 D1，空间成员仍能拉取（`revoked: true`）。
需要删除数据时见 §6。

---

## 6. 撤销、保留期与备份（运营者责任）

- **撤销**：owner `POST /v1/devices/revoke`（或客户端 `client.revoke(deviceId)`）。被撤销设备需向 owner 要新邀请码重新 enroll。
- **保留期**：Worker 不自动清理。建议按团队政策定期执行：
  ```bash
  # 删除某空间全部快照（不可逆）
  npx wrangler d1 execute dsh-cockpit-sync --remote \
    --command "DELETE FROM snapshots WHERE space_id = '<SPACE_ID>'"
  # 删除整个空间会级联删除 members/snapshots（外键 ON DELETE CASCADE）
  npx wrangler d1 execute dsh-cockpit-sync --remote \
    --command "DELETE FROM spaces WHERE id = '<SPACE_ID>'"
  ```
- **备份**：D1 由 Cloudflare 托管，含 Time Travel 能力（保留窗口以 Cloudflare 当期政策为准）。删除后备份窗口内仍可能存在副本；
  自行导出的备份同样含快照明文，必须按同等级别保护。
- 本模块**没有**删除 API（刻意最小化接口面）；删除属于运维操作，请先确认目标 `space_id` 再执行。

---

## 7. 卸载 / 退出

1. **单设备退出**：`dsh-cockpit config --set sync.enabled=false`（立即停止后续请求），并请 owner 撤销该设备。
2. **清理令牌**：从 shell profile / CI / 密钥管理器中删除 `DSH_COCKPIT_SYNC_TOKEN`。
3. **团队解散**：撤销所有成员 → `npx wrangler delete`（删 Worker）→ `npx wrangler d1 delete dsh-cockpit-sync`（删库）。
4. 卸载后客户端会得到网络错误（`SYNC_NETWORK_ERROR`），本地驾驶舱功能不受影响。

---

## 8. 测试

```bash
node --test test/sync.test.mjs      # 36 例：脱敏 / 哈希 / 过期 / 单次 / 上限 / 限流 / CORS / 撤销 / 幂等 / 合并
cd cloud/usage-sync-worker && npm test   # 等价：node --test ../../test/sync.test.mjs
```

Worker 业务逻辑被抽成 `handleRequest(request, env)` + 可替换的存储适配器
（`createMemoryStore()` / `createD1Store(db)`），因此 Node 测试不需要 wrangler、不联网、不依赖 D1。

---

## 9. 与核心解耦 / 未决项

**已接线（v0.4.0）**：

- `/api/sync/members`、`/api/sync/members/rename`、`/api/sync/members/remove`、`/api/sync/space` 已接入 `src/server.mjs`；
- CLI：`sync members`、`sync plan`、`sync rename`、`sync remove`（enroll 会持久化 `sync.deviceId/deviceName/spaceLabel`，令牌仍只走环境变量）；
- Web：任务区新增「成员」Tab（成员/共享计划/改名/移除），未开启时显示空态提示；
- 核心仍不依赖同步模块：`src/sync/team.mjs` 只消费 `buildStatus()` 公开 JSON。

**未决项（后续集成时处理）**：

1. **令牌持久化**：核心 config 无 `sync.token`；当前靠环境变量。若要做"一次 enroll 长期使用"，
   建议独立 secret store / OS keychain，不要写进 `config.json`。
2. **自动推送**：`autoPush=true` 的语义（聚合窗口、触发时机、失败静默）需要接 `buildStatus` 生命周期后再实现。
3. **邀请码多活**：当前 `spaces` 表只保留一个有效邀请码（新码使旧码失效）；若要"多个邀请同时有效"，
   需把邀请拆成独立 `invites` 表并加迁移。
4. **多设备归并成一个成员**：当前 1 设备 = 1 成员；若"一个人多台机器算同一成员"，需要空间设置里的
   `groups` 映射（`settings` 已预留，尚未实现 UI）。
5. **D1 SQL 集成测试**：Node 测试用内存适配器覆盖业务规则，并在 `node:sqlite` 可用时对真实的 D1 语句
   （迁移 DDL / 参数化查询 / `json_extract(_ts)` 守卫）做等价执行；部署前仍建议用
   `wrangler d1 migrations apply --local` + `wrangler dev` 冒烟。
6. **保留期自动化**：可选的 Cron Trigger 清理任务（按 `updated_at` 删除旧快照）尚未实现。
7. **误删保护**：删除空间目前只有手工 SQL，后续若要开放管理 API 需要二次确认/软删除。

---

## 10. 错误码

| code | HTTP | 含义 |
|---|---|---|
| `BOOTSTRAP_DENIED` | 401 | bootstrap secret 不匹配 |
| `BOOTSTRAP_DISABLED` | 503 | 未配置 `BOOTSTRAP_SECRET`，空间创建被禁用 |
| `INVALID_INVITE` | 400 | 邀请码格式非法 |
| `INVITE_INVALID` | 410 | 邀请码不存在 / 已被使用 |
| `INVITE_EXPIRED` | 410 | 邀请码超过 24h |
| `INVITE_USED` | 410 | 邀请码已被消费（单次有效） |
| `DEVICE_LIMIT` | 409 | 空间设备数已达上限（≤32） |
| `INVALID_DEVICE_ID` / `INVALID_DISPLAY_NAME` | 400 | 设备 ID / 显示名非法 |
| `INVALID_TOKEN` | 401 | Bearer 不是 `ccs_` + 43 字符 base64url |
| `UNAUTHORIZED` | 401 | 令牌不存在 / 已轮换 |
| `DEVICE_REVOKED` | 401 | 设备已被 owner 撤销 |
| `OWNER_REQUIRED` | 403 | 非 owner 执行 owner 操作 |
| `DEVICE_NOT_FOUND` | 404 | 空间内无此设备 |
| `CANNOT_REVOKE_SELF` | 400 | owner 试图撤销自己 |
| `SNAPSHOT_INVALID` | 400 | 快照结构/字段白名单校验失败 |
| `SNAPSHOT_STALE` | 409 | `_ts` 不新于服务端已存版本 |
| `PAYLOAD_TOO_LARGE` | 413 | 请求体 >256KiB |
| `RATE_LIMITED` | 429 | 触发限流 |
| `RATE_LIMITER_UNAVAILABLE` | 503 | 限流绑定缺失/异常（fail-closed） |
| `ORIGIN_NOT_ALLOWED` | 403 | Origin 不在 CORS 白名单 |
| `SERVER_MISCONFIGURED` | 503 | 未配置 `ALLOWED_ORIGIN` |
| `STORE_UNAVAILABLE` | 503 | D1 绑定缺失 |
| `NOT_FOUND` / `METHOD_NOT_ALLOWED` | 404/405 | 路由不存在 / 方法不支持 |
| `INVALID_JSON` / `INVALID_BODY` | 400 | 请求体不是合法 JSON 对象 |
| `INTERNAL_ERROR` | 500 | 未预期异常（不回显详情） |

客户端本地错误码（`SyncError.code`）：`SYNC_DISABLED`、`SYNC_NO_TOKEN`、`SYNC_INVALID_ENDPOINT`、
`SYNC_INVALID_TOKEN`、`SYNC_INVALID_INVITE`、`SYNC_INVALID_DEVICE`、`SYNC_INVALID_SNAPSHOT`、
`SYNC_NETWORK_ERROR`、`SYNC_TIMEOUT`、`SYNC_BAD_RESPONSE`、`SYNC_HTTP_ERROR`；
服务端错误码会**原样透传**，便于 UI 分支。
