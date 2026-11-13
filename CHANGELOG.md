# Changelog

## 0.18.0 — 2026-11-12（大肥鱼女仆：动态桌宠挂件 + 全站形象替换）

融合 dsh-pet（动画）与 YunYueSama/codex-deepseek-pet（角色图）双来源素材：

- **动态女仆挂件**：400×300 无边框挂件，VP9-alpha WebM 动画（待机呼吸/东张西望/女仆屈膝礼仪/优雅女仆舞/点击回应/思考/睡觉），单击互动、双击展开驾驶舱、拖拽吸附、右键菜单；
- **情绪联动**：余额低→鼓腮+台词；配额/压缩风险→紧张+思考；每轮消耗增量→元气挥手+「本轮 ≈¥x」气泡；23:00–06:00→犯困睡觉；
- **主人向人格**：称呼"主人"、黏人台词（按用户要求）；
- **全站形象**：导航/顶栏头像、启动画面立绘、主视觉水印、底部状态轨立绘、空状态台词、exe/托盘/PWA 图标全部换为大肥鱼女仆；
- **素材入库并署名**：`web/assets/pet/`（8 段 webm + portrait/idle-front/expressions/app-icon），许可说明见 `web/assets/pet/NOTICE.md`；
- 桌面程序重新签名（本地证书）。

> ⚠️ 授权组合：dsh-pet 动画为 CC BY-NC-SA 4.0（**非商业**、署名、相同方式共享）；YunYueSama 角色图允许使用/修改/分享/商用（需署名）。当前整包按非商业使用。

---

## 0.17.0 — 2026-11-12（融合小鲸鱼：挂件形态 + 全站鲸鱼风）

融合 MeteorNOX/DeepSeek-Balance-Whale-Widget（用户确认已获素材授权）：

- **桌面双形态**：主窗口最小化 → 收起为 340×236 的鲸鱼挂件（无边框/置顶/可拖拽/贴边吸附/位置记忆）；
  双击挂件 → 展开驾驶舱；右键菜单（打开/刷新/退出）；托盘鲸鱼图标；
- **挂件内容**：官方余额（大数字滚动）、今日已用、峰谷状态、每轮消耗气泡（检测今日 tokens 增量）；
- **全站鲸鱼风**：海军蓝/长春花蓝/薰衣草紫/樱花粉粉彩，圆润气泡卡、鲸鱼娘水印、插件同款图标与头像；
- **图标**：exe/桌面快捷方式/PWA/托盘全部换为插件鲸鱼头像（用户授权素材，见 `web/assets/whale/NOTICE.md`）；
- **DSH 插件**：同一服务器暴露 `/dsh-cockpit/widget.html` 挂件页，与桌面共用数据；
- 桌面 exe 重新签名（本地证书），版本 1.1.0。

截图：`docs/ui-widget-final.png`、`docs/whale-main.png`。

---

## 0.16.0 — 2026-11-05（壁纸同源配色）

读取本机当前桌面壁纸（ASUS teal 科技风），提取主色并重配主题：

- 壁纸主色实测：青绿 `#10E0D0` / 深炭 `#202020` / 银白 `#F2FAF8`；
- 浅色：白底 + 青绿柔光（#F4FBF9 / #10C9B5），激活态用炭黑块（呼应壁纸黑色 X 条）；
- 深色：炭黑 #0C1213 + 青绿 #1FE0CC；
- 新增壁纸同源元素：斜向细纹底、右下 `✕ ✕ ✕ ✕` 角标、页脚 END 标记；
- 图表调色板同步为青绿/炭黑/银白（7 日均线改灰白）；
- 字体、圆角、半透明卡片沿用 v3.1。

截图：`docs/ui-wall-light.png`、`docs/ui-wall-dark.png`。

---

## 0.15.0 — 2026-11-05（UI v3.1：舒适字体 · 白底青调 · 圆润通透）

针对反馈的细化：

- **字体**：新增 Inter 字体包（400–700），中文回退 微软雅黑/PingFang；正文 14px、去掉过度字距，仅数字/代号保留等宽；
- **配色**：浅色改为**白底 + 青色柔光**（#F3FAFC / #16C8EF），深色为冷青黑；
- **圆润**：卡片 14px、按钮/输入 10px、表格/面板 12px、进度条全圆角、环进度圆头；
- **半透明过渡**：卡片/顶栏/状态轨改为半透明白 + 背景模糊（backdrop-filter），悬停上浮 + 青色描边；
- **导航跟随**：重写 scrollspy（点击锁定 900ms + rAF 滚动监听），点击「用量/任务/小票」后导航会跟随滚动高亮；底部分布卡滚动也会正确切到「小票」；
- **导航激活态**：青蓝渐变圆角块 + 深色文字，清晰可读。

