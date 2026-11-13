/**
 * 团队报表（v2 契约，对齐 Codex Cockpit）：
 * - 组员 ↔ 多设备：owner 发布的 `shared_settings.groups` 把设备归并到"人"；
 * - 版本化共享配置：`space.settingsRevision` + 每设备的 `configRevision` 对比，标出配置落后；
 * - 每日共享计划：`/v1/daily-plan` 的 basis + 每人份额 + 风险（独立修订），本地计算建议值；
 * - 本机实时数据（source=live）与远端快照（source=snapshot）合并。
 *
 * 隐私：只消费聚合字段（tokens/成本/日级/成员名），不触碰会话 id/标题/路径。
 */
import { createSyncClientFromConfig, isSyncEnabled } from "./client.mjs";
import { composeDayPlan, beijingDateKey } from "./dayplan.mjs";

function round(value, digits = 4) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

/** 用量账本 04:00 换日（与核心层一致，保持 sync 层解耦）。 */
function todayKey(ms) {
  const shifted = ms + (8 - 4) * 3_600_000;
  return new Date(shifted).toISOString().slice(0, 10);
}

function normalizePlan(plan) {
  const source = plan !== null && typeof plan === "object" && !Array.isArray(plan) ? plan : {};
  const cap = typeof source.dailyTokenCap === "number" && Number.isFinite(source.dailyTokenCap) && source.dailyTokenCap > 0
    ? Math.round(source.dailyTokenCap)
    : null;
  const percent = typeof source.dayTotalPercent === "number" && Number.isFinite(source.dayTotalPercent)
    ? Math.min(100, Math.max(10, Math.round(source.dayTotalPercent)))
    : 100;
  const note = typeof source.note === "string" ? source.note.slice(0, 200) : "";
  return { dailyTokenCap: cap, dayTotalPercent: percent, note };
}

/**
 * 生成团队报表。
 * @param {{config: object, env?: object, fetchImpl?: Function, nowMs?: number, localStatus?: object|null, client?: object|null}} input
 */
