import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveRange } from "../src/core/range.mjs";
import { aggregateAll, createFilter, taskRows, projectRows, buildSubagentTree, stableKey } from "../src/core/aggregate.mjs";
import { buildRiskMap } from "../src/core/riskmap.mjs";
import { evaluateAlerts, withReadState } from "../src/core/notify.mjs";
import { buildInsights } from "../src/core/insights.mjs";
import { buildBackup, restoreBackup } from "../src/core/backup.mjs";
import { loadConfig, saveConfig, loadComfort, recordComfort, normalizeConfig } from "../src/core/config.mjs";
import { buildCalendar } from "../src/core/calendar.mjs";
import {
  buildStatus,
  buildTasks,
  buildProjects,
  buildSubagents,
  buildCalendarReport,
  buildNotificationsReport,
  markNotificationsRead,
} from "../src/core/index.mjs";
import { startServer } from "../src/server.mjs";
import { writeSyntheticSession, sessionHeader, contextEvent, assistantEvent } from "./helpers.mjs";

const NOW = Date.parse("2026-11-03T16:00:00+08:00");

function setupEnv() {
  const root = mkdtempSync(join(tmpdir(), "cockpit-v2-"));
  const dshHome = join(root, ".dsh");
  const cockpitHome = join(root, ".cockpit");
  return { root, env: { DSH_HOME: dshHome, DSH_COCKPIT_HOME: cockpitHome }, sessions: join(dshHome, "sessions") };
}

function writeSession(sessions, { id, project, tokenCount, time, parentSession, depth = 0, model = "deepseek-flash" }) {
  const header = parentSession
    ? JSON.stringify({ type: "session", version: 4, id, createdAt: time, cwd: `C:/work/${project}`, delegationDepth: depth, parentSession })
    : sessionHeader({ id, version: 4, createdAt: time, cwd: `C:/work/${project}` });
  return writeSyntheticSession(sessions, {
    projectSlug: `--${project}--`,
    sessionId: id,
    lines: [
      header,
      JSON.stringify({ type: "session/title", seq: 0, time, data: { title: `任务-${id}`, source: { kind: "fallback" } } }),
      contextEvent({ time: time + 1000, model, contextWindow: 1_000_000 }),
      assistantEvent({ time: time + 2000, inputTokens: tokenCount, outputTokens: Math.round(tokenCount / 10), model }),
    ],
  });
}

function seedSessions(sessions) {
  writeSession(sessions, { id: "session-main", project: "proj-a", tokenCount: 1000, time: NOW - 2 * 3_600_000 });
  writeSession(sessions, { id: "session-second", project: "proj-a", tokenCount: 500, time: NOW - 3 * 3_600_000 });
  writeSession(sessions, { id: "session-child", project: "proj-b", tokenCount: 300, time: NOW - 1 * 3_600_000, parentSession: "session-main", depth: 1 });
  writeSession(sessions, { id: "session-pro", project: "proj-b", tokenCount: 200, time: NOW - 4 * 3_600_000, model: "deepseek-pro" });
}

// ---------------------------------------------------------------------------
// 范围
// ---------------------------------------------------------------------------

test("resolveRange：cycle/today/7d/30d/custom/all", () => {
  const config = normalizeConfig({});
  const cycle = resolveRange({ range: "cycle", nowMs: NOW, config });
  assert.equal(cycle.kind, "cycle");
  assert.ok(cycle.startDate <= cycle.endDate);
  const today = resolveRange({ range: "today", nowMs: NOW, config });
  assert.equal(today.days, 1);
  const week = resolveRange({ range: "7d", nowMs: NOW, config });
  assert.equal(week.days, 7);
  const custom = resolveRange({ range: "custom", from: "2026-10-01", to: "2026-10-05", nowMs: NOW, config });
  assert.equal(custom.days, 5);
  const all = resolveRange({ range: "all", nowMs: NOW, config, earliestMs: NOW - 10 * 86_400_000 });
  assert.ok(all.days >= 9);
});

test("range 非法值回退 cycle", () => {
  const config = normalizeConfig({});
  assert.equal(resolveRange({ range: "bogus", nowMs: NOW, config }).kind, "cycle");
});

// ---------------------------------------------------------------------------
// 聚合 / 任务 / 项目 / 子代理 / 模型筛选
// ---------------------------------------------------------------------------