---

## 0.14.0 — 2026-11-05（UI v3：明日方舟系「明亮工业档案」重制）

基于对明日方舟官网、PRTS Design 设计系统、ak-ui 设计语言、腾讯游戏学堂 UI/UX 分析的实测研究重做：

- **主色纠正**：方舟官网真实主色为青蓝 `#18D1FF`（非黑黄），搭配墨黑 `#1D1F20` / 纸白 `#F5F5F5`；
- **浅色为默认**：纸感白底 + 半调网点 + 青蓝细线，清爽通透；深色为冷灰蓝变体；
- **装饰语言**（PRTS Design）：左侧短色条、半调网点、角标三角、黑白反转、大写拉丁字——**移除切角/斜带/扫描线/故障特效**；
- **导航**：01–06 编号条，激活态黑白反转 + 青蓝侧标；顶栏/范围条铺平，去掉悬浮胶囊；
- **图表**：趋势/风险/舒适度调色板改为青蓝 + 琥珀 + 墨黑；
- **动效**：克制的卡片入场（10px 上浮 + 淡入）、青蓝焦点环、数值闪烁，尊重减少动效；
- 截图：`docs/ui-v3-light.png`、`docs/ui-v3-dark.png`。

---

## 0.13.0 — 2026-11-05（UI 重设计：终末地 / TALOS 终端风格）

按《明日方舟：终末地》官网与游戏 HUD 的视觉语言重做整个界面：

- **设计语言**：深空黑 + 纸白档案 + 信号黄 #FFFA00 + 薄荷 #00FFA2 + 品红 #FF1AAC；
  宽体工业无衬线（Space Grotesk）+ 等宽读数（JetBrains Mono），字体已打包（~130KB）；
- **终端布局**：左侧 01–06 编号导航条 · 顶部指挥栏 · 右侧 SYS 状态轨（时钟/官方余额/网关/告警）；
- **双主题**：深色 HUD（默认）与浅色奶油纸档案风，左侧 ◐ 一键切换并记忆；
- **强特效**：启动终端序列、扫描线 + 网格漂移背景、卡片切角描边入场、标题 glitch、数值更新闪烁；
  ✦ 可一键关闭特效（性能/截图友好）；
- **组件重绘**：切角卡片与编号、信号黄读数环、黄黑警示条纹进度条、方形按钮/标签、
  等宽表格、热力格、小票构建器、设置抽屉、日历模态全部换肤；
- **图表配色**：趋势/风险/舒适度 canvas 调色板同步替换（信号黄/白/薄荷/品红）；
- **兼容**：所有既有功能与 data-testid 保留，E2E 6/6、单测 109 pass；
- **桌面程序**：WebView2 壳直接加载新 UI，无需重装（重启 exe 即可）。

截图：`docs/ui-endfield-dark.png`、`docs/ui-endfield-light.png`。

---

## 0.12.0 — 2026-11-04（真正的 Windows 桌面程序）

- `desktop/DSHCockpit/`：C# WinForms + WebView2 桌面壳（dotnet 9）；
- 发布产物：`desktop/DSH-Cockpit-App/DSH-Cockpit.exe`（约 157KB，framework-dependent）；
- 双击行为：自动检测/启动 7777 服务 → 独立窗口加载驾驶舱（无浏览器地址栏）→ 退出时停止自己拉起的服务；
- 托盘：打开/启动网关(7891)/退出；单实例互斥；WebView2 用户数据在 `%LOCALAPPDATA%\DSHCockpit\WebView2`；
- 桌面快捷方式：`DSH 驾驶舱.lnk`（已创建）；
- 依赖：.NET 9 Desktop Runtime + WebView2 Runtime（本机均已存在）；分发版可用 `--self-contained` 发布（约 70–100MB）。

---

## 0.11.0 — 2026-11-04（桌面形态：PWA + 系统托盘启动器）

- **PWA**：`web/manifest.webmanifest` + `web/sw.js` + `web/icons/*`；支持 Edge/Chrome "安装为应用"，独立窗口、开始菜单/任务栏图标、今日/7 天快捷方式；
- **托盘启动器**：`desktop/tray.ps1` + `desktop/启动驾驶舱.bat`：常驻托盘、双击打开 app 窗口、启动网关、重启服务、退出；
- 文档：`docs/DESKTOP.md`（PWA / 托盘 / 后续 Electron·Tauri 安装包三条路线，含本机工具链检查）；
- 服务端新增 `.webmanifest` MIME。

---

