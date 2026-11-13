#!/usr/bin/env node
/**
 * dsh-cockpit CLI（PRD FR-9）。
 * 与 Web/插件共享同一个核心：`src/core/index.mjs`。
 */
import { readFileSync, existsSync, copyFileSync, appendFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildStatus,
  buildBalanceReport,
  buildAccountReport,
  buildReceipt,
  scanSessions,
  buildTasks,
  buildProjects,
  buildSubagents,
  buildInsightsReport,
  buildCalendarReport,
  buildNotificationsReport,
  buildBackup,
  restoreBackup,
} from "./core/index.mjs";
import { loadConfig, saveConfig, loadComfort, recordComfort } from "./core/config.mjs";
import { dshHome, sessionsRoot, cockpitHome } from "./core/paths.mjs";
import { discoverSessions, zstdAvailable } from "./core/session-reader.mjs";
import { startServer } from "./server.mjs";
import { createSyncClientFromConfig, buildSnapshotFromStatus, mergeRemote, isSyncEnabled } from "./sync/client.mjs";
import { buildTeamReport } from "./sync/team.mjs";
import { personPlanChange, riskPlanChange } from "./sync/dayplan.mjs";
import { DEFAULT_PRICING } from "./core/pricing.mjs";
import { formatBeijingHm, cycleDateKey } from "./core/time.mjs";
import { createGatewayServer } from "./gateway/server.mjs";
import { readGatewayRecords, summarizeGateway, gatewayLogPath } from "./gateway/log.mjs";

const PROJECT_ROOT = fileURLToPath(new URL("..", import.meta.url));
const VERSION = (() => {
  try {
    return JSON.parse(readFileSync(join(PROJECT_ROOT, "package.json"), "utf8")).version;
  } catch {
    return "0.0.0";
  }
})();

const USE_COLOR = process.stdout.isTTY && !process.env.NO_COLOR;
const c = {
  dim: (s) => (USE_COLOR ? `\x1b[2m${s}\x1b[0m` : s),
  bold: (s) => (USE_COLOR ? `\x1b[1m${s}\x1b[0m` : s),
  cyan: (s) => (USE_COLOR ? `\x1b[36m${s}\x1b[0m` : s),
  amber: (s) => (USE_COLOR ? `\x1b[33m${s}\x1b[0m` : s),
  red: (s) => (USE_COLOR ? `\x1b[31m${s}\x1b[0m` : s),
  green: (s) => (USE_COLOR ? `\x1b[32m${s}\x1b[0m` : s),
};

function parseArgs(argv) {
  const flags = {};
  const positional = [];
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token.startsWith("--")) {
      const body = token.slice(2);
      const eq = body.indexOf("=");
      if (eq !== -1) flags[body.slice(0, eq)] = body.slice(eq + 1);
      else if (argv[index + 1] && !argv[index + 1].startsWith("--") && !["force", "json", "md", "open", "apply", "dry-run"].includes(body)) {
        flags[body] = argv[index + 1];
        index += 1;
      } else flags[body] = true;
    } else {
      positional.push(token);
    }
  }
  return { flags, positional };
}

const nf = new Intl.NumberFormat("zh-CN");
const cf = new Intl.NumberFormat("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 4 });

/** CJK 显示宽度感知的左侧标签对齐（避免中文把分隔挤没）。 */
function displayWidth(text) {
  let width = 0;
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    width += code >= 0x1100 && (code <= 0x115f || (code >= 0x2e80 && code <= 0xa4cf) || (code >= 0xac00 && code <= 0xd7a3) || (code >= 0xf900 && code <= 0xfaff) || (code >= 0xfe30 && code <= 0xfe6f) || (code >= 0xff00 && code <= 0xff60) || (code >= 0xffe0 && code <= 0xffe6)) ? 2 : 1;
  }
  return width;
}

function padLabel(text, width = 16) {
  const gap = Math.max(1, width - displayWidth(text));
  return text + " ".repeat(gap);
}
function fmtTokens(value) {
  return Number.isFinite(value) ? nf.format(value) : "—";
}
function fmtPercent(value) {
  return Number.isFinite(value) ? `${value.toFixed(1)}%` : "—";
}
function fmtCny(value) {
  return Number.isFinite(value) ? `¥${cf.format(value)}` : "—";
}
function line(label, value) {
  return `${c.dim(padLabel(label))}${value}`;
}
function badge(status) {
  if (status === "on_track") return c.green("● on_track");
  if (status === "over_pace") return c.amber("● over_pace");
  return c.dim("● unknown");
}

async function cmdStatus(flags) {
  const status = await buildStatus({
    force: flags.force === true,
    range: flags.range,
    from: flags.from,
    to: flags.to,
    model: flags.model,
    project: flags.project,
    task: flags.task,
  });
  if (flags.json) {
    console.log(JSON.stringify(status, null, 2));
    return 0;
  }
  const unit = status.quota.unit === "cny" ? "¥" : "";
  const used = status.quota.unit === "cny" ? fmtCny(status.quota.used) : fmtTokens(status.quota.used);
  const limit = status.quota.unit === "cny" ? fmtCny(status.quota.limit) : fmtTokens(status.quota.limit);
  console.log(`${c.bold("DSH 驾驶舱")} ${c.dim(`v${VERSION}`)}  ${c.dim(status.generatedAt)}`);
  console.log(c.dim("─".repeat(64)));
  console.log(line("模式", status.mode === "balance" ? "账户余额" : "本地（只读）"));
  console.log(line(status.quota.label, `${used} / ${limit}  (${fmtPercent(status.quota.usedPercent)})`));
  console.log(line("配速", `${badge(status.pace.status)}  建议 ${fmtPercent(status.pace.recommendedUsedPercent)} · 实际 ${fmtPercent(status.pace.usedPercent)} · 超 ${fmtPercent(status.pace.overByPercent)}`));
  console.log(line("上下文", `${fmtPercent(status.context.percent)}  (${fmtTokens(status.context.pressure)} / ${fmtTokens(status.context.contextWindow)})`));
  console.log(line("今日建议", `${fmtPercent(status.plan.suggestedUsagePercent)}  ${c.dim(`均匀 ${fmtPercent(status.plan.uniformPacePercent)} + 风险加成 ${fmtPercent(status.plan.resetRiskBoostPercent)}；上限 ${fmtPercent(status.plan.softCapPercent)}`)}`));
  console.log(line("压缩预测", `${fmtPercent(status.forecast.score)} / ${status.forecast.windowHours}h${Number.isFinite(status.forecast.etaHours) ? `  ${c.dim(`预计 ${status.forecast.etaHours}h 后`)}` : ""}`));
  const rangeView = status.range.kind !== "cycle";
  const shownTokens = rangeView ? status.totals.rangeTokens : status.totals.cycleTokens;
  const shownCost = rangeView ? status.totals.rangeCostCny : status.totals.cycleCostCny;
  const approx = status.precision?.strict ? "≈" : "";
  console.log(line(rangeView ? `范围(${status.range.label})` : "本周期", `${fmtTokens(shownTokens)} tokens · ${approx}${fmtCny(shownCost)} · ${status.totals.sessions} 个会话`));
  console.log(
    line(
      "服务费",
      `${approx}${fmtCny(status.serviceFees?.costCny ?? 0)}  ${c.dim(
        `Search ${status.serviceFees?.rows?.[0]?.success ?? 0} 次 / Fetch ${status.serviceFees?.rows?.[1]?.success ?? 0} 次（成功计费，下限估计）`,
      )}`,
    ),
  );
  console.log(line("可靠性", `重试 ${status.reliability?.retries ?? 0} · 429 ${status.reliability?.rateLimit ?? 0} · 工具失败 ${fmtPercent((status.reliability?.toolErrorRate ?? 0) * 100)}`));
  console.log(line("官方余额", formatBalanceShort(status.balance)));
  if (status.account?.available) {
    console.log(line("官方账户", `${status.account.currency ?? ""} ${status.account.normalBalance ?? "—"}  ${c.dim(`官方累计花费 ${status.account.totalCost ?? "—"}`)}`));
  }
  if (status.estimation?.enabled && status.estimation.messages > 0) {
    console.log(line("估算", c.dim(`缺 usage ${status.estimation.messages} 条 → ≈${fmtTokens(status.estimation.tokens)} tokens（未计入成本）`)));
  }
  console.log(line("健康", `${status.health.sessionsScanned} 会话 · ${status.health.errors} 错误 · ${status.health.durationMs}ms · 缓存命中 ${fmtPercent((status.health.cacheHitRate ?? 0) * 100)}`));
  if (status.warnings?.length) console.log(line("告警", c.amber(status.warnings.join("；"))));
  if (status.quota.isDefaultBudget) {
    console.log(line("提示", c.dim("当前使用默认预算 2,000,000 tokens；建议按实际用量设置：dsh-cockpit config --set budget.tokens=10000000")));
  }
  if (status.health.partialCost) console.log(line("提示", c.dim(`部分 token 无可计价模型（未知 ${fmtTokens(status.health.costUnknownTokens)}）`)));
  return 0;
}