export async function buildTeamReport({ config, env = process.env, fetchImpl, nowMs = Date.now(), localStatus = null, client = null } = {}) {
  if (!isSyncEnabled(config)) {
    return {
      enabled: false,
      reason: "SYNC_DISABLED",
      hint: "开启：node src/cli.mjs config --set sync.enabled=true（并完成 invite enroll）",
      members: [],
      people: [],
      plan: null,
      dayPlan: null,
      totals: null,
    };
  }

  let syncClient = client;
  let data;
  try {
    if (!syncClient) syncClient = createSyncClientFromConfig(config, { env, fetchImpl, timeoutMs: 8_000 });
    data = await syncClient.members();
    const revision = Number(data?.space?.settingsRevision);
    if (Number.isSafeInteger(revision) && typeof syncClient.heartbeat === "function") {
      // 上报本设备采用的配置版本（失败不影响报表）
      void syncClient.heartbeat({ configRevision: revision }).catch(() => undefined);
    }
  } catch (error) {
    return {
      enabled: true,
      offline: true,
      error: { code: error?.code ?? "SYNC_ERROR", message: error?.message ?? String(error) },
      space: { name: config.sync?.spaceLabel ?? "", plan: null },
      members: [],
      people: [],
      plan: null,
      dayPlan: null,
      totals: null,
    };
  }

  const plan = normalizePlan(data.space?.plan);
  const settings = data.space?.settings ?? { schemaVersion: 2, groups: [], plan: null };
  const groups = Array.isArray(settings.groups) ? settings.groups : [];
  const settingsRevision = Number.isSafeInteger(data.space?.settingsRevision) ? data.space.settingsRevision : 0;
  const today = todayKey(nowMs);
  const selfDevice = config.sync?.deviceId ?? data.self ?? null;
  const taskByDevice = data.taskStats?.byDevice && typeof data.taskStats.byDevice === "object" ? data.taskStats.byDevice : {};
  const comfortByPerson = new Map((data.comfort ?? []).map((row) => [row.personId, row]));
  const taskRowsByDevice = new Map();
  for (const row of data.tasks?.rows ?? []) {
    if (!taskRowsByDevice.has(row.deviceId)) taskRowsByDevice.set(row.deviceId, []);
    taskRowsByDevice.get(row.deviceId).push(row);
  }
  const shareTasks = config.sync?.shareTasks !== false;
  const shareComfort = config.sync?.shareComfort !== false;

  /* ---------- 1. 设备级汇总（本机实时 + 远端快照） ---------- */
  const rows = data.members.map((member) => {
    const snapshot = member.snapshot ?? null;
    const lastDay = snapshot?.lastDay ?? null;
    const isSelf = member.isSelf === true || member.deviceId === selfDevice;
    const live = isSelf && localStatus
      ? {
          tokens: Number(localStatus.totals?.todayTokens) || 0,
          costCny: Number(localStatus.totals?.todayCostCny) || 0,
          capturedAt: localStatus.generatedAt ?? null,
        }
      : null;
    const dayTokens = live ? live.tokens : lastDay?.date === today ? Number(lastDay.tokens) || 0 : null;
    const dayCost = live ? live.costCny : lastDay?.date === today ? Number(lastDay.costCny) || 0 : null;
    const configRevision = member.syncInfo?.configRevision;
    const todayTasks = Number.isSafeInteger(member.todayTasks) ? member.todayTasks : null;
    return {
      deviceId: member.deviceId,
      displayName: member.displayName || `设备-${String(member.deviceId).slice(0, 4)}`,
      role: member.role ?? "member",
      isSelf,
      revoked: Boolean(member.revokedAt),
      lastSeenAt: member.lastSeenAt ?? null,
      heartbeatAt: member.heartbeatAt ?? null,
      lastDay,
      today: dayTokens === null ? null : { tokens: dayTokens, costCny: dayCost },
      todayTasks: shareTasks ? todayTasks : null,
      source: live ? "live" : "snapshot",
      configRevision: Number.isSafeInteger(configRevision) ? configRevision : null,
      configStale: member.configStale === true,
      planPercent: plan.dailyTokenCap && dayTokens !== null ? round((dayTokens / plan.dailyTokenCap) * 100, 2) : null,
    };
  });

  const deviceMap = new Map(rows.map((row) => [row.deviceId, row]));
  const activeRows = rows.filter((row) => !row.revoked);
  const spaceTodayTokens = activeRows.reduce((sum, row) => sum + (row.today?.tokens ?? 0), 0);

  /* ---------- 2. 组员（人）级汇总 ---------- */
  const assigned = new Set();
  const people = groups.map((group) => {
    const devices = (group.deviceIds ?? []).map((deviceId) => deviceMap.get(deviceId)).filter(Boolean);
    for (const deviceId of group.deviceIds ?? []) assigned.add(deviceId);
    const active = devices.filter((row) => !row.revoked);
    const knownTokens = active.filter((row) => row.today !== null).map((row) => row.today.tokens);
    const knownCosts = active.filter((row) => row.today !== null).map((row) => row.today.costCny ?? 0);
    const personCostCny = knownCosts.length > 0 ? round(knownCosts.reduce((sum, value) => sum + value, 0), 4) : null;
    const missingDeviceIds = active.filter((row) => row.today === null).map((row) => row.deviceId);
    const self = active.some((row) => row.isSelf);
    const tokens = knownTokens.length > 0 ? knownTokens.reduce((sum, value) => sum + value, 0) : null;
    const costCny = personCostCny;
    const taskValues = active.filter((row) => row.todayTasks !== null).map((row) => row.todayTasks);
    const todayTasks = taskValues.length > 0 ? taskValues.reduce((sum, value) => sum + value, 0) : null;
    const personTaskRows = active.flatMap((row) => taskRowsByDevice.get(row.deviceId) ?? []).sort((a, b) => (b.tokens ?? 0) - (a.tokens ?? 0)).slice(0, 5);
    const comfort = shareComfort ? comfortByPerson.get(group.id) ?? null : null;
    return {
      personId: group.id,
      name: group.name,
      self,
      devices,
      deviceCount: devices.length,
      activeDeviceCount: active.length,
      today: tokens === null ? null : { tokens, costCny },
      todayTasks: shareTasks ? (personTaskRows.length > 0 ? personTaskRows.length : todayTasks) : null,
      tasks: shareTasks ? personTaskRows : [],
      comfort,
      consumedPercent: plan.dailyTokenCap && tokens !== null ? round((tokens / plan.dailyTokenCap) * 100, 2) : null,
      personCostCny,
      missingDeviceIds,
      costShare: null,
      allocatedPercent: null,
      coverage: "partial",
      planValue: null,
      planRevision: null,
      planTokens: null,
      planUtilizationPercent: null,
      overPlan: false,
    };
  });
  const unassignedDevices = rows.filter((row) => !assigned.has(row.deviceId));

  /* ---------- 3. 每日共享计划 ---------- */
  const riskPercent = Number(localStatus?.forecast?.score);
  const personIds = people.map((person) => person.personId);
  const dayPlan = composeDayPlan({
    plan: data.dailyPlan ?? null,
    personIds,
    riskPercent: Number.isFinite(riskPercent) ? riskPercent : 0,
    nowMs,
    spaceTodayTokens,
    dailyTokenCap: plan.dailyTokenCap,
  });
  if (dayPlan.available) {
    for (const person of people) {
      const entry = dayPlan.people.find((item) => item.personId === person.personId);
      if (!entry) continue;
      person.planValue = entry.value;
      person.planRevision = entry.revision;
      person.planTokens = plan.dailyTokenCap ? Math.round((entry.value / 100) * plan.dailyTokenCap) : null;
      person.planUtilizationPercent = entry.value > 0 && person.consumedPercent !== null
        ? round((person.consumedPercent / entry.value) * 100, 1)
        : null;
      person.overPlan = person.consumedPercent !== null && person.consumedPercent > entry.value + 0.05;
    }
  }

  const totalCost = activeRows.reduce((sum, row) => sum + (row.today?.costCny ?? 0), 0);
  const sharedUsedPercent = plan.dailyTokenCap && plan.dailyTokenCap > 0
    ? round((spaceTodayTokens / plan.dailyTokenCap) * 100, 2)
    : null;
  const knownCostDevices = activeRows.filter((row) => row.today !== null);
  const totalKnownCost = knownCostDevices.reduce((sum, row) => sum + (row.today.costCny ?? 0), 0);
  const costCoverage = knownCostDevices.length === activeRows.length ? "complete" : "partial";

  // 个人成本分摊（对齐 Codex 的 cost-share 思路）：personCost / totalCost，再乘共享已用百分比
  for (const person of people) {
    person.costShare = person.personCostCny !== null && totalKnownCost > 0
      ? round(person.personCostCny / totalKnownCost, 4)
      : null;
    person.allocatedPercent = sharedUsedPercent !== null && person.costShare !== null
      ? round(sharedUsedPercent * person.costShare, 2)
      : null;
    person.coverage = person.costShare === null || person.missingDeviceIds.length > 0 || costCoverage !== "complete"
      ? "partial"
      : "complete";
  }

  return {
    enabled: true,
    offline: false,
    space: { name: data.space?.name ?? config.sync?.spaceLabel ?? "", plan, settingsRevision },
    self: selfDevice,
    members: rows.map((row) => ({ ...row, tasks: shareTasks ? (taskRowsByDevice.get(row.deviceId) ?? []) : [] })),
    people,
    unassignedDevices,
    plan,
    dayPlan,
    sharedChannels: { tasks: shareTasks, comfort: shareComfort },
    totals: {
      members: activeRows.length,
      devices: rows.length,
      personCount: people.length,
      todayTokens: spaceTodayTokens,
      todayCostCny: round(totalCost, 4),
      planUsedPercent: plan.dailyTokenCap && plan.dailyTokenCap > 0 ? round((spaceTodayTokens / plan.dailyTokenCap) * 100, 2) : null,
      dayTotalPercent: plan.dayTotalPercent,
      recommendation: dayPlan.available ? dayPlan.recommendation : null,
      totalAllocated: dayPlan.available ? dayPlan.totalAllocated : null,
      overRecommended: dayPlan.available ? dayPlan.overRecommended : null,
      sharedUsedPercent,
      totalKnownCostCny: round(totalKnownCost, 4),
      costCoverage,
      todayTasks: shareTasks
        ? activeRows.filter((row) => row.todayTasks !== null).reduce((sum, row) => sum + row.todayTasks, 0)
        : null,
    },
    capturedAt: new Date(nowMs).toISOString(),
  };
}