## 0.10.0 — 2026-11-04（本机代理网关：多 provider 精确计数）

用户选定路线：不改各工具、不伪造数据，用**本机代理网关**捕获精确 usage。

### 实现

- `src/gateway/usage.mjs`：解析 OpenAI / Anthropic 的 JSON 与 SSE 响应中的官方 usage（缺失 → null，不估算）；
- `src/gateway/server.mjs`：127.0.0.1 反向代理；支持多上游 `/u/<name>/v1/...` 或单上游直通；只透传凭据、不记录；
- `src/gateway/log.mjs`：JSONL 落盘（仅元数据 + usage）；聚合按 provider/model/day，Tokens 精确、成本标"推算"；
- CLI：`gateway serve|status|stats|log`（`--json` 全支持）；
- `status.gateway`：本周期网关请求数、精确 tokens、未知 usage 数、按 provider 汇总；
- 配置：`gateway = { enabled, host(仅回环), port(默认 7891), upstreams[], captureLimitBytes }`。

### 精度口径

- tokens：**精确**（上游官方 usage；流式需上游在 chunk 中返回 usage，否则记未知）；
- cost：价格表推算（≈），未知模型 = null；
- 安全：不记录 Authorization / 正文 / 工具参数；只监听回环地址。

### 测试

- 新增 `test/gateway.test.mjs`：JSON/SSE 解析、代理注入（精确 usage 落盘、凭据不落盘）、配置归一。

---

## 0.9.0 — 2026-11-04（任务摘要同步 + 任务级归因）

按用户要求继续对齐 Codex 前三个差异项：

### 1) 任务摘要同步（对齐 task sync）

- 迁移 `0007_task_summaries.sql`：`task_sync(space, device, day, task_key, title, tokens, cost, last_at)`；
- `POST /v1/tasks`：每设备每天 ≤200 条任务摘要；客户端 `taskSummaries({day, tasks})`；
- `sync push` 在 `sync.shareTasks` 开启（默认）时自动推送当日任务摘要；
- **标题默认打码**（`sync.maskTaskTitles=true`）：`任务-<key前6位>`；可显式关闭打码共享明文标题；
- 成员列表返回 `tasks.rows`；团队报表按组员合并任务，展示"首任务/任务数"。

### 2) 舒适度同步默认开启

- `sync.shareComfort` 默认改为 **true**（对齐 Codex 通道）；可 `--set sync.shareComfort=false` 关闭；
- 仍只同步 1–5 等级 + 可选 ≤120 字备注。

### 3) 用量/归因升级为任务级

- 团队视图从"会话级≈任务"升级为**任务摘要级**（标题+token+成本+最近时间，按人/设备/日）；
- 未打码时可直接看到成员的任务标题；打码时保留任务粒度（key/数量/用量）。

### 验证

- 全量测试增加任务摘要用例；lint/coverage/audit/E2E 全绿（见下）。
- 说明：DSH 无独立 task 对象，"任务"仍以会话为粒度（比 Codex 的真实任务模型弱一档，但已到任务摘要级）。

---

## 0.8.0 — 2026-11-04（官方账号精准数据 + 精确优先策略）

### 1) 官方账号精准数据（ACCOUNT_V1）

经用户授权，新增读取 DSH 已保存账号授权（`~/.dsh/.credentials.yaml` 的 grant）调用 Platform 接口：

- `GET /api/v0/users/get_user_summary` → **官方余额**（normal/bonus wallets）+ **官方累计花费 total_costs**（精准值，非估算）；
- `GET /auth-api/v0/users/current` 仅作探测，不纳入状态；
- 新增 CLI `account [--refresh] [--json]`；`/api/account`；`status.account`；Web 双环底部优先展示官方余额。
- 安全边界：只读凭据文件；token 仅在内存中用于请求，不落盘、不写日志、不进错误信息；issuer 必须与配置 `account.origin` 一致；默认关闭，用户显式开启。

### 2) 精确优先（PRECISION_V1）

- `status.precision` 明确列出：**official（官方精准）/ measured（DSH usage 精准）/ derived（推算）**；
- 严格模式 `precision.strict=true`（默认）：推算值（模型/任务成本、Search/Fetch 服务费、预测）在 CLI/UI 以 **≈** 标注；官方账户数据不加 ≈；
- 实测：官方余额 `CNY 6.7239168000000000`、官方累计花费 `CNY 413.0773572800000000`（你的账号）。

### 3) 说明

- 公开余额 API（API Key）实测 401（DSH 保存的 key 已失效/轮换），因此官方余额改走账号 grant；
- "官方额度百分比/重置时间"在 DeepSeek 数据面不存在，仍以官方余额 + 官方累计花费 + 本地预算替代；不伪造百分比。