async function cmdScan(flags) {
  const { config } = loadConfig();
  const result = scanSessions({ config, force: flags.force === true });
  const payload = {
    sessionsScanned: result.summaries.length,
    sessionsDiscovered: result.stats.seen,
    errors: result.errors.length,
    durationMs: result.durationMs,
    cacheHitRate: result.summaries.length ? Math.round((result.cacheHits / result.summaries.length) * 100) / 100 : 0,
    messagesWithUsage: result.summaries.reduce((sum, item) => sum + (item.counts?.usageMessages ?? 0), 0),
    errorsDetail: result.errors.slice(0, 5),
  };
  if (flags.json) console.log(JSON.stringify(payload, null, 2));
  else {
    console.log(`${c.bold("扫描完成")}  ${result.durationMs}ms`);
    console.log(line("会话", `${payload.sessionsScanned} / 发现 ${payload.sessionsDiscovered}`));
    console.log(line("用量消息", fmtTokens(payload.messagesWithUsage)));
    console.log(line("错误", payload.errors === 0 ? c.green("0") : c.red(String(payload.errors))));
    console.log(line("缓存命中", fmtPercent(payload.cacheHitRate * 100)));
    for (const error of payload.errorsDetail) console.log(line("  失败", `${error.message}`));
  }
  return result.errors.length > 0 && result.summaries.length === 0 ? 1 : 0;
}

function reconcileWindowLabel(rec) {
  if (!rec || rec.mode === null) return "";
  if (rec.mode === "since-first") {
    const hours = Math.max(1, Math.round((rec.windowActualMs ?? 0) / 3_600_000));
    return `自首个快照 ${hours}h`;
  }
  return `${Math.round((rec.windowMs ?? 86_400_000) / 3_600_000)}h`;
}

function formatBalanceShort(balance) {
  if (!balance) return c.dim("—");
  if (!balance.enabled) return c.dim("未开启（config --set balance.enabled=true，且需 DEEPSEEK_API_KEY）");
  if (!balance.available) return c.dim(`不可用：${balance.error?.message ?? "未知错误"}`);
  const fresh = balance.cached ? "缓存" : "实时";
  const rec = balance.reconciliation?.available
    ? ` · ${reconcileWindowLabel(balance.reconciliation)} 官方 ${fmtCny(balance.reconciliation.officialSpend)} vs 本地 ${fmtCny(balance.reconciliation.localSpend)}${balance.reconciliation.driftPercent === null ? "" : `（偏差 ${balance.reconciliation.driftPercent > 0 ? "+" : ""}${Number(balance.reconciliation.driftPercent).toFixed(1)}%）`}`
    : "";
  return `${fmtCny(balance.total)}${c.dim(`  ${balance.currency ?? "CNY"} · ${fresh} ${balance.fetchedAt?.slice(11, 19) ?? ""}${rec}`)}`;
}

async function cmdBalance(flags) {
  const refresh = flags.refresh === true || flags.refresh === "true" || flags.force === true;
  const report = await buildBalanceReport({ refresh });
  if (flags.json) {
    console.log(JSON.stringify(report, null, 2));
    return 0;
  }
  console.log(`${c.bold("官方余额")}  ${c.dim(report.policyVersion ?? "")}`);
  console.log(c.dim("─".repeat(64)));
  if (!report.enabled) {
    console.log(c.dim(report.hint ?? "未开启"));
    return 0;
  }
  if (!report.available) {
    console.log(c.dim(`不可用：${report.error?.message ?? "未知错误"}`));
    if (report.error?.code === "BALANCE_NO_API_KEY") console.log(c.dim("请先在终端设置：$env:DEEPSEEK_API_KEY=\"sk-...\"（PowerShell）"));
    return 0;
  }
  console.log(line("总余额", `${fmtCny(report.total)} ${report.currency ?? "CNY"}`));
  console.log(line("赠金余额", report.granted === null ? "—" : fmtCny(report.granted)));
  console.log(line("充值余额", report.toppedUp === null ? "—" : fmtCny(report.toppedUp)));
  console.log(line("取数", `${report.cached ? "缓存" : "实时（官方 API）"} · ${report.fetchedAt ?? "—"}${Number.isFinite(report.ageMs) ? ` · ${report.ageMs}ms 前` : ""}`));
  const rec = report.reconciliation;
  if (rec?.available) {
    console.log(line(`${reconcileWindowLabel(rec)} 对账`, `官方 ${fmtCny(rec.officialSpend)} · 本地 ${fmtCny(rec.localSpend)} · 偏差 ${rec.drift === null ? "—" : fmtCny(rec.drift)}${rec.driftPercent === null ? "" : `（${rec.driftPercent > 0 ? "+" : ""}${rec.driftPercent}%）`}`));
    console.log(c.dim(`  ${rec.note}`));
  } else if (rec) {
    console.log(line("对账", c.dim(rec.note)));
  }
  return 0;
}

async function cmdAccount(flags) {
  const refresh = flags.refresh === true || flags.refresh === "true";
  const report = await buildAccountReport({ refresh });
  if (flags.json) { console.log(JSON.stringify(report, null, 2)); return 0; }
  console.log(`${c.bold("官方账户")}  ${c.dim(report.policyVersion ?? "")}`);
  console.log(c.dim("─".repeat(64)));
  if (!report.enabled) { console.log(c.dim(report.hint ?? "未开启")); return 0; }
  if (!report.available) {
    console.log(c.dim(`不可用：${report.error?.message ?? "未知错误"}`));
    if (report.error?.hint) console.log(c.dim(report.error.hint));
    return 0;
  }
  console.log(line("账户余额", `${report.currency ?? ""} ${report.normalBalance ?? "—"}  ${c.dim("（官方精准值）")}`));
  console.log(line("赠金余额", `${report.currency ?? ""} ${report.bonusBalance ?? "—"}`));
  console.log(line("官方累计花费", `${report.currency ?? ""} ${report.totalCost ?? "—"}  ${c.dim("（total_costs，官方账单口径）")}`));
  console.log(line("取数", `${report.cached ? "缓存" : "实时（官方账号接口）"} · ${report.fetchedAt ?? "—"}${Number.isFinite(report.ageMs) ? ` · ${report.ageMs}ms 前` : ""}`));
  return 0;
}

async function cmdPlan(flags) {
  const status = await buildStatus({ force: flags.force === true });
  if (flags.json) {
    console.log(JSON.stringify({ plan: status.plan, forecast: status.forecast, pace: status.pace }, null, 2));
    return 0;
  }
  console.log(`${c.bold("今日计划")}`);
  console.log(line("建议使用", c.cyan(fmtPercent(status.plan.suggestedUsagePercent))));
  console.log(line("分解", `均匀 ${fmtPercent(status.plan.uniformPacePercent)} + 风险加成 ${fmtPercent(status.plan.resetRiskBoostPercent)}`));
  console.log(line("疲劳上限", fmtPercent(status.plan.softCapPercent)));
  console.log(line("压缩风险", `${fmtPercent(status.plan.riskPercent)}（${status.forecast.source}）`));
  for (const factor of status.forecast.factors ?? []) console.log(line("  因素", c.dim(factor)));
  console.log(line("配速", `${badge(status.pace.status)} 建议 ${fmtPercent(status.pace.recommendedUsedPercent)}`));
  return 0;
}

