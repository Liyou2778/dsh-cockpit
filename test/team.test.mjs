/**
 * 团队 v1 测试：设备即成员 + 空间共享计划。
 * - Worker 端到端：成员列表 / 改名（owner 与本人）/ 计划读写 / 权限 / 撤销；
 * - 客户端方法：members / renameMember / getSpaceSettings / saveSpaceSettings；
 * - 团队报表：本机实时数据、远端快照、计划占比、离线降级。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildSnapshot, createSyncClient } from "../src/sync/client.mjs";
import { createMemoryStore, handleRequest } from "../cloud/usage-sync-worker/src/index.js";
import { buildTeamReport } from "../src/sync/team.mjs";

const NOW = Date.parse("2026-11-03T16:00:00+08:00");
const ORIGIN = "https://cockpit.example.test";
const ENDPOINT = "https://sync.example.test";
const BOOTSTRAP_SECRET = "team-bootstrap-secret-0123456789abcdef";

function allowLimiter() {
  return { limit: async () => ({ success: true }) };
}

function makeEnv() {
  return {
    DB: createMemoryStore(),
    BOOTSTRAP_SECRET,
    ALLOWED_ORIGIN: ORIGIN,
    AUTH_RATE_LIMITER: allowLimiter(),
    API_RATE_LIMITER: allowLimiter(),
    NOW,
  };
}

function apiRequest(env, method, path, { body, token, origin = ORIGIN, headers = {} } = {}) {
  const mergedHeaders = { ...headers };
  if (body !== undefined) mergedHeaders["content-type"] = "application/json";
  if (token) mergedHeaders.authorization = `Bearer ${token}`;
  if (origin) mergedHeaders.origin = origin;
  const init = { method, headers: mergedHeaders };
  if (body !== undefined) init.body = JSON.stringify(body);
  return handleRequest(new Request(`${ENDPOINT}${path}`, init), env);
}

function clientFor(env, token) {
  return createSyncClient({
    endpoint: ENDPOINT,
    token,
    timeoutMs: 3_000,
    retries: 0,
    fetchImpl: async (url, init) => handleRequest(new Request(url, init), env),
  });
}

async function bootstrapSpace(env) {
  const response = await apiRequest(env, "POST", "/v1/spaces", {
    headers: { "x-bootstrap-secret": env.BOOTSTRAP_SECRET },
    body: { displayName: "Owner", deviceId: "device-owner-01", spaceName: "team" },
  });
  const payload = await response.json();
  assert.equal(response.status, 201, JSON.stringify(payload));
  return payload;
}

async function newInvite(env, token) {
  const response = await apiRequest(env, "POST", "/v1/spaces", { token, body: {} });
  const payload = await response.json();
  assert.equal(response.status, 200, JSON.stringify(payload));
  return payload.inviteCode;
}

function snapshotFor(nowMs, { date, tokens, costCny }) {
  return buildSnapshot({
    generatedAt: new Date(nowMs - 60_000).toISOString(),
    days: [{ date, tokens, costCny }],
    models: [{ model: "deepseek-flash", tokens, costCny }],
    totals: { tokens, costCny },
  });
}

test("Worker：成员列表 / 共享计划读写 / 改名权限 / 撤销", async () => {
  const env = makeEnv();
  const owner = await bootstrapSpace(env);
  const ownerClient = clientFor(env, owner.token);

  let report = await ownerClient.members();
  assert.equal(report.members.length, 1);
  assert.equal(report.members[0].role, "owner");
  assert.equal(report.members[0].isSelf, true);
  assert.equal(report.space.plan, null);

  const saved = await ownerClient.saveSpaceSettings({
    plan: { dailyTokenCap: 10_000_000, dayTotalPercent: 90, note: "冲刺周" },
  });
  assert.equal(saved.settings.plan.dailyTokenCap, 10_000_000);

  const settings = await ownerClient.getSpaceSettings();
  assert.equal(settings.settings.plan.dayTotalPercent, 90);
  assert.equal(settings.settings.plan.note, "冲刺周");

  const inviteCode = await newInvite(env, owner.token);
  const memberClient = clientFor(env, null);
  const enrolled = await memberClient.enroll({ inviteCode, displayName: "Alice", deviceId: "device-alice" });
  assert.equal(enrolled.role, "member");

  // 成员不能改空间计划、不能改别人
  await assert.rejects(
    () => memberClient.saveSpaceSettings({ plan: { dayTotalPercent: 80 } }),
    (error) => error.code === "OWNER_REQUIRED",
  );
  await assert.rejects(
    () => memberClient.renameMember({ deviceId: "device-owner-01", displayName: "hack" }),
    (error) => error.code === "OWNER_REQUIRED",
  );

  // 成员可以改自己
  const renamed = await memberClient.renameMember({ deviceId: "device-alice", displayName: "Alice-笔记本" });
  assert.equal(renamed.displayName, "Alice-笔记本");

  await memberClient.push(snapshotFor(NOW, { date: "2026-11-03", tokens: 5000, costCny: 1.2 }));
  report = await ownerClient.members();
  assert.equal(report.members.length, 2);
  const alice = report.members.find((row) => row.deviceId === "device-alice");
  assert.equal(alice.displayName, "Alice-笔记本");
  assert.equal(alice.snapshot.lastDay.tokens, 5000);
  assert.equal(report.space.plan.dailyTokenCap, 10_000_000);

  // owner 撤销设备 → 成员仍在列表但标记 revoked
  await ownerClient.revoke("device-alice");
  report = await ownerClient.members();
  const revoked = report.members.find((row) => row.deviceId === "device-alice");
  assert.ok(revoked.revokedAt);
});

test("Worker：非法计划被拒（负值 / 未知字段 / 越界百分比）", async () => {
  const env = makeEnv();
  const owner = await bootstrapSpace(env);
  const ownerClient = clientFor(env, owner.token);
  await assert.rejects(
    () => ownerClient.saveSpaceSettings({ plan: { dailyTokenCap: -1 } }),
    (error) => error.code === "SETTINGS_INVALID",
  );
  await assert.rejects(
    () => ownerClient.saveSpaceSettings({ plan: { dayTotalPercent: 101 } }),
    (error) => error.code === "SETTINGS_INVALID",
  );
  const response = await apiRequest(env, "PUT", "/v1/space/settings", {
    token: owner.token,
    body: { plan: { dailyTokenCap: 1 }, extra: true },
  });
  assert.equal(response.status, 400);
  const payload = await response.json();
  assert.equal(payload.error.code, "INVALID_BODY");
});

test("团队报表：本机实时 + 远端快照 + 计划占比 + 离线降级", async () => {
  const config = { sync: { enabled: true, deviceId: "dev-self", spaceLabel: "team" } };
  const data = {
    space: { name: "team", plan: { dailyTokenCap: 10_000, dayTotalPercent: 90, note: "" } },
    self: "dev-self",
    members: [
      { deviceId: "dev-self", displayName: "Me", role: "owner", isSelf: true, lastSeenAt: new Date(NOW).toISOString(), snapshot: null },
      {
        deviceId: "dev-b",
        displayName: "Bob",
        role: "member",
        isSelf: false,
        lastSeenAt: new Date(NOW - 60_000).toISOString(),
        snapshot: { lastDay: { date: "2026-11-03", tokens: 4000, costCny: 0.8 } },
      },
    ],
  };
  const report = await buildTeamReport({
    config,
    nowMs: NOW,
    localStatus: { generatedAt: new Date(NOW).toISOString(), totals: { todayTokens: 2000, todayCostCny: 0.4 } },
    client: { members: async () => data },
  });
  assert.equal(report.enabled, true);
  const self = report.members.find((row) => row.isSelf);
  const bob = report.members.find((row) => row.deviceId === "dev-b");
  assert.equal(self.today.tokens, 2000);
  assert.equal(self.source, "live");
  assert.equal(self.planPercent, 20);
  assert.equal(bob.today.tokens, 4000);
  assert.equal(bob.source, "snapshot");
  assert.equal(bob.planPercent, 40);
  assert.equal(report.totals.todayTokens, 6000);
  assert.equal(report.totals.planUsedPercent, 60);

  const offline = await buildTeamReport({
    config,
    nowMs: NOW,
    client: { members: async () => { throw Object.assign(new Error("network"), { code: "SYNC_NETWORK_ERROR" }); } },
  });
  assert.equal(offline.offline, true);
  assert.equal(offline.error.code, "SYNC_NETWORK_ERROR");

  const disabled = await buildTeamReport({ config: { sync: { enabled: false } } });
  assert.equal(disabled.enabled, false);
  assert.equal(disabled.reason, "SYNC_DISABLED");
});