---

## 0.7.0 — 2026-11-04（任务聚合 + 可选舒适度同步）

按既定隐私决策补齐 Codex 的两条可选通道：

### 任务同步（仅聚合，不含标题）

- Worker：迁移 `0006_task_comfort.sql` 新增 `task_usage`；`POST /v1/task-stats` 只接收 `{days:[{date,tasks}]}`（0–10000 整数）；
- 成员列表返回 `taskStats.byDevice` 与每人 `todayTasks`；组员行汇总任务数；
- 客户端开关 `sync.shareTasks`（默认 **false**）：`sync push` 时额外推送今日任务数量；
- 隐私：不含标题、会话 id、项目、路径。

### 舒适度同步（可选，默认关）

- 表 `comfort_sync`；`POST /v1/comfort` 接收 `{level 1–5, note? ≤120}`，按"设备所属组员"归属；
- 开关 `sync.shareComfort`（默认 **false**）；CLI：`sync comfort <1-5> --note ...`；
- 成员列表返回今日舒适度；Web 成员行显示体感 emoji。

### 验证

- 测试：**102 tests / 101 pass / 1 skip**（新增任务/舒适度用例，含非法日期/等级校验）；
- lint 0 错误、覆盖率 91.17%、audit 通过、E2E 6/6；
- 开源开关默认关闭，符合"隐私优先"。

---

## 0.6.0 — 2026-11-04（团队对齐收尾：成本分摊 / 计划滑块 / 共享价格表）

继续按 Codex Cockpit 的团队契约补齐：

### 1) 个人成本分摊（cost-share）

- 组员行新增：`personCostCny`、`costShare = personCost / totalKnownCost`、`allocatedPercent = 共享已用% × costShare`、`coverage`（complete/partial）；
- 缺失成本显式标记（`missingDeviceIds` / `coverage=partial`），不把缺失当 0；
- Web 计划列显示"分摊 X%"，CLI 成员视图同步展示。

### 2) Web 每日计划滑块

- 成员 Tab 新增当日计划编辑条：**我的份额滑块（0–100%）+ 共享风险数字输入 + 保存**；
- 走 `POST /api/sync/dayplan`（basis + change），服务端 CAS；冲突提示后自动刷新；
- 风险任何成员可改、个人份额只能改自己的（服务端权限）。

### 3) 共享价格表（版本化）

- `shared_settings.pricing` + `costPolicy`：owner 发布价格表，所有设备可 adopt；
- CLI：`sync pricing publish`（发布本机生效价格）、`sync pricing status`（漂移对比）、`sync pricing adopt`（采用共享价格并清本地计价缓存，下次扫描重算）；
- 保证"同一份用量在各设备按同一单价计算"，否则共享计划失去意义。

### 验证

- 测试：**101 tests / 100 pass / 1 skip**；
- 本地端到端：pricing publish → status 一致 → 改本机价 → status 显示 1 个模型漂移 → adopt → 恢复一致；
- lint 0 错误、覆盖率 91.17%、audit 通过、E2E 6/6。

### 仍未对齐（需产品决策）

- 任务/舒适度同步（涉及标题与个人体感数据，隐私敏感）；
- 官方额度百分比（DSH 无该数据源，已用共享日预算替代）；
- 组员圆环颜色/个人体验曲线等展示层细节。

---

## 0.5.0 — 2026-11-04（团队 v2：对齐 Codex Cockpit 的组员模型与每日共享计划）

按 Codex Cockpit 的做法补齐三块：

### 1) 组员 ↔ 多设备（组员模型）

- 新增版本化共享配置 `GET/PUT /v1/shared-settings`：`{ schemaVersion:2, groups:[{id,name,deviceIds[]}], plan }`；
- 同一设备只能属于一个组员；owner 发布，`settings_revision` CAS，冲突 409（绝不静默覆盖）；
- 成员列表按"人"聚合（一人多设备），未归属设备单列；
- CLI：`sync groups list|add|rename|remove|assign|unassign`；
- Web「成员」Tab 按组员显示（设备数/今日用量/计划占比）。

### 2) 版本化共享配置 + 心跳

- `spaces.shared_settings` + `settings_revision`；`/v1/space/settings` 改计划时会同步写入 shared plan（单一来源）；
- 新增 `POST /v1/heartbeat`：设备上报采用的 `configRevision`；成员列表返回 `configStale`，Web/CLI 可发现配置落后设备。

### 3) 每日共享计划（对齐 shared daily plan）

