/**
 * 团队共享同步模块测试（≥15 例）：
 * - 客户端：快照脱敏 / 稳定哈希 / 令牌与端点校验 / 超时与重试 / 失败降级 / 合并顺序；
 * - Worker：bootstrap 保护、邀请过期与单次消费、设备上限、限流缺失 fail-closed、
 *   快照去重与 `_ts` 单调守卫、CORS、撤销、空间隔离；
 * - 端到端：Node 客户端 ↔ `handleRequest()` + 内存 DB 适配器（不依赖 wrangler / 网络）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  INVITE_PATTERN,
  SYNC_SCHEMA_VERSION,
  SyncError,
  TOKEN_PATTERN,
  buildSnapshot,
  buildSnapshotFromStatus,
  createSyncClient,
  createSyncClientFromConfig,
  isSyncEnabled,
  mergeRemote,
  snapshotHash,
  stableStringify,
} from "../src/sync/client.mjs";
import {
  createD1Store,
  createMemoryStore,
  handleRequest,
  randomInviteCode,
  randomToken,
  resolveDeviceLimit,
  sha256Hex,
  stableStringify as workerStableStringify,
} from "../cloud/usage-sync-worker/src/index.js";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const NOW = Date.parse("2026-11-03T04:00:00+08:00");
const ORIGIN = "https://cockpit.example.test";
const ENDPOINT = "https://sync.example.test";
const BOOTSTRAP_SECRET = "test-bootstrap-secret-0123456789abcdef";

function allowLimiter(result = { success: true }) {
  return { limit: async () => result };
}

function makeEnv(overrides = {}) {
  return {
    DB: createMemoryStore(),
    BOOTSTRAP_SECRET,
    ALLOWED_ORIGIN: ORIGIN,
    AUTH_RATE_LIMITER: allowLimiter(),
    API_RATE_LIMITER: allowLimiter(),
    NOW,
    ...overrides,
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

async function readJson(response) {
  return response.json();
}

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } });
}

async function bootstrapSpace(env, options = {}) {
  const response = await apiRequest(env, "POST", "/v1/spaces", {
    headers: { "x-bootstrap-secret": env.BOOTSTRAP_SECRET },
    body: {
      displayName: options.displayName ?? "Owner",
      deviceId: options.deviceId ?? "device-owner-01",
      spaceName: options.spaceName ?? "team",
    },
  });
  const payload = await readJson(response);
  assert.equal(response.status, 201, `bootstrap failed: ${JSON.stringify(payload)}`);
  return payload;
}

async function newInvite(env, token) {
  const response = await apiRequest(env, "POST", "/v1/spaces", { token, body: {} });
  const payload = await readJson(response);
  assert.equal(response.status, 200, `invite failed: ${JSON.stringify(payload)}`);
  return payload.inviteCode;
}

async function enrollDevice(env, { inviteCode, displayName, deviceId }) {
  const response = await apiRequest(env, "POST", "/v1/enroll", { body: { inviteCode, displayName, deviceId } });
  return { response, payload: await readJson(response) };
}

function sampleSnapshot(overrides = {}) {
  return buildSnapshot({
    generatedAt: new Date(NOW - 60_000).toISOString(),
    days: [
      { date: "2026-11-01", tokens: 1200, costCny: 0.35 },
      { date: "2026-11-02", tokens: 800, costCny: 0.21 },
    ],
    models: [{ model: "deepseek-flash", tokens: 2000, costCny: 0.56 }],
    totals: { tokens: 2000, costCny: 0.56 },
    ...overrides,
  });
}

// ===========================================================================
// 一、快照脱敏与构造
// ===========================================================================

test("buildSnapshot：只保留白名单聚合字段，_ts 与 generatedAt 一致", () => {
  const snapshot = buildSnapshot({
    generatedAt: "2026-11-03T00:00:00+08:00",
    days: [
      { date: "2026-11-01", tokens: 1200, costCny: 0.35 },
      { date: "2026-11-02", tokens: 800, costCny: 0.21 },
    ],
    models: [{ model: "deepseek-flash", tokens: 2000, costCny: 0.56 }],
    totals: { tokens: 2000, costCny: 0.56 },
  });

  assert.deepEqual(Object.keys(snapshot).sort(), ["_ts", "days", "generatedAt", "models", "schemaVersion", "totals"]);
  assert.equal(snapshot.schemaVersion, SYNC_SCHEMA_VERSION);
  assert.equal(snapshot.generatedAt, "2026-11-02T16:00:00.000Z");
  assert.equal(snapshot._ts, Date.parse("2026-11-02T16:00:00.000Z"));
  assert.deepEqual(snapshot.days[0], { date: "2026-11-01", tokens: 1200, costCny: 0.35 });
  assert.deepEqual(snapshot.models[0], { model: "deepseek-flash", tokens: 2000, costCny: 0.56 });
  assert.deepEqual(snapshot.totals, { tokens: 2000, costCny: 0.56 });
});

test("buildSnapshot：会话 id / 标题 / 路径 / 对话 / 凭据不会进入快照", () => {
  const snapshot = buildSnapshot({
    generatedAt: "2026-11-03T00:00:00+08:00",
    days: [
      {
        date: "2026-11-01",
        tokens: 10,
        costCny: 0.01,
        sessionId: "session-alpha",
        title: "客户机密标题",
        path: "C:/clients/secret-workspace",
        conversation: [{ role: "user", content: "对话正文不该同步" }],
      },
      { date: "2026-11-02", tokens: 20, costCny: 0.02, apiKey: "sk-plaintext-should-never-sync" },
    ],
    models: [{ model: "deepseek-flash", tokens: 30, costCny: 0.03, provider: "deepseek-official", credential: "sk-secret" }],
    totals: { tokens: 30, costCny: 0.03, title: "机密" },
  });
  const serialized = JSON.stringify(snapshot);
  for (const forbidden of [
    "session-",
    "客户机密标题",
    "C:/clients",
    "对话正文不该同步",
    "sk-plaintext",
    "sk-secret",
    "provider",
  ]) {
    assert.ok(!serialized.includes(forbidden), `快照不应包含：${forbidden}`);
  }
  assert.deepEqual(Object.keys(snapshot.days[0]).sort(), ["costCny", "date", "tokens"]);
  assert.deepEqual(Object.keys(snapshot.models[0]).sort(), ["costCny", "model", "tokens"]);
});

test("buildSnapshot：剔除非法日期/模型名，重复日期合并求和", () => {
  const snapshot = buildSnapshot({
    generatedAt: new Date(NOW).toISOString(),
    days: [
      { date: "2026-11-01", tokens: 10, costCny: 0.1 },
      { date: "2026-11-01", tokens: 5, costCny: 0.05 },
      { date: "not-a-date", tokens: 1 },
      { date: "2026-11-02", tokens: null, costCny: null },
    ],
    models: [
      { model: "deepseek-flash", tokens: 15 },
      { model: "带 空格 的模型", tokens: 99 },
      { model: "", tokens: 99 },
    ],
    totals: { tokens: 15, costCny: 0.15 },
  });
  assert.equal(snapshot.days.length, 1);
  assert.deepEqual(snapshot.days[0], { date: "2026-11-01", tokens: 15, costCny: 0.15 });
  assert.deepEqual(snapshot.models, [{ model: "deepseek-flash", tokens: 15, costCny: null }]);
});

test("buildSnapshotFromStatus：只消费 buildStatus 的聚合字段", () => {
  const snapshot = buildSnapshotFromStatus({
    generatedAt: "2026-11-03T08:00:00+08:00",
    history: [{ date: "2026-11-01", tokens: 100, costCny: 0.5, comfort: 2, status: "on_track" }],
    breakdown: {
      models: [{ model: "deepseek-flash", tokens: 100, costCny: 0.5, messages: 3 }],
      sessions: [{ id: "session-alpha", title: "机密会话标题" }],
    },
    totals: { cycleTokens: 100, cycleCostCny: 0.5 },
  });
  assert.deepEqual(snapshot.days[0], { date: "2026-11-01", tokens: 100, costCny: 0.5 });
  assert.deepEqual(snapshot.models[0], { model: "deepseek-flash", tokens: 100, costCny: 0.5 });
  assert.deepEqual(snapshot.totals, { tokens: 100, costCny: 0.5 });
  assert.ok(!JSON.stringify(snapshot).includes("机密会话标题"));
});

// ===========================================================================
// 二、稳定哈希与令牌格式
// ===========================================================================

test("snapshotHash：稳定序列化（键序无关）且输出 64 位 hex", () => {
  const left = { b: { d: 2, c: [1, "x"] }, a: 1 };
  const right = { a: 1, b: { c: [1, "x"], d: 2 } };
  assert.equal(stableStringify(left), stableStringify(right));
  assert.equal(snapshotHash(left), snapshotHash(right));
  assert.match(snapshotHash(left), /^[0-9a-f]{64}$/);
  assert.notEqual(snapshotHash({ a: 1 }), snapshotHash({ a: 2 }));
});

test("snapshotHash：与 Worker 端去重哈希完全一致（跨端契约）", async () => {
  const snapshot = sampleSnapshot();
  assert.equal(workerStableStringify(snapshot), stableStringify(snapshot));
  assert.equal(await sha256Hex(workerStableStringify(snapshot)), snapshotHash(snapshot));
});

test("令牌/邀请码格式：ccs_+43 与 CCI-+16，随机生成且不可伪造", () => {
  const token = randomToken();
  const invite = randomInviteCode();
  assert.match(token, TOKEN_PATTERN);
  assert.equal(token.length, 4 + 43);
  assert.match(invite, INVITE_PATTERN);
  assert.equal(invite.length, 4 + 16);
  assert.notEqual(randomToken(), token);
  assert.equal(TOKEN_PATTERN.test("ccs_short"), false);
  assert.equal(TOKEN_PATTERN.test(token.replace("ccs_", "ccx_")), false);
  assert.equal(INVITE_PATTERN.test("CCI-abc"), false);
  assert.equal(TOKEN_PATTERN.test(`${token}!`), false);
});

// ===========================================================================
// 三、客户端行为：默认关闭 / 端点 / 超时 / 重试 / 错误映射
// ===========================================================================

test("默认关闭：isSyncEnabled 与 createSyncClientFromConfig 拒绝未启用配置", () => {
  assert.equal(isSyncEnabled(undefined), false);
  assert.equal(isSyncEnabled({}), false);
  assert.equal(isSyncEnabled({ sync: { enabled: false } }), false);
  assert.equal(isSyncEnabled({ sync: { enabled: true } }), true);

  assert.throws(
    () => createSyncClientFromConfig({ sync: { enabled: false, endpoint: ENDPOINT } }),
    (error) => error instanceof SyncError && error.code === "SYNC_DISABLED",
  );
  const client = createSyncClientFromConfig(
    { sync: { enabled: true, endpoint: ENDPOINT } },
    { token: randomToken(), fetchImpl: async () => jsonResponse({ ok: true }) },
  );
  assert.equal(client.endpoint, ENDPOINT);
});

test("createSyncClient：拒绝非法端点，非本机必须 HTTPS", () => {
  const noFetch = async () => jsonResponse({ ok: true });
  assert.throws(() => createSyncClient({ endpoint: "", fetchImpl: noFetch }), (error) => error.code === "SYNC_INVALID_ENDPOINT");
  assert.throws(() => createSyncClient({ endpoint: "ftp://sync.example.test", fetchImpl: noFetch }), (error) => error.code === "SYNC_INVALID_ENDPOINT");
  assert.throws(() => createSyncClient({ endpoint: "http://sync.example.test", fetchImpl: noFetch }), (error) => error.code === "SYNC_INVALID_ENDPOINT");
  const loopback = createSyncClient({ endpoint: "http://127.0.0.1:8787/", token: randomToken(), fetchImpl: noFetch });
  assert.equal(loopback.endpoint, "http://127.0.0.1:8787");
});

test("enroll：邀请码换令牌并自动采用（请求形态正确）", async () => {
  const requested = [];
  const token = randomToken();
  const client = createSyncClient({
    endpoint: ENDPOINT,
    fetchImpl: async (url, init) => {
      requested.push({ url, init });
      return jsonResponse({ ok: true, spaceId: "spc_1", deviceId: "dev-1", role: "member", displayName: "Alice", token });
    },
  });
  const result = await client.enroll({ inviteCode: "CCI-AAAAAAAAAAAAAAAA", displayName: "Alice", deviceId: "dev-1" });
  assert.equal(result.token, token);
  assert.equal(client.getToken(), token);
  assert.equal(requested.length, 1);
  assert.equal(requested[0].url, `${ENDPOINT}/v1/enroll`);
  assert.equal(requested[0].init.method, "POST");
  assert.equal(requested[0].init.headers.authorization, undefined);
  assert.deepEqual(JSON.parse(requested[0].init.body), {
    inviteCode: "CCI-AAAAAAAAAAAAAAAA",
    displayName: "Alice",
    deviceId: "dev-1",
  });
});

test("enroll：非法邀请码在本地拒绝，不发起网络请求", async () => {
  let called = 0;
  const client = createSyncClient({
    endpoint: ENDPOINT,
    fetchImpl: async () => {
      called += 1;
      return jsonResponse({ ok: true });
    },
  });
  await assert.rejects(
    client.enroll({ inviteCode: "not-an-invite-code" }),
    (error) => error instanceof SyncError && error.code === "SYNC_INVALID_INVITE",
  );
  assert.equal(called, 0);
});

test("push/pull/revoke：缺少令牌时本地失败（SYNC_NO_TOKEN），不联网", async () => {
  const client = createSyncClient({
    endpoint: ENDPOINT,
    fetchImpl: async () => {
      throw new Error("不应发出网络请求");
    },
  });
  await assert.rejects(client.push(sampleSnapshot()), (error) => error.code === "SYNC_NO_TOKEN");
  await assert.rejects(client.pull(), (error) => error.code === "SYNC_NO_TOKEN");
  await assert.rejects(client.revoke("device-x-01"), (error) => error.code === "SYNC_NO_TOKEN");
});

test("HTTP 401 映射 UNAUTHORIZED 且不重试", async () => {
  let calls = 0;
  const client = createSyncClient({
    endpoint: ENDPOINT,
    token: randomToken(),
    fetchImpl: async () => {
      calls += 1;
      return jsonResponse({ ok: false, error: { code: "UNAUTHORIZED", message: "令牌无效" } }, 401);
    },
  });
  await assert.rejects(
    client.pull(),
    (error) => error instanceof SyncError && error.code === "UNAUTHORIZED" && error.status === 401 && error.retryable === false,
  );
  assert.equal(calls, 1);
});

test("HTTP 500：指数退避重试后成功（共 3 次尝试）", async () => {
  let calls = 0;
  const client = createSyncClient({
    endpoint: ENDPOINT,
    token: randomToken(),
    retryBaseMs: 0,
    fetchImpl: async () => {
      calls += 1;
      if (calls < 3) return jsonResponse({ ok: false, error: { code: "INTERNAL_ERROR", message: "boom" } }, 500);
      return jsonResponse({ ok: true, spaceId: "spc_1", snapshots: [] });
    },
  });
  assert.deepEqual(await client.pull(), []);
  assert.equal(calls, 3);
});

test("网络错误：重试耗尽后抛 SYNC_NETWORK_ERROR（可判定 retryable）", async () => {
  let calls = 0;
  const client = createSyncClient({
    endpoint: ENDPOINT,
    token: randomToken(),
    retries: 1,
    retryBaseMs: 0,
    fetchImpl: async () => {
      calls += 1;
      throw new Error("offline");
    },
  });
  await assert.rejects(
    client.pull(),
    (error) => error instanceof SyncError && error.code === "SYNC_NETWORK_ERROR" && error.retryable === true,
  );
  assert.equal(calls, 2);
});

test("超时：AbortController 触发后映射 SYNC_TIMEOUT", async () => {
  const client = createSyncClient({
    endpoint: ENDPOINT,
    token: randomToken(),
    timeoutMs: 20,
    retries: 0,
    fetchImpl: (_url, init) =>
      new Promise((_resolve, reject) => {
        init.signal.addEventListener("abort", () => reject(new Error("aborted")));
      }),
  });
  await assert.rejects(
    client.pull(),
    (error) => error instanceof SyncError && error.code === "SYNC_TIMEOUT" && error.retryable === true,
  );
});

test("失败降级：非 JSON 响应 → SYNC_BAD_RESPONSE，不抛裸字符串", async () => {
  const client = createSyncClient({
    endpoint: ENDPOINT,
    token: randomToken(),
    retries: 0,
    fetchImpl: async () => new Response("<html>upstream error</html>", { status: 200 }),
  });
  await assert.rejects(
    client.pull(),
    (error) => error instanceof SyncError && error.code === "SYNC_BAD_RESPONSE",
  );
});

// ===========================================================================
// 四、mergeRemote 合并顺序
// ===========================================================================

test("mergeRemote：同设备按 _ts 取最新，旧快照不覆盖新快照", () => {
  const newer = sampleSnapshot({
    generatedAt: new Date(NOW - 60_000).toISOString(),
    days: [{ date: "2026-11-02", tokens: 222, costCny: 2 }],
    totals: { tokens: 222, costCny: 2 },
  });
  const older = sampleSnapshot({
    generatedAt: new Date(NOW - 120_000).toISOString(),
    days: [{ date: "2026-11-01", tokens: 111, costCny: 1 }],
    totals: { tokens: 111, costCny: 1 },
  });
  const merged = mergeRemote([
    { deviceId: "dev-a", snapshot: older },
    { deviceId: "dev-a", snapshot: newer },
    { deviceId: "dev-a", payload: JSON.stringify(older) },
  ]);
  assert.equal(merged.totals.devices, 1);
  assert.equal(merged.byDevice["dev-a"]._ts, Date.parse(newer.generatedAt));
  assert.deepEqual(merged.byDevice["dev-a"].totals, { tokens: 222, costCny: 2 });
});

test("mergeRemote：跨设备聚合与损坏输入降级", () => {
  const deviceA = {
    deviceId: "dev-a",
    snapshot: sampleSnapshot({ totals: { tokens: 100, costCny: 0.5 } }),
  };
  const deviceB = {
    deviceId: "dev-b",
    snapshot: sampleSnapshot({ totals: { tokens: 50, costCny: 0.25 } }),
  };
  const merged = mergeRemote([deviceA, deviceB, null, { deviceId: "dev-c" }, { snapshot: { days: [] } }]);
  assert.equal(merged.totals.devices, 2);
  assert.equal(merged.totals.tokens, 150);
  assert.ok(Math.abs(merged.totals.costCny - 0.75) < 1e-9);
  assert.deepEqual(mergeRemote(undefined), { byDevice: {}, totals: { devices: 0, tokens: 0, costCny: 0 } });
});

// ===========================================================================
// 五、Worker：空间 / 邀请 / 设备
// ===========================================================================

test("POST /v1/spaces：bootstrap secret 保护；令牌只存 SHA-256", async () => {
  const env = makeEnv();
  const denied = await apiRequest(env, "POST", "/v1/spaces", {
    headers: { "x-bootstrap-secret": "wrong-secret-000" },
    body: { displayName: "Owner", deviceId: "device-owner-01" },
  });
  assert.equal(denied.status, 401);
  assert.equal((await readJson(denied)).error.code, "BOOTSTRAP_DENIED");

  const created = await bootstrapSpace(env);
  assert.match(created.token, TOKEN_PATTERN);
  assert.match(created.inviteCode, INVITE_PATTERN);
  assert.equal(created.role, "owner");
  assert.equal(created.serverTime, new Date(NOW).toISOString());

  const members = await env.DB.listMembers(created.space.id);
  assert.equal(members.length, 1);
  assert.equal(members[0].tokenHash, await sha256Hex(created.token));
  assert.ok(!JSON.stringify(members).includes(created.token), "数据库行不得包含明文令牌");
});

test("POST /v1/enroll：邀请码 24h 过期 → 410 INVITE_EXPIRED", async () => {
  const env = makeEnv();
  const created = await bootstrapSpace(env);
  const later = makeEnv({ DB: env.DB, NOW: NOW + 24 * 60 * 60 * 1000 + 1 });
  const { response, payload } = await enrollDevice(later, {
    inviteCode: created.inviteCode,
    displayName: "Late",
    deviceId: "device-late-01",
  });
  assert.equal(response.status, 410);
  assert.equal(payload.error.code, "INVITE_EXPIRED");
});

test("POST /v1/enroll：邀请码单次使用 → 第二次 410 INVITE_USED", async () => {
  const env = makeEnv();
  const created = await bootstrapSpace(env);
  const first = await enrollDevice(env, {
    inviteCode: created.inviteCode,
    displayName: "Bob",
    deviceId: "device-bob-01",
  });
  assert.equal(first.response.status, 200);
  assert.match(first.payload.token, TOKEN_PATTERN);

  const second = await enrollDevice(env, {
    inviteCode: created.inviteCode,
    displayName: "Carol",
    deviceId: "device-carol-01",
  });
  assert.equal(second.response.status, 410);
  assert.equal(second.payload.error.code, "INVITE_USED");
});

test("设备上限：第 33 台设备 → 409 DEVICE_LIMIT（硬上限 32）", async () => {
  const env = makeEnv();
  const created = await bootstrapSpace(env);
  for (let index = 2; index <= 32; index += 1) {
    const inviteCode = await newInvite(env, created.token);
    const result = await enrollDevice(env, {
      inviteCode,
      displayName: `Device ${index}`,
      deviceId: `device-${String(index).padStart(2, "0")}`,
    });
    assert.equal(result.response.status, 200, `enroll ${index} failed: ${JSON.stringify(result.payload)}`);
  }
  const inviteCode = await newInvite(env, created.token);
  const overflow = await enrollDevice(env, {
    inviteCode,
    displayName: "Device 33",
    deviceId: "device-33",
  });
  assert.equal(overflow.response.status, 409);
  assert.equal(overflow.payload.error.code, "DEVICE_LIMIT");
  const active = (await env.DB.listMembers(created.space.id)).filter((member) => member.revokedAt === null);
  assert.equal(active.length, 32);
  assert.equal(resolveDeviceLimit({ SPACE_DEVICE_LIMIT: "999" }), 32);
  assert.equal(resolveDeviceLimit({ SPACE_DEVICE_LIMIT: "8" }), 8);
});

// ===========================================================================
// 六、Worker：安全基线（限流 / CORS / 鉴权）
// ===========================================================================

test("限流缺失 → 503 fail-closed（缺 AUTH / API 任一）", async () => {
  const missingAuth = makeEnv({ AUTH_RATE_LIMITER: undefined });
  const responseA = await apiRequest(missingAuth, "GET", "/v1/snapshots", { token: randomToken() });
  assert.equal(responseA.status, 503);
  assert.equal((await readJson(responseA)).error.code, "RATE_LIMITER_UNAVAILABLE");

  const missingApi = makeEnv({ API_RATE_LIMITER: undefined });
  const responseB = await apiRequest(missingApi, "POST", "/v1/enroll", {
    body: { inviteCode: "CCI-AAAAAAAAAAAAAAAA", displayName: "x", deviceId: "device-x-01" },
  });
  assert.equal(responseB.status, 503);
  assert.equal((await readJson(responseB)).error.code, "RATE_LIMITER_UNAVAILABLE");
});

test("免费计划降级：ALLOW_NO_RATE_LIMITER=1 且无限流绑定 → 放行（其余校验不变）", async () => {
  const env = makeEnv({ AUTH_RATE_LIMITER: undefined, API_RATE_LIMITER: undefined, ALLOW_NO_RATE_LIMITER: "1" });
  const created = await apiRequest(env, "POST", "/v1/spaces", {
    headers: { "x-bootstrap-secret": env.BOOTSTRAP_SECRET },
    body: { displayName: "Owner", deviceId: "device-owner-01", spaceName: "team" },
  });
  assert.equal(created.status, 201);
  assert.equal(created.headers.get("x-cockpit-degraded"), "no-rate-limiter");

  // 降级只跳过限流：bootstrap secret 校验仍然生效
  const denied = await apiRequest(env, "POST", "/v1/spaces", { body: { displayName: "x", deviceId: "device-x-01" } });
  assert.equal(denied.status, 401);
});

test("限流触发 → 429 RATE_LIMITED", async () => {
  const env = makeEnv({ AUTH_RATE_LIMITER: { limit: async () => ({ success: false }) } });
  const response = await apiRequest(env, "POST", "/v1/enroll", {
    body: { inviteCode: "CCI-AAAAAAAAAAAAAAAA", displayName: "x", deviceId: "device-x-01" },
  });
  assert.equal(response.status, 429);
  assert.equal((await readJson(response)).error.code, "RATE_LIMITED");
});

test("CORS：白名单回显 / 非白名单 403 / 预检 204 / 配置缺失 503", async () => {
  const env = makeEnv();
  const preflight = await apiRequest(env, "OPTIONS", "/v1/snapshots");
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get("access-control-allow-origin"), ORIGIN);
  assert.match(preflight.headers.get("access-control-allow-headers") ?? "", /authorization/);

  const blocked = await apiRequest(env, "POST", "/v1/enroll", { origin: "https://evil.example.test", body: {} });
  assert.equal(blocked.status, 403);
  assert.equal((await readJson(blocked)).error.code, "ORIGIN_NOT_ALLOWED");
  assert.equal(blocked.headers.get("access-control-allow-origin"), null);

  const misconfigured = makeEnv({ ALLOWED_ORIGIN: "" });
  const response = await apiRequest(misconfigured, "GET", "/v1/snapshots", { token: randomToken() });
  assert.equal(response.status, 503);
  assert.equal((await readJson(response)).error.code, "SERVER_MISCONFIGURED");
});

test("鉴权：非法 Bearer 格式 → INVALID_TOKEN；未知令牌 → UNAUTHORIZED", async () => {
  const env = makeEnv();
  const badFormat = await apiRequest(env, "GET", "/v1/snapshots", { headers: { authorization: "Bearer not-a-token" } });
  assert.equal(badFormat.status, 401);
  assert.equal((await readJson(badFormat)).error.code, "INVALID_TOKEN");

  const unknown = await apiRequest(env, "GET", "/v1/snapshots", { token: randomToken() });
  assert.equal(unknown.status, 401);
  assert.equal((await readJson(unknown)).error.code, "UNAUTHORIZED");
});

// ===========================================================================
// 七、Worker：快照上传 / 去重 / 单调守卫 / 空间隔离
// ===========================================================================

test("快照上传：payload_hash 去重；拉取返回本设备最新快照", async () => {
  const env = makeEnv();
  const created = await bootstrapSpace(env);
  const snapshot = sampleSnapshot();

  const first = await apiRequest(env, "POST", "/v1/snapshots", { token: created.token, body: { snapshot } });
  const firstBody = await readJson(first);
  assert.equal(first.status, 200);
  assert.equal(firstBody.accepted, true);
  assert.equal(firstBody.deduped, false);
  assert.match(firstBody.payloadHash, /^[0-9a-f]{64}$/);

  const replay = await apiRequest(env, "POST", "/v1/snapshots", { token: created.token, body: { snapshot } });
  const replayBody = await readJson(replay);
  assert.equal(replay.status, 200);
  assert.equal(replayBody.accepted, false);
  assert.equal(replayBody.deduped, true);

  const pulled = await readJson(await apiRequest(env, "GET", "/v1/snapshots", { token: created.token }));
  assert.equal(pulled.snapshots.length, 1);
  assert.equal(pulled.snapshots[0].deviceId, created.deviceId);
  assert.deepEqual(pulled.snapshots[0].snapshot, snapshot);
});

test("快照单调守卫：_ts 更旧的快照 → 409 SNAPSHOT_STALE 且不覆盖", async () => {
  const env = makeEnv();
  const created = await bootstrapSpace(env);
  const newer = buildSnapshot({
    generatedAt: new Date(NOW - 30_000).toISOString(),
    days: [{ date: "2026-11-02", tokens: 200, costCny: 0.2 }],
    totals: { tokens: 200, costCny: 0.2 },
  });
  const older = buildSnapshot({
    generatedAt: new Date(NOW - 300_000).toISOString(),
    days: [{ date: "2026-11-01", tokens: 100, costCny: 0.1 }],
    totals: { tokens: 100, costCny: 0.1 },
  });
  const accepted = await apiRequest(env, "POST", "/v1/snapshots", { token: created.token, body: { snapshot: newer } });
  assert.equal(accepted.status, 200);

  const stale = await apiRequest(env, "POST", "/v1/snapshots", { token: created.token, body: { snapshot: older } });
  assert.equal(stale.status, 409);
  assert.equal((await readJson(stale)).error.code, "SNAPSHOT_STALE");

  const pulled = await readJson(await apiRequest(env, "GET", "/v1/snapshots", { token: created.token }));
  assert.deepEqual(pulled.snapshots[0].snapshot, newer);
});

test("快照校验：含会话 id / 标题等未知字段 → 400 且不回显敏感值；非 JSON → 400", async () => {
  const env = makeEnv();
  const created = await bootstrapSpace(env);
  const leaked = { ...sampleSnapshot(), sessionId: "session-alpha", title: "客户机密标题" };
  const topLevel = await apiRequest(env, "POST", "/v1/snapshots", { token: created.token, body: { snapshot: leaked } });
  assert.equal(topLevel.status, 400);
  const topLevelBody = await readJson(topLevel);
  assert.equal(topLevelBody.error.code, "SNAPSHOT_INVALID");
  assert.ok(!JSON.stringify(topLevelBody).includes("客户机密标题"), "错误响应不得回显敏感字段");

  const nested = sampleSnapshot();
  nested.days[0].title = "会话标题不该出现";
  const nestedResponse = await apiRequest(env, "POST", "/v1/snapshots", { token: created.token, body: { snapshot: nested } });
  assert.equal(nestedResponse.status, 400);
  assert.equal((await readJson(nestedResponse)).error.code, "SNAPSHOT_INVALID");

  const brokenJson = await handleRequest(
    new Request(`${ENDPOINT}/v1/snapshots`, {
      method: "POST",
      headers: { authorization: `Bearer ${created.token}`, origin: ORIGIN, "content-type": "application/json" },
      body: "{not-json",
    }),
    env,
  );
  assert.equal(brokenJson.status, 400);
  assert.equal((await readJson(brokenJson)).error.code, "INVALID_JSON");
});

test("空间隔离：不同 space 看不到彼此的快照", async () => {
  const env = makeEnv();
  const spaceA = await bootstrapSpace(env, { displayName: "A", deviceId: "device-a-01" });
  const spaceB = await bootstrapSpace(env, { displayName: "B", deviceId: "device-b-01" });
  assert.notEqual(spaceA.space.id, spaceB.space.id);
  await apiRequest(env, "POST", "/v1/snapshots", { token: spaceA.token, body: { snapshot: sampleSnapshot() } });
  const pulledB = await readJson(await apiRequest(env, "GET", "/v1/snapshots", { token: spaceB.token }));
  assert.equal(pulledB.snapshots.length, 0);
});

// ===========================================================================
// 八、Worker：撤销 / 路由
// ===========================================================================

test("设备撤销：仅 owner 可撤销其他设备；撤销 ≠ 删除历史快照", async () => {
  const env = makeEnv();
  const owner = await bootstrapSpace(env);
  const member = await enrollDevice(env, {
    inviteCode: owner.inviteCode,
    displayName: "Bob",
    deviceId: "device-bob-01",
  });
  const memberToken = member.payload.token;
  await apiRequest(env, "POST", "/v1/snapshots", { token: memberToken, body: { snapshot: sampleSnapshot() } });

  const notOwner = await apiRequest(env, "POST", "/v1/devices/revoke", {
    token: memberToken,
    body: { deviceId: owner.deviceId },
  });
  assert.equal(notOwner.status, 403);
  assert.equal((await readJson(notOwner)).error.code, "OWNER_REQUIRED");

  const self = await apiRequest(env, "POST", "/v1/devices/revoke", {
    token: owner.token,
    body: { deviceId: owner.deviceId },
  });
  assert.equal(self.status, 400);
  assert.equal((await readJson(self)).error.code, "CANNOT_REVOKE_SELF");

  const revoke = await apiRequest(env, "POST", "/v1/devices/revoke", {
    token: owner.token,
    body: { deviceId: "device-bob-01" },
  });
  assert.equal(revoke.status, 200);
  assert.equal((await readJson(revoke)).revoked, true);

  const revokedUse = await apiRequest(env, "GET", "/v1/snapshots", { token: memberToken });
  assert.equal(revokedUse.status, 401);
  assert.equal((await readJson(revokedUse)).error.code, "DEVICE_REVOKED");

  // 撤销只停用令牌，不清除已上传快照（保留期/删除由运营者负责）。
  const pulled = await readJson(await apiRequest(env, "GET", "/v1/snapshots", { token: owner.token }));
  const bobRows = pulled.snapshots.filter((row) => row.deviceId === "device-bob-01");
  assert.equal(bobRows.length, 1);
  assert.equal(bobRows[0].revoked, true);

  const again = await readJson(
    await apiRequest(env, "POST", "/v1/devices/revoke", { token: owner.token, body: { deviceId: "device-bob-01" } }),
  );
  assert.equal(again.alreadyRevoked, true);
});

test("路由：未知路径 404；已知路径错误方法 405", async () => {
  const env = makeEnv();
  const notFound = await apiRequest(env, "GET", "/v1/unknown", { token: randomToken() });
  assert.equal(notFound.status, 404);
  assert.equal((await readJson(notFound)).error.code, "NOT_FOUND");

  const wrongMethod = await apiRequest(env, "GET", "/v1/enroll");
  assert.equal(wrongMethod.status, 405);
  assert.equal((await readJson(wrongMethod)).error.code, "METHOD_NOT_ALLOWED");
});

// ===========================================================================
// 九、端到端：客户端 ↔ Worker（内存 D1）
// ===========================================================================

test("端到端：enroll → push → pull → mergeRemote；owner 可撤销 member", async () => {
  const env = makeEnv();
  const owner = await bootstrapSpace(env);
  const inviteCode = await newInvite(env, owner.token);
  const enrolled = await enrollDevice(env, { inviteCode, displayName: "Bob", deviceId: "device-bob-01" });
  assert.equal(enrolled.response.status, 200);

  const workerFetch = async (url, init) =>
    handleRequest(
      new Request(url, {
        method: init.method,
        headers: init.headers,
        body: init.body,
        signal: init.signal,
      }),
      env,
    );
  const memberClient = createSyncClient({
    endpoint: ENDPOINT,
    token: enrolled.payload.token,
    fetchImpl: workerFetch,
    retryBaseMs: 0,
  });
  const snapshot = sampleSnapshot();
  const pushed = await memberClient.push(snapshot);
  assert.equal(pushed.accepted, true);
  assert.equal(pushed.payloadHash, snapshotHash(snapshot));

  const replay = await memberClient.push(snapshot);
  assert.equal(replay.deduped, true, "同一快照重复推送应命中 payload_hash 去重");

  const pulled = await memberClient.pull();
  assert.equal(pulled.length, 1);
  assert.equal(pulled[0].deviceId, "device-bob-01");
  const merged = mergeRemote(pulled);
  assert.equal(merged.totals.devices, 1);
  assert.equal(merged.totals.tokens, snapshot.totals.tokens);

  const ownerClient = createSyncClient({
    endpoint: ENDPOINT,
    token: owner.token,
    fetchImpl: workerFetch,
    retryBaseMs: 0,
  });
  const revoked = await ownerClient.revoke("device-bob-01");
  assert.equal(revoked.revoked, true);
  await assert.rejects(memberClient.pull(), (error) => error.code === "DEVICE_REVOKED");
});

// ===========================================================================
// 十、D1 适配器 SQL 等价验证（node:sqlite 可用时；不依赖 wrangler）
// ===========================================================================

test("D1 适配器：迁移 SQL + 参数化查询可在 SQLite 等价执行（node:sqlite，缺省跳过）", async (t) => {
  let DatabaseSync;
  try {
    ({ DatabaseSync } = await import("node:sqlite"));
  } catch {
    t.skip("当前 Node 运行时未提供 node:sqlite，跳过 D1 SQL 等价验证");
    return;
  }
  const migrationDir = `${ROOT}/cloud/usage-sync-worker/migrations`;
  const migration = readdirSync(migrationDir)
    .filter((name) => name.endsWith(".sql"))
    .sort()
    .map((name) => readFileSync(`${migrationDir}/${name}`, "utf8"))
    .join("\n");
  const database = new DatabaseSync(":memory:");
  database.exec(migration);

  // 最小 D1 API 包装（prepare → bind → run/first/all），用于在本地 SQLite 上跑真实语句。
  const d1 = {
    prepare(query) {
      const statement = database.prepare(query);
      let bound = [];
      return {
        bind(...params) {
          bound = params;
          return this;
        },
        async run() {
          const result = statement.run(...bound);
          return { success: true, meta: { changes: Number(result.changes ?? 0) } };
        },
        async first() {
          return statement.get(...bound) ?? null;
        },
        async all() {
          return { results: statement.all(...bound) };
        },
      };
    },
  };
  const store = createD1Store(d1);

  try {
    await store.createSpace({ id: "spc_1", name: "team", createdAt: NOW });
    assert.equal(await store.issueInvite("spc_1", { inviteHash: "invite-hash-1", expiresAt: NOW + 1000 }), true);
    assert.equal((await store.findSpaceByInviteHash("invite-hash-1"))?.id, "spc_1");
    assert.equal(await store.consumeInvite("spc_1", "invite-hash-1", NOW + 10), true);
    assert.equal(await store.consumeInvite("spc_1", "invite-hash-1", NOW + 10), false, "邀请码必须单次消费");

    assert.equal(
      (await store.addMember({ id: "mem_owner", spaceId: "spc_1", deviceId: "dev-owner", displayName: "Owner", role: "owner", tokenHash: "th-owner", createdAt: NOW, deviceLimit: 32 })).ok,
      true,
    );
    assert.equal(
      (await store.addMember({ id: "mem_bob", spaceId: "spc_1", deviceId: "dev-bob", displayName: "Bob", role: "member", tokenHash: "th-bob", createdAt: NOW + 1, deviceLimit: 32 })).ok,
      true,
    );
    assert.equal(await store.countActiveDevices("spc_1"), 2);
    assert.equal((await store.getMemberByTokenHash("th-bob"))?.deviceId, "dev-bob");
    assert.equal(await store.revokeMember("spc_1", "dev-bob", NOW + 2), true);
    assert.equal((await store.getMember("spc_1", "dev-bob")).revokedAt, NOW + 2);
    const restored = await store.addMember({ id: "mem_bob2", spaceId: "spc_1", deviceId: "dev-bob", displayName: "Bob2", role: "member", tokenHash: "th-bob2", createdAt: NOW + 3, deviceLimit: 32 });
    assert.equal(restored.ok, true);
    assert.equal(restored.member.revokedAt, null);
    assert.equal(restored.member.tokenHash, "th-bob2");

    const payload = JSON.stringify({ _ts: NOW + 100 });
    assert.equal((await store.upsertSnapshot({ spaceId: "spc_1", deviceId: "dev-owner", payload, payloadHash: "hash-a", ts: NOW + 100, updatedAt: NOW + 100 })).status, "inserted");
    assert.equal((await store.upsertSnapshot({ spaceId: "spc_1", deviceId: "dev-owner", payload, payloadHash: "hash-a", ts: NOW + 100, updatedAt: NOW + 101 })).status, "deduped");
    const stale = await store.upsertSnapshot({ spaceId: "spc_1", deviceId: "dev-owner", payload: JSON.stringify({ _ts: NOW + 50 }), payloadHash: "hash-b", ts: NOW + 50, updatedAt: NOW + 102 });
    assert.equal(stale.status, "stale", "json_extract(_ts) 单调守卫应拒绝旧快照");
    assert.equal((await store.upsertSnapshot({ spaceId: "spc_1", deviceId: "dev-owner", payload: JSON.stringify({ _ts: NOW + 200 }), payloadHash: "hash-c", ts: NOW + 200, updatedAt: NOW + 103 })).status, "updated");
    const rows = await store.listSnapshots("spc_1");
    assert.equal(rows.length, 1);
    assert.equal(rows[0].ts, NOW + 200);
    assert.equal(rows[0].displayName, "Owner");

    for (let index = 3; index <= 32; index += 1) {
      const added = await store.addMember({
        id: `mem_${index}`,
        spaceId: "spc_1",
        deviceId: `dev-${index}`,
        displayName: `Device ${index}`,
        role: "member",
        tokenHash: `th-${index}`,
        createdAt: NOW + index,
        deviceLimit: 32,
      });
      assert.equal(added.ok, true, `add member ${index} failed`);
    }
    const overflow = await store.addMember({ id: "mem_33", spaceId: "spc_1", deviceId: "dev-33", displayName: "Device 33", role: "member", tokenHash: "th-33", createdAt: NOW + 33, deviceLimit: 32 });
    assert.equal(overflow.ok, false);
    assert.equal(overflow.reason, "device_limit");
    assert.equal(await store.countActiveDevices("spc_1"), 32);
  } finally {
    database.close();
  }
});

// ===========================================================================
// 十一、部署产物自检
// ===========================================================================

test("部署产物：迁移含三张表/哈希列/单调列；wrangler 示例含 D1 与限流绑定", () => {
  const migration = readFileSync(`${ROOT}/cloud/usage-sync-worker/migrations/0001_init.sql`, "utf8");
  for (const table of ["spaces", "members", "snapshots"]) {
    assert.ok(migration.includes(`CREATE TABLE IF NOT EXISTS ${table}`), `迁移缺少表：${table}`);
  }
  assert.match(migration, /token_hash\s+TEXT\s+NOT NULL UNIQUE/);
  assert.match(migration, /payload_hash\s+TEXT\s+NOT NULL/);
  assert.match(migration, /_ts\s+INTEGER\s+NOT NULL/);
  assert.ok(migration.includes("invite_hash"));
  assert.ok(migration.includes("revoked_at"));

  const wrangler = readFileSync(`${ROOT}/cloud/usage-sync-worker/wrangler.example.toml`, "utf8");
  assert.ok(wrangler.includes('binding = "DB"'));
  assert.ok(wrangler.includes("AUTH_RATE_LIMITER"));
  assert.ok(wrangler.includes("API_RATE_LIMITER"));
  assert.ok(wrangler.includes("ALLOWED_ORIGIN"));
});