async function cmdReport(flags) {
  const days = Number.parseInt(flags.days ?? "30", 10);
  const status = await buildStatus({ force: flags.force === true });
  const lines = [];
  lines.push(`# DSH 驾驶舱报告`);
  lines.push("");
  lines.push(`- 生成时间：${status.generatedAt}`);
  lines.push(`- 统计周期：${status.quota.label}（${status.quota.cycleStart} → ${status.quota.cycleEnd}）`);
  lines.push(`- 本周期：${fmtTokens(status.totals.cycleTokens)} tokens / ${fmtCny(status.totals.cycleCostCny)}`);
  lines.push(`- 配速：${status.pace.status}（实际 ${fmtPercent(status.pace.usedPercent)}，建议 ${fmtPercent(status.pace.recommendedUsedPercent)}）`);
  lines.push(`- 压缩预测：${fmtPercent(status.forecast.score)} / ${status.forecast.windowHours}h`);
  lines.push("");
  lines.push("## 模型分布");
  lines.push("");
  lines.push("| 模型 | tokens | 成本 | 消息数 |");
  lines.push("| --- | ---: | ---: | ---: |");
  for (const row of status.breakdown.models) lines.push(`| ${row.model} | ${fmtTokens(row.tokens)} | ${fmtCny(row.costCny)} | ${row.messages} |`);
  lines.push("");
  lines.push("## 会话 Top");
  lines.push("");
  lines.push("| 会话 | tokens | 成本 |");
  lines.push("| --- | ---: | ---: |");
  for (const row of status.breakdown.sessions) lines.push(`| ${row.title} | ${fmtTokens(row.tokens)} | ${fmtCny(row.costCny)} |`);
  lines.push("");
  lines.push("## 最近趋势");
  lines.push("");
  lines.push("| 日期 | tokens | 成本 | 舒适度 | 状态 |");
  lines.push("| --- | ---: | ---: | ---: | --- |");
  for (const row of status.history.slice(-days)) lines.push(`| ${row.date} | ${fmtTokens(row.tokens)} | ${fmtCny(row.costCny)} | ${row.comfort ?? "—"} | ${row.status} |`);
  const text = lines.join("\n");
  if (flags.md) console.log(text);
  else console.log(text);
  return 0;
}

async function cmdGateway(positional, flags) {
  const sub = positional[0] ?? "status";
  const { config } = loadConfig();
  const gateway = config.gateway ?? {};
  const fmtInt = (value) => (Number.isFinite(value) ? nf.format(value) : "—");
  if (sub === "serve") {
    if (flags.port !== undefined) gateway.port = Number(flags.port);
    const instance = createGatewayServer({ config: gateway });
    const url = await instance.start();
    console.log(`${c.green("网关已启动")}  ${url}`);
    console.log(line("上游", instance.gateway.upstreams.map((item) => `${item.name}=${item.origin}`).join(" · ") || "—"));
    console.log(line("日志", instance.logPath));
    console.log(c.dim("把工具 base_url 指到：" + url + "/v1（多上游用 /u/<name>/v1）；Ctrl+C 停止。"));
    await new Promise(() => undefined);
    return 0;
  }
  const records = readGatewayRecords(process.env, { sinceMs: sub === "stats" && flags.range !== "all" ? Date.now() - 7 * 86_400_000 : null });
  const summary = summarizeGateway(records, { pricing: config.pricing, pricingPolicy: config.pricingPolicy });
  if (sub === "log") {
    const limit = Math.min(Math.max(Number(flags.limit) || 10, 1), 100);
    if (flags.json) { console.log(JSON.stringify(records.slice(-limit), null, 2)); return 0; }
    for (const row of records.slice(-limit)) {
      console.log(`${new Date(row.at).toISOString()}  ${row.provider ?? "?"}  ${row.model ?? "?"}  status=${row.status}  ${row.usage ? "tokens=" + (row.usage.inputTokens ?? "?") + "+" + (row.usage.outputTokens ?? "?") : c.dim("usage 缺失")}`);
    }
    return 0;
  }
  if (flags.json) { console.log(JSON.stringify({ ...gateway, path: gatewayLogPath(process.env), summary }, null, 2)); return 0; }
  console.log(`${c.bold("本机网关")}  ${gateway.enabled ? c.green("已启用") : c.dim("未启用（config --set gateway.enabled=true）")}`);
  console.log(line("监听", `${gateway.host ?? "127.0.0.1"}:${gateway.port ?? 7891}`));
  console.log(line("上游", (gateway.upstreams ?? []).map((item) => `${item.name}=${item.origin}`).join(" · ") || "—"));
  console.log(line("日志", gatewayLogPath(process.env)));
  console.log(line("请求", `${fmtInt(summary.requests)} 条 · 未知 usage ${fmtInt(summary.unknownUsage)} · 错误 ${fmtInt(summary.errors)}`));
  console.log(line("Tokens", `${fmtTokens(summary.tokens.total)}  ${c.dim("（精确，来自上游官方 usage）")}`));
  console.log(line("费用", `≈${fmtCny(summary.costCny)}  ${c.dim("（价格表推算）")}`));
  for (const [provider, row] of Object.entries(summary.byProvider)) console.log(c.dim(`  ${provider}: ${row.requests} 请求 · ${fmtTokens(row.tokens)} tokens`));
  return 0;
}

async function cmdServe(flags) {
  const port = flags.port ? Number.parseInt(flags.port, 10) : undefined;
  const { server, url, port: actual } = await startServer({ port });
  console.log(`${c.bold("DSH 驾驶舱")} 已启动：${c.cyan(url)}`);
  console.log(c.dim("按 Ctrl+C 停止。数据只读本地 DSH 会话，不上传。"));
  if (flags.open) openBrowser(url);
  await new Promise((resolve) => {
    const stop = () => server.close(() => resolve());
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  });
  console.log(`已停止（端口 ${actual}）。`);
  return 0;
}

function openBrowser(url) {
  const platform = process.platform;
  const command = platform === "win32" ? "cmd" : platform === "darwin" ? "open" : "xdg-open";
  const args = platform === "win32" ? ["/c", "start", "", url] : [url];
  try {
    spawnSync(command, args, { stdio: "ignore" });
  } catch {
    /* 打开浏览器失败不影响服务 */
  }
}

async function cmdComfort(positional, flags) {
  const level = Number.parseInt(positional[0] ?? "3", 10);
  if (!Number.isFinite(level) || level < 1 || level > 5) {
    console.error("用法：dsh-cockpit comfort <1-5> [--note 文本]");
    return 1;
  }
  recordComfort({ level, note: flags.note ?? "" });
  const store = loadComfort();
  console.log(`${c.green("已记录")} 今日舒适度 ${level}（共 ${store.entries.length} 天）`);
  return 0;
}

async function cmdConfig(flags) {
  let { config } = loadConfig();
  if (flags.set) {
    const [key, ...rest] = String(flags.set).split("=");
    const value = rest.join("=");
    if (!key || value === "") {
      console.error("用法：dsh-cockpit config --set budget.tokens=2000000");
      return 1;
    }
    const [section, field] = key.split(".");
    if (!section || !field) {
      console.error("键需为 section.field 形式（如 budget.tokens / ui.maskTitles / server.port）");
      return 1;
    }
    const next = structuredClone(config);
    if (!next[section]) next[section] = {};
    // 通用解析：纯数字 → number；true/false → boolean；其余按字符串（再由 config 归一化夹取范围）
    const isNumber = /^-?\d+(\.\d+)?$/.test(value);
    next[section][field] = isNumber ? Number(value) : value === "true" ? true : value === "false" ? false : value;
    config = saveConfig(next);
    console.log(`${c.green("已保存")} ${key}=${next[section][field]}`);
  }
  console.log(JSON.stringify(config, null, 2));
  return 0;
}