- 迁移 `0005_shared_contract_v2.sql`：`daily_plans(space,day,cycle,value,revision)`；
- `POST /v1/daily-plan`：basis seed（首个设备写入当日基线）+ person/risk 独立修订 + 行级 CAS（冲突 409）；
- 权限：person 只能改"设备列表包含自己"的组员；risk 任何成员可改；
- 客户端算法 `src/sync/dayplan.mjs`（与 Codex 一致）：`U = min(R, R/D×f)`、`shared = min(R, U+(R−U)p²f)`；自动个人计划 = 建议 ÷ 人数，手动覆盖不重分配他人；计划日边界用北京 00:00（用量账本仍 04:00）；
- CLI：`sync dayplan`（查看/`--risk N`/`--person <id> --value N`）；Web 显示建议/已分配/风险、每人份额与超计划标记。

### 验证

- 测试：**101 tests / 100 pass / 1 skip**（新增 `test/team-v2.test.mjs` 5 例：共享配置 CAS、心跳、每日计划权限/冲突、客户端算法、组员归并）；
- 本地端到端（mock Worker）：init → plan → groups add → dayplan risk 40 → 个人份额 12% → 成员视图（rev1 手动、已用 60.1% ⚠ 超计划）；
- lint 0 错误；覆盖率 91.17%；audit 通过；E2E 6/6。

### 与 Codex 的差异

- **无法复刻**：官方额度百分比（DSH 无官方额度 API）→ 用共享日预算 `dailyTokenCap` 推导剩余百分比；
- **未做**：任务/体验同步、个人成本分摊曲线（`cost-share-v1`）、每日计划前端滑块（当前 CLI/只读展示）。

---

## 0.4.2 — 2026-11-04（免费计划支持）

- Worker 新增 `ALLOW_NO_RATE_LIMITER=1` 降级模式：免费计划（无 Rate Limiting 绑定）可部署，仅跳过限流；鉴权/邀请/设备上限/快照校验/单调守卫全部保留；响应带 `x-cockpit-degraded: no-rate-limiter`。
- 新增 `cloud/usage-sync-worker/wrangler.free-plan.toml`（免费计划模板，`workers_dev=true`、无 limiter、设备上限 8）。
- 文档：SYNC §3.2 区分 Paid / Free 两套配置；README 增加计划选择说明。
- 测试：新增"降级放行 + bootstrap 校验仍生效"用例（sync 37 例）。

---

## 0.4.1 — 2026-11-04（团队 CLI 一键化）

- 新增 `sync init`：用 `DSH_COCKPIT_BOOTSTRAP_SECRET` 创建空间，自动写入 `sync.endpoint/spaceLabel/deviceId/deviceName`，并打印**邀请码 + owner 令牌（只显示一次）**。
- 新增 `sync invite`：owner 生成新邀请码（24h 单次），并打印第二台设备的入组命令。
- `sync enroll` 打印设备令牌（只显示一次）与后续步骤；未入组设备自动生成稳定 `deviceId`（修复此前 enroll 缺少 deviceId 的 400）。
- `sync status` 增加「本机设备（名称/ID）」行。
- 文档：SYNC §3.3/§4.1、README、USER-GUIDE 改为 CLI 一键流程（不再需要 curl）。
- 本地全流程验证：init → push → invite → enroll → push → members → plan（2 成员、计划占比 96.96% 正确）。
- 测试：95 tests / 94 pass / 1 skip（CLI 行为由本地端到端脚本验证）。

---

## 0.4.0 — 2026-11-04（团队 v1：设备即成员 + 共享计划）

把"成员/设备/共享计划"从"补不了"补到可用的 80%：不引入 DSH 账号体系，用**设备即成员**实现。

### Worker / 协议（v1.1.0）

- 迁移 `0002_space_settings.sql`：`spaces.settings`（JSON，共享计划）。
- 新增端点：`GET /v1/members`（成员 + 快照摘要）、`POST /v1/members/rename`（owner 或本人）、`GET/PUT /v1/space/settings`（PUT 仅 owner）。
- 权限：读=任意活跃成员；改名=owner 或本人；改计划/撤销=仅 owner；撤销设备仍保留在列表（`revokedAt`）。
- 校验：`dailyTokenCap ∈ [0,1e12]`、`dayTotalPercent ∈ [10,100]`、`note ≤200`；未知字段 400。

### 客户端 / CLI / API

- `client.mjs` 新增 `members() / renameMember() / getSpaceSettings() / saveSpaceSettings()`。
- 本地 config：`sync.deviceId`、`sync.deviceName`（enroll 后持久化）；`/api/sync/status` 返回设备身份。
- 本地 API：`GET /api/sync/members`、`POST /api/sync/members/rename|remove`、`GET/PUT /api/sync/space`。
- CLI：`sync members`、`sync plan --daily-token-cap --day-total-percent`、`sync rename <deviceId> --name`、`sync remove <deviceId>`。

