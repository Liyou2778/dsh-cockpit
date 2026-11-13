import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseCredentialsYaml,
  normalizeAccountSummary,
  fetchAccountSummary,
  createAccountService,
} from "../src/core/account.mjs";
import { buildStatus, buildAccountReport } from "../src/core/index.mjs";
import { saveConfig } from "../src/core/config.mjs";

const NOW = Date.parse("2026-11-04T16:00:00+08:00");
const TOKEN = "a".repeat(64);
const ISSUER = "https://platform.deepseek.com";

function setupEnv() {
  const root = mkdtempSync(join(tmpdir(), "cockpit-account-"));
  const dshHome = join(root, ".dsh");
  mkdirSync(dshHome, { recursive: true });
  return { root, env: { DSH_HOME: dshHome, DSH_COCKPIT_HOME: join(root, ".cockpit") } };
}

function writeCredentials(env, { token = TOKEN, issuer = ISSUER } = {}) {
  const yaml = [
    "version: 1",
    "refs:",
    "  DEEPSEEK_API_KEY: sk-test",
    "records:",
    "  deepseek-account-platform/default:",
    "    kind: local",
    "    payload:",
    "      version: 1",
    `      token: ${token}`,
    `      issuer: ${issuer}`,
  ].join("\n");
  writeFileSync(join(env.DSH_HOME, ".credentials.yaml"), yaml, "utf8");
}

const summaryPayload = {
  code: 0,
  data: {
    biz_code: 0,
    biz_data: {
      normal_wallets: [{ currency: "CNY", balance: "123.456789", token_estimation: "0" }],
      bonus_wallets: [{ currency: "CNY", balance: "10.00", token_estimation: "0" }],
      total_costs: [{ currency: "CNY", amount: "9876.543210" }],
    },
  },
};

test("DSH 凭据解析：只读 grant，不暴露其他字段", () => {
  const parsed = parseCredentialsYaml([
    "version: 1",
    "records:",
    "  deepseek-account-platform/default:",
    "    payload:",
    `      token: ${TOKEN}`,
    `      issuer: ${ISSUER}`,
  ].join("\n"));
  assert.equal(parsed.records["deepseek-account-platform/default"].payload.token, TOKEN);
  assert.equal(parsed.records["deepseek-account-platform/default"].payload.issuer, ISSUER);
});

test("官方 summary 归一：余额/累计花费保留字符串原样", () => {
  const normalized = normalizeAccountSummary(summaryPayload);
  assert.equal(normalized.normalWallets[0].balance, "123.456789");
  assert.equal(normalized.bonusWallets[0].balance, "10.00");
  assert.equal(normalized.totalCosts[0].amount, "9876.543210");
});

test("fetchAccountSummary：走 grant、issuer 校验、错误映射、不含 token", async () => {
  const { root, env } = setupEnv();
  try {
    writeCredentials(env);
    let captured = null;
    const ok = await fetchAccountSummary({
      env,
      fetchImpl: async (url, options) => {
        captured = { url, options };
        return { ok: true, json: async () => summaryPayload };
      },
    });
    assert.equal(ok.ok, true);
    assert.equal(ok.normalBalance, "123.456789");
    assert.equal(ok.totalCost, "9876.543210");
    assert.equal(captured.url, `${ISSUER}/api/v0/users/get_user_summary`);
    assert.equal(captured.options.headers["x-dsh-auth-token"], TOKEN);

    const unauthorized = await fetchAccountSummary({ env, fetchImpl: async () => ({ ok: false, status: 401 }) });
    assert.equal(unauthorized.code, "ACCOUNT_UNAUTHORIZED");
    assert.ok(!unauthorized.message.includes(TOKEN));

    const wrongIssuer = await fetchAccountSummary({ env: { ...env, DSH_HOME: env.DSH_HOME }, origin: "https://example.test", fetchImpl: async () => ({ ok: true, json: async () => summaryPayload }) });
    assert.equal(wrongIssuer.code, "ACCOUNT_ISSUER_MISMATCH");

    const noGrant = await fetchAccountSummary({ env: { DSH_HOME: join(root, "empty") }, fetchImpl: async () => ({ ok: true, json: async () => summaryPayload }) });
    assert.equal(noGrant.code, "ACCOUNT_NO_CREDENTIALS");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("account 服务 TTL + status.account + 默认关闭", async () => {
  const { root, env } = setupEnv();
  try {
    writeCredentials(env);
    let calls = 0;
    const service = createAccountService({
      env,
      ttlMs: 60_000,
      fetchImpl: async () => {
        calls += 1;
        return { ok: true, json: async () => summaryPayload };
      },
    });
    const service2 = createAccountService({
      env,
      ttlMs: 0,
      fetchImpl: async () => ({ ok: true, json: async () => summaryPayload }),
    });
    const first = await service.get();
    await service.get();
    assert.equal(calls, 1, "TTL 内只请求一次");
    assert.equal(first.available, true);
    assert.equal(first.normalBalance, "123.456789");

    // 默认关闭：未配置时 status.account.enabled=false
    const disabled = await buildStatus({ env, nowMs: NOW, accountService: service2 });
    assert.equal(disabled.account.enabled, false);

    saveConfig({ account: { enabled: true } }, env);
    const report = await buildAccountReport({ env, service: service2, refresh: true });
    assert.equal(report.available, true);
    assert.equal(report.totalCost, "9876.543210");
    assert.equal(report.source, "dsh-account-grant");

    const status = await buildStatus({ env, nowMs: NOW, accountService: service2 });
    assert.equal(status.account.available, true);
    assert.equal(status.account.normalBalance, "123.456789");
    assert.equal(status.precision.policyVersion, "PRECISION_V1");
    assert.ok(status.precision.official.some((line) => line.includes("account.normalBalance")));
    assert.ok(status.precision.derived.some((line) => line.includes("CostCny")));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