test("聚合支持模型过滤、项目过滤、排除子代理", async () => {
  const { root, env, sessions } = setupEnv();
  try {
    seedSessions(sessions);
    const status = await buildStatus({ env, nowMs: NOW, range: "cycle" });
    assert.equal(status.health.rangeSessions, 4);
    const proOnly = await buildTasks({ env, nowMs: NOW, range: "cycle", model: "deepseek-pro" });
    assert.equal(proOnly.total, 1);
    assert.equal(proOnly.items[0].title, "任务-session-pro");
    const noSub = await buildStatus({ env, nowMs: NOW, range: "cycle", includeSubagents: false });
    assert.equal(noSub.health.rangeSessions, 3);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("taskRows：搜索 / 排序 / 分页", async () => {
  const { root, env, sessions } = setupEnv();
  try {
    seedSessions(sessions);
    const all = await buildTasks({ env, nowMs: NOW, range: "cycle" });
    assert.equal(all.total, 4);
    assert.equal(all.items[0].title, "任务-session-main"); // token 最多
    const searched = await buildTasks({ env, nowMs: NOW, range: "cycle", q: "session-pro" });
    assert.equal(searched.total, 1);
    const paged = await buildTasks({ env, nowMs: NOW, range: "cycle", pageSize: "2", page: "2" });
    assert.equal(paged.items.length, 2);
    assert.equal(paged.page, 2);
    assert.ok(all.items[0].sharePercent > 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("项目排行与子代理树", async () => {
  const { root, env, sessions } = setupEnv();
  try {
    seedSessions(sessions);
    const projects = await buildProjects({ env, nowMs: NOW, range: "cycle" });
    assert.equal(projects.items.length, 2);
    assert.ok(projects.items[0].tokens >= projects.items[1].tokens);
    const tree = await buildSubagents({ env, nowMs: NOW, range: "cycle" });
    assert.equal(tree.items.length, 1);
    assert.equal(tree.items[0].parentSessionId, "session-main");
    assert.equal(tree.items[0].children[0].sessionId, "session-child");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("stableKey 稳定且不同输入不同 key", () => {
  assert.equal(stableKey("a|b|c"), stableKey("a|b|c"));
  assert.notEqual(stableKey("a"), stableKey("b"));
});

// ---------------------------------------------------------------------------
// 风险图 / 通知 / 洞察
// ---------------------------------------------------------------------------

test("风险热力图：网格完整、当前点回显", () => {
  const map = buildRiskMap({ usedPercent: 61.7, riskPercent: 34, knee: 25, isWeekend: false, daysLeftInCycle: 1 });
  assert.equal(map.cells.length, 11 * 6);
  assert.equal(map.current.pacePercent, 61.7);
  assert.equal(map.current.riskPercent, 34);
  for (const cell of map.cells) assert.ok(cell.suggestedPercent >= 0 && cell.suggestedPercent <= 100);
});

test("通知：阈值触发 + 已读状态", () => {
  const config = normalizeConfig({ notify: { enabled: true, budgetWarn: 80, budgetCritical: 95, compactionScore: 70, dailyCap: 90 } });
  const alerts = evaluateAlerts({
    status: { quota: { usedPercent: 96 }, pace: { status: "over_pace", overByPercent: 20 }, forecast: { score: 75, etaHours: 2 }, context: { percent: 85, compactions24h: 1 } },
    config,
  });
  const ids = alerts.map((alert) => alert.id);
  assert.ok(ids.includes("budget-critical"));
  assert.ok(ids.includes("compaction"));
  assert.ok(ids.includes("pace-over"));
  assert.ok(ids.includes("context-high"));
  const { unread } = withReadState(alerts, ["budget-critical"]);
  assert.equal(unread, alerts.length - 1);
  assert.equal(evaluateAlerts({ status: { quota: { usedPercent: 10 } }, config: normalizeConfig({ notify: { enabled: false } }) }).length, 0);
});

test("洞察：任务集中度与预算告警可触发", () => {
  const items = buildInsights({
    aggregate: {
      totals: { totalTokens: 1000 },
      tasks: new Map([[stableKey("x"), { title: "大任务", metrics: { totalTokens: 800 } }]]),
      models: new Map([["deepseek-flash", { totalTokens: 1000 }]]),
      sessions: [{ lastAt: NOW - 3_600_000 }],
    },
    status: { quota: { usedPercent: 97 }, pace: { status: "over_pace", overByPercent: 15 }, forecast: { score: 50 }, context: { percent: 50, compactions24h: 0 } },
    history: [],
    comfortEntries: [],
    config: normalizeConfig({ notify: { budgetWarn: 80, budgetCritical: 95 } }),
    nowMs: NOW,
    rangeLabel: "今日",
  });
  const ids = items.map((item) => item.id);
  assert.ok(ids.includes("dominant-task"));
  assert.ok(ids.includes("model-concentration"));
  assert.ok(ids.includes("budget-critical"));
});

// ---------------------------------------------------------------------------
// 日历 / 备份恢复
// ---------------------------------------------------------------------------

test("日历：月内每日聚合与 Top 任务", () => {
  const { root, env, sessions } = setupEnv();
  try {
    seedSessions(sessions);
    const calendar = buildCalendar({
      summaries: [{ id: "s", title: "任务A", projectSlug: "--p--", byDayModel: { "2026-11-03": { "deepseek-flash": { totalTokens: 100, costCny: 0.1, messages: 1 } } } }],
      month: "2026-11",
      config: normalizeConfig({}),
      comfortEntries: [{ date: "2026-11-03", level: 4 }],
      filter: null,
    });
    const day = calendar.days.find((row) => row.date === "2026-11-03");
    assert.equal(day.tokens, 100);
    assert.equal(day.comfort, 4);
    assert.equal(day.topTasks[0].title, "任务A");
    assert.equal(calendar.days.length, 30);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("备份导出 → 恢复往返（配置 + 舒适度 + 通知已读）", () => {
  const { root, env } = setupEnv();
  try {
    saveConfig({ budget: { tokens: 42_000_000 }, ui: { theme: "light", language: "en" } }, env);
    recordComfort({ level: 5, note: "撑", date: "2026-11-03", nowMs: NOW }, env);
    const payload = buildBackup({ env, nowMs: NOW });
    assert.equal(payload.product, "dsh-cockpit");
    assert.equal(payload.config.budget.tokens, 42_000_000);
    assert.equal(payload.comfort.entries.length, 1);

    saveConfig({ budget: { tokens: 1_000_000 } }, env);
    const result = restoreBackup({ payload, env });
    assert.ok(result.restored.includes("config"));
    assert.ok(result.restored.includes("comfort"));
    assert.equal(loadConfig(env).config.budget.tokens, 42_000_000);
    assert.equal(loadComfort(env).entries[0].level, 5);
    assert.throws(() => restoreBackup({ payload: { product: "other" }, env }), /dsh-cockpit/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// HTTP v2 端点
// ---------------------------------------------------------------------------

test("HTTP v2：tasks/projects/subagents/insights/calendar/notifications/backup/restore/config", async () => {
  const { root, env, sessions } = setupEnv();
  let started = null;
  try {
    seedSessions(sessions);
    started = await startServer({ env, port: 0, now: () => NOW });
    const base = started.url;

    const tasks = await (await fetch(`${base}api/tasks?range=cycle&pageSize=2`)).json();
    assert.equal(tasks.total, 4);
    assert.equal(tasks.items.length, 2);

    const projects = await (await fetch(`${base}api/projects?range=cycle`)).json();
    assert.equal(projects.items.length, 2);

    const subagents = await (await fetch(`${base}api/subagents?range=cycle`)).json();
    assert.equal(subagents.items.length, 1);

    const insights = await (await fetch(`${base}api/insights?range=cycle`)).json();
    assert.ok(Array.isArray(insights.items));

    const calendar = await (await fetch(`${base}api/calendar?month=2026-11`)).json();
    assert.equal(calendar.month, "2026-11");
    assert.equal(calendar.days.length, 30);

    const notifications = await (await fetch(`${base}api/notifications`)).json();
    assert.ok(Array.isArray(notifications.alerts));
    const readResult = await (await fetch(`${base}api/notifications/read`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ all: true }),
    })).json();
    assert.equal(readResult.ok, true);

    const backup = await (await fetch(`${base}api/backup`)).json();
    assert.equal(backup.product, "dsh-cockpit");

    const restore = await (await fetch(`${base}api/restore`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(backup),
    })).json();
    assert.equal(restore.ok, true);

    const configPayload = await (await fetch(`${base}api/config`)).json();
    assert.equal(configPayload.schemaVersion, 2);
    assert.ok(configPayload.notify);
    assert.ok(configPayload.ui.theme);

    const receipt = await (await fetch(`${base}api/receipt?range=cycle`)).json();
    assert.ok(receipt.lines.length >= 1);
    assert.ok(receipt.totalTokens > 0);

    const history = await (await fetch(`${base}api/history?range=7d`)).json();
    assert.equal(history.days.length, 7);

    const status = await (await fetch(`${base}api/status?range=7d`)).json();
    assert.equal(status.range.kind, "7d");
    assert.ok(status.riskMap.cells.length > 0);
    assert.ok(Array.isArray(status.insights));
    assert.ok(status.comfort.binned.length === 5);
  } finally {
    if (started) await new Promise((resolve) => started.server.close(resolve));
    rmSync(root, { recursive: true, force: true });
  }
});