### Web

- 任务区新增「成员」Tab：成员名/角色/今日 tokens·成本/计划占比/最后同步/改名·移除。
- 共享计划编辑（每日上限 + 建议%）；未开启/离线空态；本机行标记「本机」。
- i18n 中文/英文完整覆盖；E2E 新增成员 Tab 用例（6/6）。

### 验证

- `node --test "test/*.test.mjs"`：**95 tests / 94 pass / 1 skip**（新增 3 个团队用例：Worker 权限/计划/撤销、非法计划、报表聚合与离线降级）。
- E2E **6/6**；lint 0 错误；覆盖率 91.17%；`audit:public` 通过。
- 限制：共享计划是**建议性**（DSH 无法在请求层限流）；1 设备 = 1 成员（多设备归并为未决项）。

---

## 0.3.1 — 2026-11-04（可配置对账窗口）

- 新增 `balance.reconcileWindowMs`（默认 24h，范围 1h–7d），可按需缩短。
- 对账新增**回退模式**：窗口内无更早快照时，自动改用"自首个快照起"（要求 ≥1h），`mode=since-first`、`windowActualMs` 给出实际跨度；<1h 则提示暂不能对账。
- `reconcileBalance()` 新增 `selectReconcileBaseline()`；本地估算窗口与官方扣费基线严格对齐。
- CLI/文档同步：对账行显示 `24h 对账` / `自首个快照 Nh 对账`。
- 测试：余额用例扩至 5 个（含 since-first、自定义窗口、配置夹取断言）；全量 92 tests / 91 pass / 1 skip。

---

## 0.3.0 — 2026-11-04（官方余额实时对账）

把"官方额度真值"补到可对账：按需实时读取官方余额，并用 24h 窗口对比本地估算。

### 新增

- **实时余额**：`GET /user/balance` 按需拉取（默认 15s TTL 防抖 + 并发合并）；**打开仪表盘/`?refresh=1`/手动刷新都会取最新值**，手动刷新绕过 TTL。
- **对账**：24h 窗口 `Δ官方余额` vs 本地估算（模型成本 + Search/Fetch 服务费）→ `officialSpend/localSpend/drift/driftPercent`；充值或赠金变化自动标记 `topupDetected`。
- **快照**：`~/.dsh-cockpit/balance.json` 仅存 `{at,currency,total,granted,toppedUp}`，保留 7 天/最多 500 条，尽力 0600。
- **HTTP**：新增 `GET /api/balance?refresh=1`；`GET /api/status` 新增 `balance` 段（含对账）。
- **CLI**：新增 `balance [--refresh] [--json]`；`status` 增加「官方余额」行。
- **Web**：双环底部新增「官方余额」；打开页面与手动刷新强制实时；自动轮询走 TTL。
- **配置**：`balance.enabled`（默认 **false**，显式开启）、`ttlMs`、`timeoutMs`。

### 安全与边界

- Key 只从环境变量 `DEEPSEEK_API_KEY` 读取；不落盘、不写日志、错误信息不含 Key（测试守护）。
- 快照只存金额与时间，不含账户标识/Key。
- 关闭时零网络；失败（无 Key/401/402/超时/网络）只影响余额卡，不影响其它数据。

### 验证

- `node --test "test/*.test.mjs"`：**92 tests / 91 pass / 1 skip**（新增 5 个余额用例：归一/401/超时/TTL/并发/对账/集成）。
- 覆盖率 91.05%；lint 0 错误；audit 通过；真实 401 路径与 Key 不落盘已实测。

---

## 0.2.3 — 2026-11-03（官方生态知识补全 / 文档）

对 `deepseek-ai` GitHub 组织（46 个公开仓库）做全量盘点后，回写与产品直接相关的官方事实。

### 文档

- `docs/OFFICIAL-FACTS.md`：新增模型版本号（V4.1-Flash-1017 / V4-Pro-0813）、能力位（vision 仅 flash、FIM 仅非思考）、**上下文缓存语义（前缀单元 + SWA）**、官方 Harness/仓库引用、官方 tokenizer 升级路径。
- `docs/PRICING.md`：价格表增加"模型版本"列。
- `README.md`：新增「官方生态」章节（Harness、DSH 文档、DeepInfer、deepseek-recipe、awesome 列表、官方文档）。
- 外部知识库：`../deepseek-ai-org/KNOWLEDGE-BASE.md`（46 仓全景、技术演进、基础设施栈、许可与知识缺口）。