async function cmdDoctor() {
  const checks = [];
  const nodeMajor = Number.parseInt(process.versions.node.split(".")[0], 10);
  const nodeMinor = Number.parseInt(process.versions.node.split(".")[1], 10);
  checks.push({ name: "Node 版本", ok: nodeMajor > 22 || (nodeMajor === 22 && nodeMinor >= 15), detail: process.version });
  checks.push({ name: "zstd 支持", ok: zstdAvailable(), detail: zstdAvailable() ? "可用" : "不可用（需 Node >=22.15）" });
  const root = sessionsRoot();
  const discovery = discoverSessions(root);
  checks.push({ name: "DSH 数据目录", ok: existsSync(root), detail: root });
  checks.push({
    name: "会话可读",
    ok: discovery.sessions.length > 0,
    detail: `发现 ${discovery.sessions.length} 个会话，共 ${(discovery.stats.bytes / 1024 / 1024).toFixed(1)}MB`,
  });
  const home = cockpitHome();
  checks.push({ name: "驾驶舱数据目录", ok: true, detail: home });
  const { config } = loadConfig();
  checks.push({ name: "配置", ok: true, detail: `预算模式 ${config.budget.mode} / ${config.budget.axis}` });
  const portOk = await new Promise((resolve) => {
    const tester = spawnSync(process.execPath, ["-e", "0"], { stdio: "ignore" });
    resolve(tester.status === 0);
  });
  checks.push({ name: "运行时", ok: portOk, detail: process.platform });

  console.log(c.bold("环境自检"));
  let failed = 0;
  for (const check of checks) {
    if (!check.ok) failed += 1;
    console.log(`${check.ok ? c.green("✓") : c.red("✗")} ${check.name.padEnd(14)} ${c.dim(check.detail)}`);
  }
  console.log(failed === 0 ? c.green("全部通过") : c.red(`${failed} 项未通过`));
  return failed === 0 ? 0 : 1;
}

function cmdInstallPlugin(flags) {
  const profile = flags.profile ?? "web";
  const pluginDir = join(PROJECT_ROOT, "dsh-plugin");
  const profileDir = join(dshHome(), "profiles", profile);
  const patchPath = join(profileDir, "cordis.patch.yml");

  if (!existsSync(pluginDir)) {
    console.error(`插件目录不存在：${pluginDir}`);
    return 1;
  }
  console.log(c.bold("安装 DSH 插件"));
  console.log(line("插件", pluginDir));
  console.log(line("Profile", profileDir));
  console.log("");
  console.log("步骤 1：把插件安装到 profile（本地 file: 依赖）");
  console.log(c.cyan(`  dsh plugin --profile ${profile} add "file:${pluginDir}"`));
  console.log("步骤 2：在 profile 的 cordis.patch.yml 追加");
  console.log(c.cyan("  - insert:\n      - id: dsh-cockpit\n        name: 'dsh-cockpit-plugin'"));
  console.log("步骤 3：重启 DSH，访问 http://127.0.0.1:<gui端口>/dsh-cockpit");
  console.log("");
  console.log(c.dim("卸载：从 cordis.patch.yml 删除该条目，再 dsh plugin --profile <name> remove dsh-cockpit-plugin"));
  console.log(c.dim("默认 dry-run；加 --apply 执行步骤 1 与 2（会先备份 cordis.patch.yml）。"));

  if (!flags.apply) return 0;

  if (!existsSync(profileDir)) {
    console.error(`Profile 不存在：${profileDir}`);
    return 1;
  }
  if (existsSync(patchPath)) {
    const backup = `${patchPath}.bak-${Date.now()}`;
    copyFileSync(patchPath, backup);
    console.log(line("已备份", backup));
  } else {
    writeFileSync(patchPath, "# 由 dsh-cockpit 创建\n[]\n", "utf8");
  }
  appendFileSync(patchPath, `\n- insert:\n    - id: dsh-cockpit\n      name: 'dsh-cockpit-plugin'\n`, "utf8");
  console.log(line("已写入", patchPath));

  const result = spawnSync("dsh", ["plugin", "--profile", profile, "add", `file:${pluginDir}`], {
    stdio: "inherit",
    shell: true,
  });
  if (result.status !== 0) {
    console.error(c.red("插件安装失败：请手动执行步骤 1。"));
    return result.status ?? 1;
  }
  console.log(c.green("完成。重启 DSH 后生效。"));
  return 0;
}

async function cmdTasks(flags) {
  const result = await buildTasks({
    range: flags.range,
    model: flags.model,
    project: flags.project,
    q: flags.q,
    sort: flags.sort,
    order: flags.order,
    page: flags.page,
    pageSize: flags.pageSize ?? "20",
  });
  if (flags.json) {
    console.log(JSON.stringify(result, null, 2));
    return 0;
  }
  console.log(`${c.bold("任务排行")}  ${c.dim(`${result.range.label} · 共 ${result.total} 个`)}`);
  console.log(c.dim("─".repeat(72)));
  const header = `${"#".padStart(3)} ${"任务".padEnd(30)} ${"tokens".padStart(12)} ${"占比".padStart(7)} ${"成本".padStart(9)}`;
  console.log(c.dim(header));
  result.items.forEach((row, index) => {
    const rank = String((result.page - 1) * result.pageSize + index + 1).padStart(3);
    console.log(`${rank} ${String(row.title).slice(0, 30).padEnd(30)} ${fmtTokens(row.tokens).padStart(12)} ${(row.sharePercent.toFixed(1) + "%").padStart(7)} ${fmtCny(row.costCny).padStart(9)}`);
  });
  console.log(c.dim(`第 ${result.page} 页 / 每页 ${result.pageSize}`));
  return 0;
}

async function cmdProjects(flags) {
  const result = await buildProjects({ range: flags.range });
  if (flags.json) {
    console.log(JSON.stringify(result, null, 2));
    return 0;
  }
  console.log(`${c.bold("项目排行")}  ${c.dim(result.range.label)}`);
  console.log(c.dim("─".repeat(64)));
  for (const row of result.items) {
    console.log(`${String(row.project).slice(0, 34).padEnd(34)} ${fmtTokens(row.tokens).padStart(12)}  ${(row.sharePercent.toFixed(1) + "%").padStart(7)}  ${fmtCny(row.costCny)}`);
  }
  return 0;
}

async function cmdInsights(flags) {
  const result = await buildInsightsReport({ range: flags.range });
  if (flags.json) {
    console.log(JSON.stringify(result, null, 2));
    return 0;
  }
  console.log(`${c.bold("洞察")}  ${c.dim(result.range.label)}`);
  console.log(c.dim("─".repeat(72)));
  if (result.items.length === 0) console.log(c.dim("暂无异常，节奏正常。"));
  for (const item of result.items) {
    const tag = item.severity === "warn" ? c.amber("⚠ warn") : c.cyan("ℹ info");
    console.log(`${tag}  ${item.title}`);
    console.log(`       ${c.dim(item.body)}`);
  }
  return 0;
}

async function cmdCalendar(flags) {
  const result = await buildCalendarReport({ month: flags.month });
  if (flags.json) {
    console.log(JSON.stringify(result, null, 2));
    return 0;
  }
  console.log(`${c.bold("日历")}  ${c.dim(result.month)}`);
  console.log(c.dim("─".repeat(64)));
  for (const day of result.days) {
    if ((day.tokens ?? 0) === 0 && day.comfort === null) continue;
    const comfort = day.comfort ? `体感 ${day.comfort}/5` : "—";
    const top = day.topTasks[0] ? `· ${day.topTasks[0].title.slice(0, 24)}` : "";
    console.log(`${day.date}  ${fmtTokens(day.tokens).padStart(12)}  ${fmtCny(day.costCny).padStart(10)}  ${comfort}  ${c.dim(top)}`);
  }
  return 0;
}

function cmdBackup(flags) {
  const payload = buildBackup({});
  const text = JSON.stringify(payload, null, 2);
  if (flags.out) {
    writeFileSync(flags.out, text, "utf8");
    console.log(`${c.green("已导出")} ${flags.out}`);
  } else {
    console.log(text);
  }
  return 0;
}

function cmdRestore(positional, flags) {
  const file = positional[0];
  if (!file || !existsSync(file)) {
    console.error("用法：dsh-cockpit restore <file.json> [--dry-run]");
    return 1;
  }
  let payload;
  try {
    payload = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    console.error(c.red("备份文件不是合法 JSON："), error.message);
    return 1;
  }
  if (flags["dry-run"]) {
    const ok = payload && typeof payload === "object" && (payload.product === undefined || payload.product === "dsh-cockpit");
    console.log(ok ? c.green("校验通过（dry-run 未写入）") : c.red("校验失败：不是 dsh-cockpit 备份"));
    return ok ? 0 : 1;
  }
  const result = restoreBackup({ payload });
  console.log(`${c.green("已恢复")} ${result.restored.join(", ") || "（无内容）"}`);
  return 0;
}

