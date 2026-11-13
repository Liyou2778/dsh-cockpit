import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeSyntheticSession, sessionHeader, contextEvent, assistantEvent } from "./helpers.mjs";
import {
  normalizeBalancePayload,
  fetchBalance,
  createBalanceService,
  appendBalanceSnapshot,
  loadBalanceHistory,
  reconcileBalance,
} from "../src/core/balance.mjs";
import { buildStatus, buildBalanceReport } from "../src/core/index.mjs";
import { saveConfig, loadConfig } from "../src/core/config.mjs";

const NOW = Date.parse("2026-11-03T16:00:00+08:00");
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

function setupEnv() {
  const root = mkdtempSync(join(tmpdir(), "cockpit-balance-"));
  return { root, env: { DSH_HOME: join(root, ".dsh"), DSH_COCKPIT_HOME: join(root, ".cockpit") }, sessions: join(root, ".dsh", "sessions") };
}

function writeFixture(sessions) {
  return writeSyntheticSession(sessions, {
    projectSlug: "--b--",
    sessionId: "session-balance",
    lines: [
      sessionHeader({ id: "session-balance", createdAt: NOW - 3 * HOUR }),
      contextEvent({ time: NOW - 3 * HOUR }),
      assistantEvent({ time: NOW - 2 * HOUR, inputTokens: 1000, cacheReadTokens: 500, outputTokens: 100 }),
    ],
  });
}

test("余额响应归一：优先 CNY、字符串转数字、is_available", () => {
  const normalized = normalizeBalancePayload({
    is_available: true,
    balance_infos: [
      { currency: "USD", total_balance: "9.00", granted_balance: "0.00", topped_up_balance: "9.00" },
      { currency: "CNY", total_balance: "110.00", granted_balance: "10.00", topped_up_balance: "100.00" },
    ],
  });
  assert.deepEqual(normalized, { isAvailable: true, currency: "CNY", total: 110, granted: 10, toppedUp: 100 });
});

test("余额请求：无 Key / 401 / 成功 / 超时 都返回结构化结果", async () => {
  const noKey = await fetchBalance({ env: {} });
  assert.equal(noKey.ok, false);
  assert.equal(noKey.code, "BALANCE_NO_API_KEY");

  const unauthorized = await fetchBalance({
    env: { DEEPSEEK_API_KEY: "sk-test" },
    fetchImpl: async () => ({ ok: false, status: 401 }),
  });
  assert.equal(unauthorized.ok, false);
  assert.equal(unauthorized.code, "BALANCE_UNAUTHORIZED");
  assert.ok(!unauthorized.message.includes("sk-test"));

  let captured = null;
  const ok = await fetchBalance({
    env: { DEEPSEEK_API_KEY: "sk-test" },
    fetchImpl: async (url, options) => {
      captured = { url, options };
      return { ok: true, json: async () => ({ is_available: true, balance_infos: [{ currency: "CNY", total_balance: "12.50", granted_balance: "0", topped_up_balance: "12.5" }] }) };
    },
  });
  assert.equal(ok.ok, true);
  assert.equal(ok.total, 12.5);
  assert.equal(captured.url, "https://api.deepseek.com/user/balance");
  assert.equal(captured.options.headers.Authorization, "Bearer sk-test");

  const timeout = await fetchBalance({
    env: { DEEPSEEK_API_KEY: "sk-test" },
    timeoutMs: 10,
    fetchImpl: (url, options) =>
      new Promise((resolve, reject) => {
        options.signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
      }),
  });
  assert.equal(timeout.ok, false);
  assert.equal(timeout.code, "BALANCE_TIMEOUT");
});

