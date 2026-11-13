/**
 * v2 契约测试（对齐 Codex Cockpit）：
 * - 版本化共享配置：GET/PUT /v1/shared-settings + revision CAS；
 * - 心跳：设备上报 configRevision，成员列表标记 configStale；
 * - 每日共享计划：basis seed、person/risk 独立修订、CAS 409、权限；
 * - 客户端算法：sharedRecommendation / allocateSharedPlan / composeDayPlan；
 * - 团队报表：组员↔多设备归并 + 未归属设备 + 当日计划。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildSnapshot, createSyncClient } from "../src/sync/client.mjs";
import { createMemoryStore, handleRequest } from "../cloud/usage-sync-worker/src/index.js";
import { buildTeamReport } from "../src/sync/team.mjs";
import {
  allocateSharedPlan,
  beijingDateKey,
  composeDayPlan,
  nextBeijingMidnight,
  sharedRecommendation,
} from "../src/sync/dayplan.mjs";

const NOW = Date.parse("2026-11-04T14:00:00+08:00");
const ORIGIN = "https://cockpit.example.test";
const ENDPOINT = "https://sync.example.test";
const BOOTSTRAP_SECRET = "team-v2-bootstrap-secret-0123456789";

function allowLimiter() {
  return { limit: async () => ({ success: true }) };
}
function makeEnv() {
  return {
    NOW: NOW,
    DB: createMemoryStore(),
    BOOTSTRAP_SECRET,
    ALLOWED_ORIGIN: ORIGIN,
    AUTH_RATE_LIMITER: allowLimiter(),
    API_RATE_LIMITER: allowLimiter(),
  };
}
function raw(env, method, path, { body, token, origin = ORIGIN, headers: extraHeaders = {} } = {}) {
  const headers = { ...extraHeaders };
  if (body !== undefined) headers["content-type"] = "application/json";
  if (token) headers.authorization = `Bearer ${token}`;
  if (origin) headers.origin = origin;
  return handleRequest(
    new Request(`${ENDPOINT}${path}`, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }),
    env,
  );
}
function clientFor(env, token) {
  return createSyncClient({
    endpoint: ENDPOINT,
    token,
    retries: 0,
    timeoutMs: 3_000,
    fetchImpl: async (url, init) => handleRequest(new Request(url, init), env),
  });
}
async function bootstrap(env) {
  const response = await raw(env, "POST", "/v1/spaces", {
    headers: { "x-bootstrap-secret": env.BOOTSTRAP_SECRET },
    body: { displayName: "Owner", deviceId: "device-owner-01", spaceName: "team" },
  });
  const payload = await response.json();
  assert.equal(response.status, 201, JSON.stringify(payload));
  return payload;
}
async function inviteAndEnroll(env, ownerToken, deviceId, displayName) {
  const inviteResponse = await raw(env, "POST", "/v1/spaces", { token: ownerToken, body: {} });
  const invite = await inviteResponse.json();
  const member = clientFor(env, null);
  await member.enroll({ inviteCode: invite.inviteCode, deviceId, displayName });
  return member;
}
function validBasis() {
  return {
    localDate: beijingDateKey(NOW),
    anchorAt: new Date(NOW).toISOString(),
    remainingPercent: 80,
    resetsAt: new Date(nextBeijingMidnight(NOW)).toISOString(),
  };
}

test("共享配置：owner 发布 + revision CAS + 成员只读", async () => {
  const env = makeEnv();
  const owner = await bootstrap(env);
  const ownerClient = clientFor(env, owner.token);
  const memberClient = await inviteAndEnroll(env, owner.token, "device-b-01", "Bob");

  const initial = await ownerClient.getSharedSettings();
  assert.equal(initial.revision, 0);
  assert.deepEqual(initial.settings.groups, []);

  const settings = {
    schemaVersion: 2,
    groups: [{ id: "grp_lee", name: "李工", deviceIds: ["device-owner-01"] }],
    plan: { dailyTokenCap: 10_000_000, dayTotalPercent: 90, note: "" },
    pricing: { "deepseek-flash": { input: 2, cacheHit: 0.04, cacheWrite: 2, output: 8 } },
    costPolicy: "shared-pricing-v1",
  };
  const saved = await ownerClient.saveSharedSettings({ revision: 0, settings });
  assert.equal(saved.revision, 1);

  const fetched = await memberClient.getSharedSettings();
  assert.equal(fetched.revision, 1);
  assert.equal(fetched.settings.groups[0].name, "李工");
  assert.equal(fetched.settings.pricing["deepseek-flash"].output, 8);
  assert.equal(fetched.settings.costPolicy, "shared-pricing-v1");

  await assert.rejects(
    () => ownerClient.saveSharedSettings({ revision: 0, settings }),
    (error) => error.code === "SETTINGS_CONFLICT",
  );
  await assert.rejects(
    () => memberClient.saveSharedSettings({ revision: 1, settings }),
    (error) => error.code === "OWNER_REQUIRED",
  );
  // 非法：同一设备分给两个组员
  await assert.rejects(
    () => ownerClient.saveSharedSettings({
      revision: 1,
      settings: { ...settings, groups: [{ id: "grp_a", name: "A", deviceIds: ["device-owner-01"] }, { id: "grp_b", name: "B", deviceIds: ["device-owner-01"] }] },
    }),
    (error) => error.code === "SETTINGS_INVALID",
  );
});

test("心跳：成员列表标记配置落后", async () => {
  const env = makeEnv();
  const owner = await bootstrap(env);
  const ownerClient = clientFor(env, owner.token);
  const memberClient = await inviteAndEnroll(env, owner.token, "device-b-01", "Bob");
  await ownerClient.saveSharedSettings({
    revision: 0,
    settings: { schemaVersion: 2, groups: [], plan: { dailyTokenCap: 1_000_000, dayTotalPercent: 90, note: "" } },
  });

  await ownerClient.heartbeat({ configRevision: 1 });
  let report = await ownerClient.members();
  const self = report.members.find((row) => row.deviceId === "device-owner-01");
  assert.equal(self.configStale, false);
  const bob = report.members.find((row) => row.deviceId === "device-b-01");
  assert.equal(bob.configStale, null);

  await memberClient.heartbeat({ configRevision: 0 });
  report = await ownerClient.members();
  assert.equal(report.members.find((row) => row.deviceId === "device-b-01").configStale, true);
});

test("每日共享计划：seed / person 修订 / 409 冲突 / 权限", async () => {
  const env = makeEnv();
  const owner = await bootstrap(env);
  const ownerClient = clientFor(env, owner.token);
  const memberClient = await inviteAndEnroll(env, owner.token, "device-b-01", "Bob");
  await ownerClient.saveSharedSettings({
    revision: 0,
    settings: {
      schemaVersion: 2,
      groups: [
        { id: "grp_lee", name: "李工", deviceIds: ["device-owner-01"] },
        { id: "grp_bob", name: "Bob", deviceIds: ["device-b-01"] },
      ],
      plan: { dailyTokenCap: 10_000_000, dayTotalPercent: 90, note: "" },
    },
  });

  const basis = validBasis();
  const seeded = await ownerClient.dailyPlan({ basis, initialRisk: 30 });
  assert.equal(seeded.revision, 0);
  assert.equal(seeded.plan.risk.value, 30);

  // owner（李工）改自己的份额
  const changed = await ownerClient.dailyPlan({
    basis,
    change: { kind: "person", personId: "grp_lee", value: 12, expectedRevision: 0 },
  });
  assert.equal(changed.revision, 1);
  assert.equal(changed.plan.people.grp_lee.value, 12);

  // 旧修订再提交 → 409
  await assert.rejects(
    () => ownerClient.dailyPlan({ basis, change: { kind: "person", personId: "grp_lee", value: 15, expectedRevision: 0 } }),
    (error) => error.code === "PLAN_CONFLICT",
  );

  // 成员不能改别人的份额
  await assert.rejects(
    () => memberClient.dailyPlan({ basis, change: { kind: "person", personId: "grp_lee", value: 1, expectedRevision: 1 } }),
    (error) => error.code === "PLAN_PERSON_DENIED",
  );

  // 成员可以改自己的份额 + 共享风险
  const bobChange = await memberClient.dailyPlan({
    basis,
    change: { kind: "person", personId: "grp_bob", value: 11, expectedRevision: 0 },
  });
  assert.equal(bobChange.plan.people.grp_bob.value, 11);
  const riskChange = await memberClient.dailyPlan({
    basis,
    change: { kind: "risk", value: 55, expectedRevision: 0 },
  });
  assert.equal(riskChange.plan.risk.value, 55);
});

test("客户端算法：推荐公式 / 分配不重分配他人 / 全局计划视图", () => {
  // basis: 06:00 锚点，剩余 40%，48h 后重置，当日剩余 75%
  const anchor = Date.parse("2026-11-04T06:00:00+08:00");
  const basis = {
    localDate: "2026-11-04",
    anchorAt: new Date(anchor).toISOString(),
    remainingPercent: 40,
    resetsAt: new Date(anchor + 48 * 3_600_000).toISOString(),
  };
  // uniform = min(40, 40/2*0.75)=15；p=0.5 → 15 + 25*0.25*0.75 = 19.6875 → 19.7
  assert.equal(sharedRecommendation(basis, 50), 19.7);

  const allocation = allocateSharedPlan(20, ["a", "b"], { b: { value: 12 } });
  assert.deepEqual(allocation.allocations, { a: 10, b: 12 });
  assert.equal(allocation.totalAllocated, 22);

  const view = composeDayPlan({
    plan: null,
    personIds: ["a", "b"],
    riskPercent: 0,
    nowMs: NOW,
    spaceTodayTokens: 2_000_000,
    dailyTokenCap: 10_000_000,
  });
  assert.equal(view.available, true);
  assert.equal(view.basis.remainingPercent, 80);
  assert.equal(view.people[0].value + view.people[1].value, view.recommendation);
});

test("任务统计与舒适度：只同步聚合/等级，按组员归属", async () => {
  const env = makeEnv();
  const owner = await bootstrap(env);
  const ownerClient = clientFor(env, owner.token);
  const memberClient = await inviteAndEnroll(env, owner.token, "device-b-01", "Bob");
  await ownerClient.saveSharedSettings({
    revision: 0,
    settings: {
      schemaVersion: 2,
      groups: [{ id: "grp_bob", name: "Bob", deviceIds: ["device-b-01"] }],
      plan: { dailyTokenCap: 10_000_000, dayTotalPercent: 90, note: "" },
    },
  });

  const day = beijingDateKey(NOW);
  await memberClient.taskStats({ days: [{ date: day, tasks: 7 }] });
  const taskReport = await ownerClient.members();
  assert.equal(taskReport.taskStats.byDevice["device-b-01"], 7);
  assert.equal(taskReport.taskStats.byDevice["device-owner-01"] ?? null, null);

  await memberClient.comfort({ level: 4, note: "长会话有点累" });
  const report = await ownerClient.members();
  const bob = report.comfort.find((row) => row.personId === "grp_bob");
  assert.equal(bob.level, 4);
  assert.equal(bob.note, "长会话有点累");

  // 非法输入
  await assert.rejects(() => memberClient.taskStats({ days: [{ date: "2026-13-01", tasks: 1 }] }), (error) => error.code === "TASK_STATS_INVALID");
  await assert.rejects(() => memberClient.comfort({ level: 9 }), (error) => ["COMFORT_INVALID", "SYNC_INVALID_SETTINGS"].includes(error.code));
});

test("团队报表：组员↔多设备归并 + 未归属设备 + 当日计划", async () => {
  const config = { sync: { enabled: true, deviceId: "dev-a", spaceLabel: "team" } };
  const members = [
    { deviceId: "dev-a", displayName: "A", role: "owner", isSelf: true, lastSeenAt: new Date(NOW).toISOString(), snapshot: null },
    { deviceId: "dev-b", displayName: "B", role: "member", isSelf: false, lastSeenAt: new Date(NOW).toISOString(), snapshot: { lastDay: { date: "2026-11-04", tokens: 3_000_000, costCny: 0.6 } } },
    { deviceId: "dev-c", displayName: "C", role: "member", isSelf: false, lastSeenAt: null, snapshot: { lastDay: { date: "2026-11-04", tokens: 1_000_000, costCny: 0.2 } } },
  ];
  const data = {
    space: {
      name: "team",
      plan: { dailyTokenCap: 10_000_000, dayTotalPercent: 90, note: "" },
      settingsRevision: 3,
      settings: {
        schemaVersion: 2,
        groups: [{ id: "grp_lee", name: "李工", deviceIds: ["dev-a", "dev-b"] }],
        plan: { dailyTokenCap: 10_000_000, dayTotalPercent: 90, note: "" },
      },
    },
    self: "dev-a",
    dailyPlan: null,
    tasks: { day: "2026-11-04", rows: [{ deviceId: "dev-b", day: "2026-11-04", taskKey: "task-1", title: "任务-abc", tokens: 3000000, costCny: 0.6, lastAt: NOW - 1000 }] },
    members,
  };
  const report = await buildTeamReport({
    config,
    nowMs: NOW,
    localStatus: { generatedAt: new Date(NOW).toISOString(), totals: { todayTokens: 2_000_000, todayCostCny: 0.4 }, forecast: { score: 0 } },
    client: { members: async () => data, heartbeat: async () => ({ ok: true }) },
  });
  assert.equal(report.space.settingsRevision, 3);
  assert.equal(report.people.length, 1);
  const lee = report.people[0];
  assert.equal(lee.name, "李工");
  assert.equal(lee.deviceCount, 2);
  assert.equal(lee.today.tokens, 5_000_000);
  assert.equal(lee.self, true);
  assert.equal(lee.tasks.length, 1);
  assert.equal(lee.tasks[0].title, "任务-abc");
  assert.equal(report.members.find((row) => row.deviceId === "dev-b").tasks.length, 1);
  assert.equal(report.unassignedDevices.length, 1);
  assert.equal(report.unassignedDevices[0].deviceId, "dev-c");
  assert.equal(report.dayPlan.available, true);
  assert.equal(report.dayPlan.people.length, 1);
  assert.equal(report.dayPlan.basis.remainingPercent, 40);
  // 个人成本分摊（cost-share）：李工 1.0 / 全部已知 1.2；共享已用 60% → 分摊 50%
  assert.equal(lee.personCostCny, 1);
  assert.equal(lee.costShare, 0.8333);
  assert.equal(lee.allocatedPercent, 50);
  assert.equal(lee.coverage, "complete");
  assert.equal(report.totals.sharedUsedPercent, 60);
  assert.equal(report.totals.totalKnownCostCny, 1.2);
  assert.equal(report.totals.costCoverage, "complete");
});

test("任务摘要同步：Worker 端点 + 归属合并", async () => {
  const env = makeEnv();
  const owner = await bootstrap(env);
  const ownerClient = clientFor(env, owner.token);
  const memberClient = await inviteAndEnroll(env, owner.token, "device-b-01", "Bob");
  await ownerClient.saveSharedSettings({
    revision: 0,
    settings: { schemaVersion: 2, groups: [{ id: "grp_bob", name: "Bob", deviceIds: ["device-b-01"] }], plan: { dailyTokenCap: 1_000_000, dayTotalPercent: 90, note: "" } },
  });
  const day = beijingDateKey(NOW);
  const pushed = await memberClient.taskSummaries({
    day,
    tasks: [
      { key: "task-1", title: "任务-abc", tokens: 500, costCny: 0.1, lastAt: NOW - 1000 },
      { key: "task-2", title: "任务-def", tokens: 800, costCny: 0.2, lastAt: NOW - 2000 },
    ],
  });
  assert.equal(pushed.tasks, 2);
  const report = await ownerClient.members();
  assert.equal(report.tasks.day, day);
  assert.equal(report.tasks.rows.length, 2);
  assert.equal(report.tasks.rows[0].deviceId, "device-b-01");
  assert.ok(report.tasks.rows.every((row) => row.title.startsWith("任务-")));
  await assert.rejects(
    () => memberClient.taskSummaries({ day: "2026-13-01", tasks: [] }),
    (error) => error.code === "INVALID_BODY" || error.code === "TASKS_INVALID" || error.code === "SYNC_INVALID_SNAPSHOT",
  );
});