async function cmdNotify(flags) {
  const result = await buildNotificationsReport({});
  if (flags.json) {
    console.log(JSON.stringify(result, null, 2));
    return 0;
  }
  console.log(`${c.bold("通知")}  ${c.dim(`未读 ${result.unread}`)}`);
  console.log(c.dim("─".repeat(64)));
  if (result.alerts.length === 0) console.log(c.dim("暂无告警。"));
  for (const alert of result.alerts) {
    const tag = alert.level === "critical" ? c.red("● critical") : alert.level === "warn" ? c.amber("● warn") : c.cyan("● info");
    console.log(`${tag}  ${alert.title}${alert.read ? c.dim("（已读）") : ""}`);
    console.log(`         ${c.dim(alert.body)}`);
  }
  return 0;
}

async function cmdWatch(flags) {
  const intervalSeconds = Math.max(15, Number.parseInt(flags.interval ?? "60", 10) || 60);
  const once = flags.once === true;
  let last = "";
  const tick = async () => {
    const result = await buildNotificationsReport({});
    const signature = result.alerts.map((alert) => alert.id).sort().join(",");
    if (signature !== last) {
      last = signature;
      const stamp = formatBeijingHm(Date.now());
      if (result.alerts.length === 0) console.log(`${c.dim(stamp)} 无告警`);
      for (const alert of result.alerts) console.log(`${c.dim(stamp)} ${c.amber(alert.level)} ${alert.title} — ${alert.body}`);
    }
    return result;
  };
  const first = await tick();
  if (once) return 0;
  console.log(c.dim(`监听中（每 ${intervalSeconds}s，Ctrl+C 退出）`));
  const timer = setInterval(() => {
    tick().catch((error) => console.error(c.red("监听失败："), error.message));
  }, intervalSeconds * 1000);
  await new Promise((resolve) => {
    process.once("SIGINT", () => {
      clearInterval(timer);
      resolve();
    });
  });
  return first.alerts.length >= 0 ? 0 : 0;
}

async function cmdSubagents(flags) {
  const result = await buildSubagents({ range: flags.range });
  if (flags.json) {
    console.log(JSON.stringify(result, null, 2));
    return 0;
  }
  console.log(`${c.bold("子代理树")}  ${c.dim(result.range.label)}`);
  console.log(c.dim("─".repeat(64)));
  if (result.items.length === 0 && result.orphans.length === 0) {
    console.log(c.dim("暂无可归属的子代理会话（当前数据中没有 parentSession 关联）。"));
    return 0;
  }
  for (const row of result.items) {
    console.log(`${row.parentTitle}  ${c.dim(`(${fmtTokens(row.parentTokens)} tokens)`)}`);
    for (const child of row.children) {
      console.log(`  └─ depth ${child.depth}  ${child.title}  ${c.dim(`${fmtTokens(child.tokens)} tokens · ${fmtCny(child.costCny)}`)}`);
    }
  }
  if (result.orphans.length > 0) console.log(c.dim(`未归属子代理：${result.orphans.length}`));
  return 0;
}

/** 校验同步端点：必须是 https，或本机 http（与客户端规则一致）。 */
function normalizeSyncEndpoint(raw) {
  if (typeof raw !== "string" || raw.trim() === "") throw new Error("sync.endpoint 未设置（如 https://<worker>.workers.dev）");
  const url = new URL(raw.trim());
  const loopback = ["127.0.0.1", "localhost", "::1", "[::1]"].includes(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    throw new Error("endpoint 必须是 https（本机调试允许 http://127.0.0.1）");
  }
  return raw.trim().replace(/\/+$/, "");
}

/** 通过 bootstrap secret 创建空间（CLI `sync init` 用；只发一次 POST /v1/spaces）。 */
async function createSpaceViaBootstrap({ endpoint, bootstrapSecret, deviceId, displayName, spaceName }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  try {
    const response = await fetch(`${endpoint}/v1/spaces`, {
      method: "POST",
      headers: {
        "x-bootstrap-secret": bootstrapSecret,
        "content-type": "application/json",
        accept: "application/json",
      },
      body: JSON.stringify({ displayName, deviceId, spaceName }),
      signal: controller.signal,
    });
    let payload = {};
    try {
      payload = await response.json();
    } catch {
      payload = {};
    }
    if (!response.ok || payload.ok !== true) {
      const message = payload?.error?.message ?? `HTTP ${response.status}`;
      throw Object.assign(new Error(message), { code: payload?.error?.code ?? "SYNC_HTTP_ERROR" });
    }
    return payload;
  } finally {
    clearTimeout(timer);
  }
}