### 无代码变更

价格/算法/测试均未改动（`node --test "test/*.test.mjs"` 仍 87 tests / 86 pass / 1 skip）。

---

## 0.2.2 — 2026-11-03（P1/P2/P3 三项补齐）

在官方价格对齐之后，补齐此前标记为"未纳入"的三项能力。

### P1 — Search / Fetch 服务费（`SERVICE_V1`，近似计入）

- 采集 `tool/call(web_search|web_fetch)` 与 `tool/result` 配对，按**成功调用** × ¥0.005（官方 5 元/1000 次）计费；
- 失败调用不计费；一次搜索可能触发多次 provider 请求 → 标注为**下限估计**；
- `budget.includeServiceFees`（默认 true）：金额预算口径下计入总成本；token 预算不受影响；
- 新增 `status.serviceFees`、`breakdown.services`、小票服务行、CLI `status` 服务费行。

### P2 — 可靠性统计（`llm/retry`）

- 统计重试次数、`failure.code` 分布（RATE_LIMIT/TRANSPORT/SERVER）、限流次数、工具失败率；
- 新增 `status.reliability`（含 `toolErrorRate` / `retriesPerMessage`）；
- 新增洞察规则：限流重试偏多 / 工具失败率偏高 / 重试比例偏高。

### P3 — 缺失 usage 的字符估算（`ESTIMATION_V1`，默认关闭）

- `estimation.fallback = "chars"` 时，按官方比例（中文 0.6、其他 0.3 token/字符）估算；
- 结果只进 `status.estimation`，**不计入成本与总量**；只统计字符数、不保留文本；
- 默认 `none`，维持"缺失 ≠ 0"。

### 其它

- CLI `status` 支持 `--range/--from/--to/--model/--project/--task` 并正确切换展示口径；
- `STATE_SCHEMA_VERSION` 升到 2（摘要结构变化，旧缓存自动失效重算）。

### 真实数据验证（2026-11-03）

| 项 | 结果 |
|---|---|
| Search / Fetch | 成功 343（Search 146 / Fetch 197）、失败 45 → **¥1.715** |
| 可靠性 | 重试 120 次（RATE_LIMIT 57 / TRANSPORT 39 / SERVER 24）；工具失败率 2.7% |
| 全量成本 | 45.3 亿 token → 模型 ¥202.84 + 服务费 ¥1.72 = **¥204.56** |
| 测试 | 87 tests / 86 pass / 1 skip |

---

## 0.2.1 — 2026-11-03（官方价格对齐 / PRICING_V2）

按官方价格页（2026-11-03 核对）重写成本模型。

### 变更

- **价格表更新**：`deepseek-flash` 高峰价 输入 2 / 缓存命中 0.04 / 输出 8（¥/百万 tokens）；`deepseek-v4-pro` 9 / 0.30 / 27。
- **高峰/空闲双价**：北京时间工作日 09:00–12:00、14:00–18:00 为高峰；其余（周末、节假日全天）空闲 ×0.5；**按消息时间戳逐条判定**。
- **法定节假日**：新增 `pricingPolicy.holidays` 配置（默认空，需维护者填写）。
- **模型别名**：`deepseek-v4-flash` / `-vision-exp` → flash；`deepseek-pro` → v4-pro。
- **缓存失效**：`state.json` 增加 `pricingVersion`，价格政策变更后自动全量重算历史成本。
- `/api/config` 新增 `pricingPolicy` 与 `pricingMeta`（高峰窗口、idleRatio、参考日期、口径说明）。
- `/api/status` 新增 `pricingNow`（当前时段是高峰还是空闲、系数）。
- 文档：重写 `docs/PRICING.md`；新增 `docs/OFFICIAL-FACTS.md`（官方事实纳入/未纳入映射）。

### 未纳入（明确声明）

- **Search / Fetch 按次计费**（5 元/1000 次）：DSH 会话事件不含该信息。
- 并发限制、请求错误码、`user_id` 隔离、keep-alive：不代理请求，本地不可观测。
- Tokenizer 字符换算、离线 tokenizer：以模型返回 usage 为准。

### 验证

- `node --test "test/*.test.mjs"`：83 tests / 82 pass / 1 skip（新增高峰/空闲/边界/节假日/别名用例）。
- 真实数据：128 会话、当日 1.74 亿 token、按新价 ≈ ¥8.88（旧价口径 ¥30+），缓存自动失效重扫 6.2s。

---

## 0.2.0 — 2026-11-04（全量技术移植 / Phase 2）

