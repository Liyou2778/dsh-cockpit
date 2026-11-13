import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer } from "../src/server.mjs";
import { saveConfig } from "../src/core/config.mjs";
import { writeSyntheticSession, sessionHeader, assistantEvent } from "./helpers.mjs";

const NOW = Date.parse("2026-11-03T16:00:00+08:00");

function setupEnv() {
  const root = mkdtempSync(join(tmpdir(), "cockpit-syncwire-"));
  const dshHome = join(root, ".dsh");
  const cockpitHome = join(root, ".cockpit");
  const sessions = join(dshHome, "sessions");
  return { root, env: { DSH_HOME: dshHome, DSH_COCKPIT_HOME: cockpitHome }, sessions };
}

function seed(sessions) {
  writeSyntheticSession(sessions, {
    projectSlug: "--p--",
    sessionId: "session-sync",
    lines: [sessionHeader({ id: "session-sync" }), assistantEvent({ time: NOW - 3_600_000, inputTokens: 1000, outputTokens: 100 })],
  });
}

function mockFetch(calls) {
  return async (url, init) => {
    calls.push({ url: String(url), method: init?.method ?? "GET", body: init?.body });
    if (String(url).endsWith("/v1/snapshots") && (init?.method ?? "GET") === "POST") {
      return new Response(JSON.stringify({ accepted: true, deduped: false, _ts: NOW }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    if (String(url).endsWith("/v1/snapshots")) {
      return new Response(JSON.stringify({ snapshots: [{ deviceId: "dev-a", displayName: "A", snapshot: { schemaVersion: 1, days: [{ date: "2026-11-03", tokens: 10, costCny: 0.1 }], models: [], totals: { tokens: 10, costCny: 0.1 }, _ts: NOW, generatedAt: new Date(NOW).toISOString() } }] }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "Content-Type": "application/json" } });
  };
}

test("同步默认关闭：status 报告禁用，push 返回 409 SYNC_DISABLED", async () => {
  const { root, env, sessions } = setupEnv();
  let started = null;
  try {
    seed(sessions);
    started = await startServer({ env, port: 0, now: () => NOW });
    const base = started.url;
    const status = await (await fetch(`${base}api/sync/status`)).json();
    assert.equal(status.enabled, false);
    assert.equal(status.reason, "SYNC_DISABLED");
    const push = await fetch(`${base}api/sync/push`, { method: "POST" });
    assert.equal(push.status, 409);
    const payload = await push.json();
    assert.equal(payload.error.code, "SYNC_DISABLED");
  } finally {
    if (started) await new Promise((resolve) => started.server.close(resolve));
    rmSync(root, { recursive: true, force: true });
  }
});

test("同步启用：push 只发送聚合快照（不含会话标识），pull 合并设备", async () => {
  const { root, env, sessions } = setupEnv();
  let started = null;
  try {
    seed(sessions);
    saveConfig({ sync: { enabled: true, endpoint: "https://sync.example.com", spaceLabel: "测试空间" } }, env);
    const calls = [];
    const fetchImpl = mockFetch(calls);
    started = await startServer({ env, port: 0, now: () => NOW, fetchImpl });
    const base = started.url;

    const status = await (await fetch(`${base}api/sync/status`)).json();
    assert.equal(status.enabled, true);
    assert.equal(status.endpoint, "https://sync.example.com");

    const pushEnv = { ...env, DSH_COCKPIT_SYNC_TOKEN: `ccs_${"A".repeat(43)}` };
    // 服务器已捕获 env，需重新启动以注入令牌
    await new Promise((resolve) => started.server.close(resolve));
    started = await startServer({ env: pushEnv, port: 0, now: () => NOW, fetchImpl });
    const base2 = started.url;

    const push = await (await fetch(`${base2}api/sync/push`, { method: "POST" })).json();
    assert.equal(push.ok, true);
    assert.equal(push.pushed.accepted, true);
    const snapshotCall = calls.find((call) => call.url.endsWith("/v1/snapshots") && call.method === "POST");
    assert.ok(snapshotCall);
    const sent = JSON.stringify(snapshotCall.body);
    assert.ok(!sent.includes("session-sync"), "快照不得包含真实会话 id");
    assert.ok(!sent.includes("--p--"), "快照不得包含工作区标识");

    const pull = await (await fetch(`${base2}api/sync/pull`, { method: "POST" })).json();
    assert.equal(pull.ok, true);
    assert.equal(pull.devices, 1);
  } finally {
    if (started) await new Promise((resolve) => started.server.close(resolve));
    rmSync(root, { recursive: true, force: true });
  }
});