async function cmdSync(positional, flags) {
  const sub = positional[0] ?? "status";
  const { config } = loadConfig();
  const enabled = isSyncEnabled(config);

  if (sub === "init") {
    if (config.sync?.enabled && config.sync?.deviceId && flags.force !== true) {
      console.error(c.red("已存在团队空间：") + "如需重建请加 --force（以新设备身份入组，旧空间不受影响）。");
      return 1;
    }
    const bootstrapSecret = process.env.DSH_COCKPIT_BOOTSTRAP_SECRET;
    if (!bootstrapSecret) {
      console.error(c.red("缺少 bootstrap secret：") + "先设置环境变量 DSH_COCKPIT_BOOTSTRAP_SECRET（与 Worker 的 secret 一致）");
      return 1;
    }
    let endpoint;
    try {
      endpoint = normalizeSyncEndpoint(flags.endpoint ?? config.sync?.endpoint ?? "");
    } catch (error) {
      console.error(c.red("endpoint 无效：") + error.message);
      return 1;
    }
    const deviceId = config.sync?.deviceId || `device-${randomUUID().slice(0, 8)}`;
    const displayName = String(flags.name ?? "dsh-cockpit").slice(0, 40);
    const spaceName = String(flags["space-name"] ?? "team").slice(0, 40);
    try {
      const created = await createSpaceViaBootstrap({ endpoint, bootstrapSecret, deviceId, displayName, spaceName });
      const next = structuredClone(config);
      next.sync.enabled = true;
      next.sync.endpoint = endpoint;
      next.sync.spaceLabel = created.space?.name ?? spaceName;
      next.sync.deviceId = created.deviceId ?? deviceId;
      next.sync.deviceName = created.displayName ?? displayName;
      saveConfig(next);
      if (flags.json) {
        console.log(JSON.stringify({ ...created, endpoint }, null, 2));
        return 0;
      }
      console.log(`${c.green("空间已创建")}  ${created.space?.name ?? spaceName}  ${c.dim(created.spaceId ?? "")}`);
      console.log(line("本机设备", `${created.deviceId}（${created.role}）`));
      console.log(line("邀请码", `${created.inviteCode}  ${c.dim("24h 内有效，单次使用")}`));
      console.log(line("访问令牌", c.amber(created.token)));
      console.log(c.dim("令牌只显示这一次；只放环境变量，不要写进配置/仓库："));
      console.log(c.dim(`  PowerShell: $env:DSH_COCKPIT_SYNC_TOKEN="${created.token}"`));
      console.log(c.dim("下一步："));
      console.log(c.dim("  1) 当前终端设置 DSH_COCKPIT_SYNC_TOKEN 后运行：node src/cli.mjs sync push"));
      console.log(c.dim("  2) 第二台设备：配置同一 sync.endpoint 后：node src/cli.mjs sync enroll --invite <邀请码>"));
      return 0;
    } catch (error) {
      console.error(c.red("创建空间失败："), error?.message ?? error);
      if (error?.code) console.error(c.dim(`code=${error.code}`));
      return 1;
    }
  }

  const status = {
    enabled,
    endpoint: config.sync?.endpoint ?? "",
    spaceLabel: config.sync?.spaceLabel ?? "",
    deviceId: config.sync?.deviceId ?? "",
    deviceName: config.sync?.deviceName ?? "",
    autoPush: config.sync?.autoPush === true,
    hasToken: typeof process.env.DSH_COCKPIT_SYNC_TOKEN === "string" && process.env.DSH_COCKPIT_SYNC_TOKEN.length > 0,
    tokenEnv: "DSH_COCKPIT_SYNC_TOKEN",
  };
  if (sub === "status") {
    if (flags.json) console.log(JSON.stringify(status, null, 2));
    else {
      console.log(`${c.bold("团队同步")}  ${enabled ? c.green("已启用") : c.dim("未启用（默认关闭）")}`);
      console.log(line("服务地址", status.endpoint || "—"));
      console.log(line("空间", status.spaceLabel || "—"));
      console.log(line("本机设备", status.deviceId ? `${status.deviceName || "—"}（${status.deviceId}）` : "—（未入组）"));
      console.log(line("令牌", status.hasToken ? "已设置（环境变量）" : "未设置（DSH_COCKPIT_SYNC_TOKEN）"));
      console.log(line("可选通道", `任务统计 ${config.sync?.shareTasks ? "开" : "关"} · 舒适度 ${config.sync?.shareComfort ? "开" : "关"}`));
    }
    return 0;
  }
  if (!enabled) {
    console.error(c.red("同步未启用：") + "先执行 `dsh-cockpit config --set sync.enabled=true` 并设置 sync.endpoint。");
    return 1;
  }
  try {
    const client = createSyncClientFromConfig(config);
    if (sub === "push") {
      const snapshot = buildSnapshotFromStatus(await buildStatus({ range: "7d" }));
      const result = await client.push(snapshot);
      let taskNote = "";
      if (config.sync?.shareTasks !== false) {
        try {
          const today = cycleDateKey(Date.now(), config.budget?.dayStartHour ?? 4);
          const taskPage = await buildTasks({ range: "today", pageSize: 200 });
          const items = Array.isArray(taskPage.items) ? taskPage.items : [];
          const masked = config.sync?.maskTaskTitles !== false;
          const tasks = items.map((item) => {
            const key = String(item.key ?? item.id ?? "").slice(0, 120);
            return {
              key,
              title: masked ? "任务-" + key.slice(0, 6) : String(item.title ?? "").slice(0, 120),
              tokens: Number.isFinite(item.tokens) ? item.tokens : null,
              costCny: Number.isFinite(item.costCny) ? item.costCny : null,
              lastAt: Number.isFinite(item.lastAt) ? item.lastAt : null,
            };
          }).filter((task) => task.key);
          await client.taskStats({ days: [{ date: today, tasks: Number(taskPage.total) || tasks.length }] });
          const pushed = await client.taskSummaries({ day: today, tasks });
          taskNote = " · 任务摘要 " + pushed.tasks + " 条（" + (masked ? "标题已打码" : "标题明文") + "）";
        } catch (error) {
          taskNote = " · 任务同步失败: " + (error?.message ?? error);
        }
      }
      console.log(flags.json ? JSON.stringify({ ...result, taskNote }, null, 2) : `${c.green("已上传")} accepted=${result.accepted} deduped=${result.deduped}${taskNote}`);
      return 0;
    }
    if (sub === "comfort") {
      if (config.sync?.shareComfort !== true) {
        console.error(c.red("舒适度同步未开启：") + "先执行 `node src/cli.mjs config --set sync.shareComfort=true`（仅同步 1–5 等级与可选备注）");
        return 1;
      }
      const level = Number(positional[1] ?? flags.level);
      if (!Number.isInteger(level) || level < 1 || level > 5) { console.error("用法：sync comfort <1-5> [--note 备注]"); return 1; }
      const saved = await client.comfort({ level, note: flags.note });
      console.log(flags.json ? JSON.stringify(saved, null, 2) : `${c.green("已同步舒适度")} level=${saved.level} day=${saved.day} person=${saved.personId ?? "—"}`);
      return 0;
    }
    if (sub === "pull") {
      const merged = mergeRemote(await client.pull());
      if (flags.json) console.log(JSON.stringify(merged, null, 2));
      else console.log(`${c.green("已拉取")} 设备 ${Object.keys(merged.byDevice).length} 台 · 合计 ${fmtTokens(merged.totals?.tokens ?? 0)} tokens`);
      return 0;
    }
    if (sub === "invite") {
      const created = await client.invite();
      if (flags.json) { console.log(JSON.stringify(created, null, 2)); return 0; }
      console.log(`${c.green("新邀请码")}  ${created.inviteCode}  ${c.dim(`有效期至 ${created.inviteExpiresAt ?? "24h"}`)}`);
      console.log(c.dim("在第二台设备："));
      console.log(c.dim("  node src/cli.mjs config --set sync.endpoint=<同一 endpoint>"));
      console.log(c.dim("  node src/cli.mjs sync enroll --invite " + created.inviteCode));
      return 0;
    }
    if (sub === "enroll") {
      const enrolled = await client.enroll({
        inviteCode: flags.invite,
        displayName: flags.name ?? "dsh-cockpit",
        // 未入组设备：生成稳定设备 ID（服务端要求 3–64 位安全字符）
        deviceId: config.sync?.deviceId || `device-${randomUUID().slice(0, 8)}`,
      });
      // 持久化设备身份与空间标识，便于成员视图稳定显示"本机"
      const next = structuredClone(config);
      next.sync.deviceId = enrolled.deviceId ?? next.sync.deviceId;
      next.sync.deviceName = enrolled.displayName ?? next.sync.deviceName;
      if (flags.label) next.sync.spaceLabel = String(flags.label).slice(0, 60);
      else if (enrolled.spaceId && !next.sync.spaceLabel) next.sync.spaceLabel = enrolled.spaceId;
      saveConfig(next);
      if (flags.json) {
        console.log(JSON.stringify(enrolled, null, 2));
        return 0;
      }
      console.log(`${c.green("已加入空间")}  device=${enrolled.deviceId}  role=${enrolled.role}`);
      console.log(line("访问令牌", c.amber(enrolled.token)));
      console.log(c.dim("令牌只显示这一次；只放环境变量，不要写进配置/仓库："));
      console.log(c.dim(`  PowerShell: $env:DSH_COCKPIT_SYNC_TOKEN="${enrolled.token}"`));
      console.log(c.dim("然后运行：node src/cli.mjs sync push  与  node src/cli.mjs sync members"));
      return 0;
    }
    if (sub === "members") {
      const localStatus = await buildStatus({ range: "today" });
      const report = await buildTeamReport({ config, localStatus });
      if (flags.json) { console.log(JSON.stringify(report, null, 2)); return 0; }
      if (!report.enabled) { console.log(c.dim(report.hint ?? "同步未启用")); return 0; }
      if (report.offline) { console.log(c.red("离线：") + (report.error?.message ?? "拉取成员失败")); return 1; }
      const plan = report.plan ?? {};
      const planText = plan.dailyTokenCap
        ? `每日上限 ${fmtTokens(plan.dailyTokenCap)} tokens · 建议 ${plan.dayTotalPercent}%`
        : "未设置每日上限";
      console.log(`${c.bold("成员")}  ${c.dim(report.space?.name ?? "")}  ${c.dim(planText)}`);
      console.log(c.dim("─".repeat(72)));
      if (Array.isArray(report.people) && report.people.length > 0) {
        for (const person of report.people) {
          const tags = [person.self ? "本机" : null].filter(Boolean).join("/");
          console.log(
            `${person.self ? "●" : "○"} ${person.name}${tags ? c.dim(`（${tags}）`) : ""}  ${c.dim(`${person.deviceCount} 台设备`)}  ${person.today ? `${fmtTokens(person.today.tokens)} tokens · ${fmtCny(person.today.costCny ?? 0)}` : c.dim("今日无数据")}${person.planValue === null ? "" : `  ${c.dim(`计划 ${person.planValue}%${person.overPlan ? " ⚠" : ""}`)}`}`,
          );
        }
        const unassigned = (report.unassignedDevices ?? []).filter((row) => !row.revoked);
        if (unassigned.length > 0) console.log(c.dim(`未归属设备：${unassigned.map((row) => row.displayName).join("、")}`));
      } else {
        for (const row of report.members) {
          const tags = [row.isSelf ? "本机" : null, row.revoked ? "已撤销" : null].filter(Boolean).join("/");
          console.log(
            `${row.isSelf ? "●" : "○"} ${row.displayName}${tags ? c.dim(`（${tags}）`) : ""}  ${c.dim(row.role)}  ${row.today ? `${fmtTokens(row.today.tokens)} tokens · ${fmtCny(row.today.costCny ?? 0)}` : c.dim("今日无数据")}  ${row.planPercent === null ? "" : c.dim(`计划 ${row.planPercent}%`)}`,
          );
        }
      }
      console.log(c.dim(`合计：${report.totals.members} 位成员 · ${fmtTokens(report.totals.todayTokens)} tokens · ${fmtCny(report.totals.todayCostCny)}${report.totals.planUsedPercent === null ? "" : ` · 计划 ${report.totals.planUsedPercent}%`}`));
      return 0;
    }
    if (sub === "plan") {
      const plan = {};
      if (flags["daily-token-cap"] !== undefined) plan.dailyTokenCap = Number(flags["daily-token-cap"]);
      if (flags["day-total-percent"] !== undefined) plan.dayTotalPercent = Number(flags["day-total-percent"]);
      if (flags.note !== undefined) plan.note = String(flags.note);
      if (Object.keys(plan).length === 0) { console.error("用法：sync plan --daily-token-cap 20000000 --day-total-percent 90 [--note 文本]"); return 1; }
      const saved = await client.saveSpaceSettings({ plan });
      console.log(flags.json ? JSON.stringify(saved, null, 2) : `${c.green("已更新共享计划")} ${JSON.stringify(saved.settings?.plan ?? plan)}`);
      return 0;
    }
    if (sub === "groups") {
      const action = positional[1] ?? "list";
      const shared = await client.getSharedSettings();
      const settings = shared.settings ?? { schemaVersion: 2, groups: [], plan: null };
      const groups = Array.isArray(settings.groups) ? settings.groups : [];
      const saveGroups = async (nextGroups) => {
        const saved = await client.saveSharedSettings({
          revision: shared.revision,
          settings: { ...settings, schemaVersion: 2, groups: nextGroups },
        });
        console.log(flags.json ? JSON.stringify(saved, null, 2) : `${c.green("已发布共享配置")} revision=${saved.revision}`);
        return saved;
      };
      if (action === "list") {
        const report = await buildTeamReport({ config, localStatus: await buildStatus({ range: "today" }) });
        if (flags.json) { console.log(JSON.stringify({ revision: shared.revision, groups: report.people ?? groups }, null, 2)); return 0; }
        console.log(`${c.bold("组员")}  revision=${shared.revision}  ${c.dim(`共 ${groups.length} 人`)}`);
        console.log(c.dim("─".repeat(64)));
        for (const person of report.people ?? []) {
          console.log(`${person.self ? "●" : "○"} ${person.name}  ${c.dim(`(${person.personId} · ${person.deviceCount} 台设备)`)}  ${person.today ? `${fmtTokens(person.today.tokens)} tokens · ${fmtCny(person.today.costCny ?? 0)}` : c.dim("今日无数据")}${person.planValue === null ? "" : `  ${c.dim(`计划 ${person.planValue}%`)}`}`);
          for (const device of person.devices) console.log(c.dim(`    └─ ${device.displayName}（${device.deviceId}）${device.isSelf ? " 本机" : ""}`));
        }
        const unassigned = (report.unassignedDevices ?? []).filter((row) => !row.revoked);
        if (unassigned.length > 0) {
          console.log(c.dim(`未归属设备：${unassigned.map((row) => `${row.displayName}（${row.deviceId}）`).join("、")}`));
        }
        return 0;
      }
      if (action === "add") {
        if (!flags.name) { console.error("用法：sync groups add --name 李工 [--device deviceId]"); return 1; }
        const deviceId = flags.device ? String(flags.device) : null;
        const next = groups.map((group) => ({ ...group, deviceIds: (group.deviceIds ?? []).filter((id) => id !== deviceId) }));
        next.push({ id: `grp_${randomUUID().slice(0, 8)}`, name: String(flags.name).slice(0, 40), deviceIds: deviceId ? [deviceId] : [] });
        await saveGroups(next);
        return 0;
      }
      if (action === "rename") {
        const groupId = positional[2] ?? flags.id;
        if (!groupId || !flags.name) { console.error("用法：sync groups rename <groupId> --name 新名字"); return 1; }
        const next = groups.map((group) => (group.id === groupId ? { ...group, name: String(flags.name).slice(0, 40) } : group));
        if (!next.some((group) => group.id === groupId)) { console.error("组员不存在"); return 1; }
        await saveGroups(next);
        return 0;
      }
      if (action === "remove") {
        const groupId = positional[2] ?? flags.id;
        if (!groupId) { console.error("用法：sync groups remove <groupId>"); return 1; }
        await saveGroups(groups.filter((group) => group.id !== groupId));
        return 0;
      }
      if (action === "assign") {
        const groupId = positional[2] ?? flags.id;
        const deviceId = positional[3] ?? flags.device;
        if (!groupId || !deviceId) { console.error("用法：sync groups assign <groupId> <deviceId>"); return 1; }
        const next = groups.map((group) => {
          const deviceIds = (group.deviceIds ?? []).filter((id) => id !== deviceId);
          return group.id === groupId ? { ...group, deviceIds: [...deviceIds, deviceId] } : { ...group, deviceIds };
        });
        if (!next.some((group) => group.id === groupId)) { console.error("组员不存在"); return 1; }
        await saveGroups(next);
        return 0;
      }
      if (action === "unassign") {
        const deviceId = positional[2] ?? flags.device;
        if (!deviceId) { console.error("用法：sync groups unassign <deviceId>"); return 1; }
        await saveGroups(groups.map((group) => ({ ...group, deviceIds: (group.deviceIds ?? []).filter((id) => id !== deviceId) })));
        return 0;
      }
      console.error("用法：sync groups [list|add|rename|remove|assign|unassign]");
      return 1;
    }
    if (sub === "dayplan") {
      const localStatus = await buildStatus({ range: "today" });
      const report = await buildTeamReport({ config, localStatus });
      if (!report.enabled) { console.log(c.dim(report.hint ?? "同步未启用")); return 0; }
      if (!report.dayPlan?.available) {
        console.log(c.dim(report.dayPlan?.hint ?? "共享日计划不可用（先设置 dailyTokenCap）"));
        return 0;
      }
      const plan = report.dayPlan;
      if (flags.person || flags.risk !== undefined) {
        const revisions = Object.fromEntries((report.people ?? []).map((person) => [person.personId, { revision: person.planRevision ?? 0 }]));
        let change;
        if (flags.risk !== undefined) {
          change = riskPlanChange({ value: Number(flags.risk), plan: { value: { risk: { revision: plan.risk.revision }, people: revisions } } });
        } else {
          const personId = String(flags.person);
          if (!(report.people ?? []).some((person) => person.personId === personId)) { console.error("组员不存在（先 sync groups list）"); return 1; }
          change = personPlanChange({ personId, value: Number(flags.value), plan: { value: { people: revisions } } });
        }
        const result = await client.dailyPlan({ basis: plan.basis, change });
        if (flags.json) { console.log(JSON.stringify(result, null, 2)); return 0; }
        console.log(`${c.green("已更新当日计划")} revision=${result.revision}`);
        // 刷新视图（避免显示更新前的旧值）
        const fresh = await buildTeamReport({ config, localStatus });
        if (fresh.dayPlan?.available) {
          Object.assign(plan, fresh.dayPlan);
          report.people = fresh.people ?? report.people;
        }
      }
      if (flags.json) { console.log(JSON.stringify(plan, null, 2)); return 0; }
      const basis = plan.basis;
      console.log(`${c.bold("共享日计划")}  ${basis.localDate}  ${c.dim(`剩余 ${basis.remainingPercent}% · 重置 ${basis.resetsAt}`)}`);
      console.log(line("建议总量", `${plan.recommendation}%  ${c.dim(`风险 ${plan.risk.value ?? 0}% · 已分配 ${plan.totalAllocated}%${plan.overRecommended ? " ⚠ 超建议" : ""}`)}`));
      for (const person of plan.people) {
        const row = (report.people ?? []).find((item) => item.personId === person.personId);
        console.log(`  ${row?.self ? "●" : "○"} ${row?.name ?? person.personId}  ${c.dim(`(rev ${person.revision}${person.manual ? " · 手动" : ""})`)}  计划 ${person.value}%${row?.consumedPercent === null || row?.consumedPercent === undefined ? "" : `  · 已用 ${row.consumedPercent}%`}${row?.overPlan ? " ⚠ 超个人计划" : ""}`);
      }
      return 0;
    }
    if (sub === "pricing") {
      const action = positional[1] ?? "status";
      const shared = await client.getSharedSettings();
      const settings = shared.settings ?? { schemaVersion: 2, groups: [], plan: null, pricing: {}, costPolicy: "local" };
      const localPricing = config.pricing ?? {};
      const effective = JSON.parse(JSON.stringify({ ...DEFAULT_PRICING, ...localPricing }));
      const sharedPricing = settings.pricing ?? {};
      if (action === "publish") {
        const saved = await client.saveSharedSettings({
          revision: shared.revision,
          settings: { ...settings, pricing: effective, costPolicy: "shared-pricing-v1" },
        });
        console.log(flags.json ? JSON.stringify(saved, null, 2) : `${c.green("已发布共享价格表")} revision=${saved.revision} · ${Object.keys(effective).length} 个模型`);
        return 0;
      }
      if (action === "adopt") {
        if (Object.keys(sharedPricing).length === 0) { console.error("共享空间未发布价格表（先由 owner 执行 sync pricing publish）"); return 1; }
        const next = structuredClone(config);
        next.pricing = sharedPricing;
        saveConfig(next);
        try {
          const { statePath } = await import("./core/paths.mjs");
          const { unlinkSync } = await import("node:fs");
          unlinkSync(statePath());
        } catch { /* 缓存不存在或无法删除时忽略；下次状态会重新计价 */ }
        console.log(`${c.green("已采用共享价格表")} ${Object.keys(sharedPricing).length} 个模型（已清缓存，下次扫描按新价重算）`);
        return 0;
      }
      // status：对比本机与共享价格表
      const models = [...new Set([...Object.keys(effective), ...Object.keys(sharedPricing)])].sort();
      const drift = [];
      for (const model of models) {
        const local = effective[model] ?? null;
        const remote = sharedPricing[model] ?? null;
        if (JSON.stringify(local) !== JSON.stringify(remote)) drift.push({ model, local, remote });
      }
      if (flags.json) { console.log(JSON.stringify({ revision: shared.revision, costPolicy: settings.costPolicy, sharedModels: Object.keys(sharedPricing).length, drift }, null, 2)); return 0; }
      console.log(`${c.bold("共享价格表")}  revision=${shared.revision}  policy=${settings.costPolicy ?? "local"}  ${c.dim(`共享 ${Object.keys(sharedPricing).length} 个模型`)}`);
      if (drift.length === 0) console.log(c.green("本机与共享价格表一致"));
      else {
        console.log(c.amber(`有 ${drift.length} 个模型不一致：`));
        for (const entry of drift) console.log(`  ${entry.model}  本机=${JSON.stringify(entry.local)}  共享=${JSON.stringify(entry.remote)}`);
        console.log(c.dim("说明：sync pricing adopt 采用共享价格，或 sync pricing publish 发布本机价格"));
      }
      return 0;
    }
    if (sub === "rename") {
      const deviceId = positional[1] ?? flags.device;
      if (!deviceId || !flags.name) { console.error("用法：sync rename <deviceId> --name 新名字"); return 1; }
      const renamed = await client.renameMember({ deviceId, displayName: flags.name });
      console.log(flags.json ? JSON.stringify(renamed, null, 2) : `${c.green("已重命名")} ${renamed.deviceId} → ${renamed.displayName}`);
      return 0;
    }
    if (sub === "remove") {
      const deviceId = positional[1] ?? flags.device;
      if (!deviceId) { console.error("用法：sync remove <deviceId>"); return 1; }
      const removed = await client.revoke(deviceId);
      console.log(flags.json ? JSON.stringify(removed, null, 2) : `${c.green("已撤销")} ${removed.deviceId}${removed.alreadyRevoked ? "（此前已撤销）" : ""}`);
      return 0;
    }
  } catch (error) {
    console.error(c.red("同步失败："), error?.message ?? error);
    if (error?.code) console.error(c.dim(`code=${error.code}`));
    return 1;
  }
  console.error("用法：dsh-cockpit sync status|push|pull|enroll --invite CCI-xxx");
  return 1;
}

