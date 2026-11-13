import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  writeSyntheticSession,
  sessionHeader,
  contextEvent,
  assistantEvent,
  toolEvent,
  compactionEvent,
  titleEvent,
} from "./helpers.mjs";
import { summarizeSession } from "../src/core/collect.mjs";
import { parseSessionText, readSessionFile } from "../src/core/session-reader.mjs";
import { buildStatus } from "../src/core/index.mjs";
import { startServer } from "../src/server.mjs";
import { cycleDateKey } from "../src/core/time.mjs";

const NOW = Date.parse("2026-11-02T16:00:00+08:00");

function setupEnv() {
  const root = mkdtempSync(join(tmpdir(), "cockpit-int-"));
  const dshHome = join(root, ".dsh");
  const cockpitHome = join(root, ".cockpit");
  return {
    root,
    env: { DSH_HOME: dshHome, DSH_COCKPIT_HOME: cockpitHome },
    sessions: join(dshHome, "sessions"),
  };
}

function writeFixtures(sessions) {
  const sessionA = writeSyntheticSession(sessions, {
    projectSlug: "--workspace-a--",
    sessionId: "session-a",
    lines: [
      sessionHeader({ id: "session-a", version: 4, createdAt: NOW - 3 * 3_600_000 }),
      titleEvent({ time: NOW - 3 * 3_600_000, title: "合成会话 A" }),
      contextEvent({ time: NOW - 3 * 3_600_000 + 1000 }),
      assistantEvent({ time: NOW - 2 * 3_600_000, inputTokens: 1000, cacheReadTokens: 500, outputTokens: 100 }),
      toolEvent({ time: NOW - 2 * 3_600_000 + 1000, name: "pwsh" }),
      assistantEvent({ time: NOW - 3_600_000, inputTokens: 2000, cacheReadTokens: 0, outputTokens: 200 }),
      compactionEvent({ time: NOW - 1_800_000, shadowedTokenCount: 5000 }),
    ],
  });
  const sessionB = writeSyntheticSession(sessions, {
    projectSlug: "--workspace-b--",
    sessionId: "session-b",
    version: 3,
    lines: [
      sessionHeader({ id: "session-b", version: 3, createdAt: NOW - 5 * 3_600_000 }),
      assistantEvent({ time: NOW - 4 * 3_600_000, inputTokens: 100, outputTokens: 10, model: "mystery-model" }),
    ],
  });
  return { sessionA, sessionB };
}