在 0.1.0 内核之上，把 Codex Cockpit 的可迁移技术能力全部补齐（PARITY P0/P1/P2）。

### 新增能力

- **范围与筛选**：`range`（cycle/today/7d/30d/90d/all/custom）+ model/project/task/includeSubagents 过滤，贯穿 status/history/tasks/projects/insights/receipt。
- **任务级归因**：`/api/tasks`（搜索/排序/分页/占比）、`/api/projects`、`/api/subagents`（父子树）；会话标题打码复用。
- **洞察引擎**：规则化 9 类洞察（任务集中度/模型集中度/预算/配速/上下文/压缩频率/成本尖峰/体感/闲置）。
- **通知**：预算/上限/压缩/配速告警、未读状态、`/api/notifications/read`、CLI `notify` / `watch`。
- **风险热力图**：配速×压缩风险二维网格（`/api/riskmap` + status 内联）。
- **日历下钻**：`/api/calendar?month`（当日 tokens/成本/体感/Top 任务/Top 模型），Web 点击热力即可查看。
- **小票构建器**：GET/POST `/api/receipt`，支持勾选任务、范围、标题；2× canvas PNG + 剪贴板降级。
- **舒适度扩展**：分箱模型、历史日历、拟合曲线三合一；`GET /api/comfort`。
- **双控件**：个人上限（`budget.dailyCapPercent`）+ 今日总建议（`budget.dayTotalPercent`），接入 plan 输出。
- **备份/恢复**：`/api/backup`、`/api/restore`、CLI `backup` / `restore --dry-run`。
- **i18n / 主题 / 字号**：zh/en 字典、dark/light/auto、fontScale、density（均为配置项）。
- **团队同步（可选，默认关闭）**：Cloudflare Worker + D1（令牌 SHA-256、邀请 24h 单次、≤32 设备、`payload_hash` 去重 + `_ts` 单调守卫、限流 fail-closed）；Node 客户端（enroll/push/pull/revoke、退避重试）；`/api/sync/*` 与 CLI `sync`；快照仅聚合、**非 E2E 加密**已披露。
- **工程能力**：80 测试（+35 同步、+12 v2）、Playwright E2E 5 路径、lint（6 规则）、覆盖率门禁（src/core 89.90%）、CI 3 OS × Node 22/24 + Linux 三时区矩阵、`skills/dsh-cockpit/` 与 `docs/SKILLS.md`。
- **配置升级**：`schemaVersion 2`，v1 自动迁移；新增 `ui/notify/sync` 分组。

### 变更

- `package.json`: `test` 改为 `node --test "test/*.test.mjs"`（避免误跑 `test/e2e`）；新增 `lint`/`coverage`/`test:e2e`/`test:e2e:smoke`；devDependency `@playwright/test`。
- `/api/status` 增 `range`/`riskMap`/`insights`/`notifications`/`comfort.binned`；旧字段全部保留。
- 统计日界沿用 Asia/Shanghai 04:00；`range` 只影响统计范围，额度/配速/计划始终基于预算周期。

### 测试与验收（2026-11-04 本机）

| 项 | 结果 |
|---|---|
| `node --test "test/*.test.mjs"` | 80 tests / 79 pass / 1 skip |
| `node scripts/lint.mjs` | 0 错误（60 条冻结文件行宽告警） |
| `node scripts/coverage.mjs` | src/core 行覆盖 89.90%（≥70%） |
| `npx playwright test` | 5/5（首屏/范围/任务表/小票/设置，连跑稳定） |
| `node test/e2e/smoke.node.mjs --strict` | 26/26 |
| `npm run audit:public` | 通过 |
| 真实数据 | 124 会话 / 16,287 条 usage / 0 错误；7 天 4.49 亿 token / ¥107 |
| Web 渲染 | headless Chrome 1440×2200 真实数据渲染成功（`docs/dashboard-v2.png`） |

### 已知限制

- 桌面悬浮窗/托盘/签名安装包：不提供（不适用，见 `docs/PARITY.md` §8）。
- 团队同步默认关闭、非 E2E 加密；保留期/删除由运营者负责。
- `insights.mjs` 覆盖 66%（低于单文件建议值），可在 P1 补齐分支用例。
- Node 22 未本机实测（CI 矩阵覆盖）。

---

## 0.1.0 — 2026-11-03（MVP / M1–M3）

首个可用版本：会话解码（多帧 zstd）、usage 聚合、成本/配速/计划/压缩预测/舒适度、CLI 9 命令、HTTP API v1、Web 仪表盘 v1、DSH Cordis 插件、29 测试与真实数据验收（124 会话 / 16,224 usage / 0 错误）。