function printHelp() {
  console.log(`${c.bold("dsh-cockpit")} v${VERSION} — DeepSeek Harness 驾驶舱（本地只读）
`);
  console.log("用法：dsh-cockpit <command> [options]");
  console.log("");
  console.log("  scan            扫描会话并输出摘要");
  console.log("  status          打印驾驶舱状态（--json；官方余额实时）");
  console.log("  balance         官方余额（--refresh 强制实时取数，--json）");
  console.log("  account         官方账户（余额 + 累计花费；读取 DSH 账号授权，--refresh）");
  console.log("  gateway         本机代理网关（serve|status|stats|log；精确记录上游 usage）");
  console.log("  plan            打印配速 / 今日建议 / 压缩预测");
  console.log("  report          周期报告（--md --days 30）");
  console.log("  tasks           任务排行（--range 30d --q 关键字 --sort tokens --page 1）");
  console.log("  projects        项目/工作区排行（--range）");
  console.log("  subagents       子代理树（--range）");
  console.log("  insights        规则化洞察");
  console.log("  calendar        月历用量（--month YYYY-MM）");
  console.log("  notify          查看当前告警");
  console.log("  watch           监听告警并打印（--interval 60 --once）");
  console.log("  sync            团队同步（init|invite|status|push|pull|enroll|comfort|members|groups|dayplan|pricing|plan|rename|remove）");
  console.log("  backup          导出配置/舒适度（--out file.json）");
  console.log("  restore         恢复备份（restore <file.json> --dry-run）");
  console.log("  serve           启动 Web 仪表盘（--port 7777 --open）");
  console.log("  comfort <1-5>   记录今日舒适度（--note 文本）");
  console.log("  config          查看/修改配置（--set budget.tokens=2000000）");
  console.log("  doctor          环境自检");
  console.log("  install-plugin  安装 DSH 插件（--profile web --apply）");
  console.log("");
  console.log(c.dim("数据只读：~/.dsh/sessions；写入仅限 ~/.dsh-cockpit。"));
}