test("summarizeSession：聚合 usage、工具、压缩与上下文压力", () => {
  const { root, env, sessions } = setupEnv();
  try {
    const { sessionA } = writeFixtures(sessions);
    const parsed = readSessionFile(sessionA.path);
    const summary = summarizeSession(parsed, { sessionId: "session-a", projectSlug: "--workspace-a--" });

    assert.equal(summary.title, "合成会话 A");
    assert.equal(summary.counts.usageMessages, 2);
    assert.equal(summary.byModel["deepseek-flash"].messages, 2);
    assert.equal(summary.tools.pwsh, 1);
    assert.equal(summary.compactions.length, 1);
    assert.equal(summary.compactions[0].tokens, 5000);
    // 上下文压力取最近一条：input 2000 + cacheRead 0 + cacheWrite 0
    assert.equal(summary.context.pressure, 2000);
    assert.equal(summary.context.contextWindow, 1_000_000);

    const dayKey = cycleDateKey(NOW - 2 * 3_600_000, 4);
    const day = summary.byDay[dayKey];
    assert.equal(day.totalTokens, 3800);
    assert.ok(Math.abs(day.costCny - 0.00842) < 1e-6, `cost=${day.costCny}`);
    assert.equal(summary.cost.unknownTokens, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("未知模型：token 计数保留、金额未知（缺失≠0）", () => {
  const { root, sessions } = setupEnv();
  try {
    const { sessionB } = writeFixtures(sessions);
    const parsed = readSessionFile(sessionB.path);
    const summary = summarizeSession(parsed, { sessionId: "session-b" });
    assert.equal(summary.byModel["mystery-model"].totalTokens, 110);
    assert.equal(summary.cost.unknownTokens, 110);
    assert.equal(summary.byDay[Object.keys(summary.byDay)[0]].costCny, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("buildStatus：真实编排链路（预算/配速/计划/预测/历史）", async () => {
  const { root, env, sessions } = setupEnv();
  try {
    writeFixtures(sessions);
    const status = await buildStatus({ env, nowMs: NOW });

    assert.equal(status.mode, "local");
    assert.equal(status.quota.axis, "budget");
    assert.equal(status.quota.limit, 2_000_000);
    assert.equal(status.quota.used, 3910);
    assert.equal(status.totals.cycleTokens, 3910);
    // cycleCostCny 在输出层保留 4 位小数
    assert.ok(Math.abs(status.totals.cycleCostCny - 0.0084) < 1e-4);
    assert.equal(status.health.sessionsScanned, 2);
    assert.equal(status.health.errors, 0);
    assert.equal(status.health.costUnknownTokens, 110);
    assert.equal(status.health.partialCost, true);
    assert.equal(status.context.percent, 0.2);
    assert.equal(status.breakdown.models.length, 2);
    assert.ok(status.forecast.score >= 2 && status.forecast.score <= 95);
    assert.equal(status.history.length, 30);
    assert.equal(status.history.at(-1).tokens, 3910);
    assert.equal(typeof status.plan.suggestedUsagePercent, "number");
    assert.equal(typeof status.pace.status, "string");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("DSH 插件：薄封装契约 + /dsh-cockpit 挂载与 BASE 注入", async () => {
  const { createServer } = await import("node:http");
  const { createRequestHandler } = await import("../src/server.mjs");
  const plugin = await import("../dsh-plugin/index.js");

  assert.equal(plugin.name, "dsh-cockpit");
  assert.deepEqual(plugin.inject, ["webServer"]);

  const registered = [];
  const ctx = {
    webServer: { register: (route) => (registered.push(route), () => undefined) },
    effect: (factory) => factory(),
  };
  plugin.apply(ctx);
  assert.equal(registered.length, 1);
  assert.equal(registered[0].kind, "prefix");
  assert.equal(registered[0].path, "/dsh-cockpit");

  const { root, env, sessions } = setupEnv();
  const server = createServer(createRequestHandler({ mountBase: "/dsh-cockpit", env, now: () => NOW }));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  try {
    writeFixtures(sessions);
    const page = await fetch(`http://127.0.0.1:${port}/dsh-cockpit/`);
    assert.equal(page.status, 200);
    const html = await page.text();
    assert.ok(html.includes('window.__COCKPIT_BASE__="/dsh-cockpit"'), "应注入 mountBase");
    const status = await fetch(`http://127.0.0.1:${port}/dsh-cockpit/api/status`);
    assert.equal(status.status, 200);
    assert.equal((await status.json()).quota.used, 3910);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    rmSync(root, { recursive: true, force: true });
  }
});

test("HTTP API：status/config/comfort/receipt/rescan/404", async () => {
  const { root, env, sessions } = setupEnv();
  let started = null;
  try {
    writeFixtures(sessions);
    started = await startServer({ env, port: 0, now: () => NOW });
    const base = started.url;

    const statusResponse = await fetch(`${base}api/status`);
    assert.equal(statusResponse.status, 200);
    const status = await statusResponse.json();
    assert.equal(status.quota.used, 3910);

    const configResponse = await fetch(`${base}api/config`);
    const config = await configResponse.json();
    assert.ok(config.pricing["deepseek-flash"].input > 0);

    const comfortResponse = await fetch(`${base}api/comfort`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ level: 4, note: "测试" }),
    });
    assert.equal(comfortResponse.status, 200);
    assert.equal((await comfortResponse.json()).ok, true);

    const receipt = await (await fetch(`${base}api/receipt`)).json();
    assert.ok(receipt.title.includes("小票"));
    assert.equal(receipt.totalTokens, 3910);

    const rescan = await (await fetch(`${base}api/rescan`, { method: "POST" })).json();
    assert.equal(rescan.ok, true);

    const missing = await fetch(`${base}api/not-exist`);
    assert.equal(missing.status, 404);
    assert.equal((await missing.json()).ok, false);
  } finally {
    if (started) await new Promise((resolve) => started.server.close(resolve));
    rmSync(root, { recursive: true, force: true });
  }
});