test("实时服务：TTL 缓存、force 绕过、并发生效、快照落盘", async () => {
  const { root, env } = setupEnv();
  env.DEEPSEEK_API_KEY = "sk-test";
  try {
    let calls = 0;
    const fetchImpl = async () => {
      calls += 1;
      return {
        ok: true,
        json: async () => ({ is_available: true, balance_infos: [{ currency: "CNY", total_balance: "50.00", granted_balance: "5.00", topped_up_balance: "45.00" }] }),
      };
    };
    const service = createBalanceService({ env, fetchImpl, ttlMs: 60_000 });

    const first = await service.get();
    assert.equal(first.available, true);
    assert.equal(first.cached, false);
    assert.equal(first.total, 50);

    const second = await service.get();
    assert.equal(second.cached, true);
    assert.equal(calls, 1);

    const concurrent = await Promise.all([service.get({ force: true }), service.get({ force: true })]);
    assert.equal(calls, 2, "并发 force 只应发一次请求");
    assert.equal(concurrent[0].total, 50);

    const history = loadBalanceHistory(env);
    assert.ok(history.snapshots.length >= 1);
    assert.equal(history.snapshots.at(-1).total, 50);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("对账：官方扣费 vs 本地估算、快照不足、充值检测", () => {
  const base = NOW - DAY;
  const snapshots = [
    { at: base, total: 100 },
    { at: NOW - HOUR, total: 92 },
  ];
  const ok = reconcileBalance({ snapshots, current: { at: NOW, total: 90 }, now: NOW, localSpendCny: 9.5 });
  assert.equal(ok.available, true);
  assert.equal(ok.officialSpend, 10);
  assert.equal(ok.localSpend, 9.5);
  assert.equal(ok.drift, 0.5);
  assert.equal(ok.driftPercent, 5);
  assert.equal(ok.topupDetected, false);

  const insufficient = reconcileBalance({ snapshots: [{ at: NOW - HOUR / 2, total: 100 }], current: { at: NOW, total: 99 }, now: NOW });
  assert.equal(insufficient.available, false);
  assert.match(insufficient.note, /不足 1 小时/);

  // 无完整窗口，但首个快照已 ≥1h → 回退 since-first
  const sinceFirst = reconcileBalance({ snapshots: [{ at: NOW - 2 * HOUR, total: 100 }], current: { at: NOW, total: 98 }, now: NOW, localSpendCny: 1.5 });
  assert.equal(sinceFirst.available, true);
  assert.equal(sinceFirst.mode, "since-first");
  assert.equal(sinceFirst.officialSpend, 2);
  assert.equal(sinceFirst.windowActualMs, 2 * HOUR);

  // 自定义窗口：1 小时窗口可用更早快照做 full 基线
  const custom = reconcileBalance({ snapshots, current: { at: NOW, total: 90 }, windowMs: HOUR, now: NOW, localSpendCny: 2 });
  assert.equal(custom.available, true);
  assert.equal(custom.mode, "full");
  assert.equal(custom.baselineAt, new Date(NOW - HOUR).toISOString());

  const topup = reconcileBalance({ snapshots, current: { at: NOW, total: 150 }, now: NOW, localSpendCny: 1 });
  assert.equal(topup.topupDetected, true);
  assert.equal(topup.drift, null);
});

test("buildStatus：默认关闭；开启后返回实时余额与 24h 对账", async () => {
  const { root, env, sessions } = setupEnv();
  try {
    writeFixture(sessions);
    const disabled = await buildStatus({ env, nowMs: NOW });
    assert.equal(disabled.balance.enabled, false);
    assert.equal(disabled.balance.available, false);
    assert.equal(disabled.balance.reason, "DISABLED");

    saveConfig({ balance: { enabled: true } }, env);
    appendBalanceSnapshot(env, { at: NOW - DAY, currency: "CNY", total: 100, granted: 0, toppedUp: 100 }, NOW - DAY + 1);

    const stub = {
      get: async () => ({
        enabled: true,
        available: true,
        source: "official-api",
        currency: "CNY",
        total: 90,
        granted: 0,
        toppedUp: 90,
        isAvailable: true,
        fetchedAt: new Date(NOW).toISOString(),
        cached: false,
        ageMs: 0,
      }),
    };
    const status = await buildStatus({ env, nowMs: NOW, balanceService: stub });
    assert.equal(status.balance.available, true);
    assert.equal(status.balance.total, 90);
    assert.equal(status.balance.reconciliation.available, true);
    assert.equal(status.balance.reconciliation.officialSpend, 10);
    assert.equal(status.balance.reconciliation.mode, "full");
    assert.ok(Math.abs(status.balance.reconciliation.localSpend - 0.0028) < 1e-3);

    // 自定义窗口会被规范化夹到 [1h, 7d]
    saveConfig({ balance: { enabled: true, reconcileWindowMs: 60_000 } }, env);
    const clamped = loadConfig(env).config.balance.reconcileWindowMs;
    assert.equal(clamped, HOUR);

    const report = await buildBalanceReport({ env, nowMs: NOW, service: stub });
    assert.equal(report.available, true);
    assert.equal(report.policyVersion, "BALANCE_V1");
    assert.ok(Array.isArray(report.snapshots));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