async function main() {
  const [command = "help", ...rest] = process.argv.slice(2);
  const { flags, positional } = parseArgs(rest);
  switch (command) {
    case "scan":
      return cmdScan(flags);
    case "status":
      return cmdStatus(flags);
    case "balance":
      return cmdBalance(flags);
    case "account":
      return cmdAccount(flags);
    case "gateway":
      return cmdGateway(positional, flags);
    case "plan":
      return cmdPlan(flags);
    case "report":
      return cmdReport(flags);
    case "serve":
      return cmdServe(flags);
    case "comfort":
      return cmdComfort(positional, flags);
    case "config":
      return cmdConfig(flags);
    case "doctor":
      return cmdDoctor(flags);
    case "install-plugin":
      return cmdInstallPlugin(flags);
    case "receipt":
      console.log(JSON.stringify(await buildReceipt({}), null, 2));
      return 0;
    case "tasks":
      return cmdTasks(flags);
    case "projects":
      return cmdProjects(flags);
    case "subagents":
      return cmdSubagents(flags);
    case "insights":
      return cmdInsights(flags);
    case "calendar":
      return cmdCalendar(flags);
    case "backup":
      return cmdBackup(flags);
    case "restore":
      return cmdRestore(positional, flags);
    case "notify":
      return cmdNotify(flags);
    case "watch":
      return cmdWatch(flags);
    case "sync":
      return cmdSync(positional, flags);
    case "help":
    case "--help":
    case "-h":
      printHelp();
      return 0;
    default:
      console.error(`未知命令：${command}`);
      printHelp();
      return 1;
  }
}

main()
  .then((code) => {
    process.exitCode = code ?? 0;
  })
  .catch((error) => {
    console.error(c.red("执行失败："), error?.message ?? error);
    if (error?.code) console.error(c.dim(`code=${error.code}`));
    process.exitCode = 1;
  });
