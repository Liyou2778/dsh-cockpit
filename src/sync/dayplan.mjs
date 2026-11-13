/**
 * 每日共享计划（对齐 Codex Cockpit 的 shared daily plan）。
 *
 * 公式（与 Codex Cockpit 一致）：
 *   U = min(R, R / D * f)
 *   shared = min(R, U + (R - U) * p² * f)
 * 其中 R=剩余百分比，D=距重置天数，f=当日剩余比例，p=重置风险概率。
 *
 * 与 Codex 的差异：DSH 没有"官方额度百分比"，R 用「共享日预算（dailyTokenCap）− 今日已用」推导；
 * 计划日边界用北京时间 00:00（用量账本仍是 04:00 换日，与 Codex 的约定一致）。
 */

const DAY_MS = 86_400_000;
const BEIJING_OFFSET_MS = 8 * 3_600_000;

export const DAY_PLAN_POLICY_VERSION = "SHARED_DAY_PLAN_V1";
export const MIN_PERSON_PERCENT = 0;
export const MAX_PERSON_PERCENT = 100;

export function beijingDateKey(ms) {
  return new Date(ms + BEIJING_OFFSET_MS).toISOString().slice(0, 10);
}

export function nextBeijingMidnight(ms) {
  const shifted = ms + BEIJING_OFFSET_MS;
  const dayStart = Math.floor(shifted / DAY_MS) * DAY_MS;
  return dayStart + DAY_MS - BEIJING_OFFSET_MS;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

/** 共享建议（一位小数）。 */
export function sharedRecommendation(basis, riskPercent) {
  const anchor = Date.parse(basis?.anchorAt);
  const reset = Date.parse(basis?.resetsAt);
  const dayEnd = Date.parse(`${basis?.localDate}T00:00:00+08:00`) + DAY_MS;
  if (![anchor, reset, dayEnd].every(Number.isFinite)) return 0;
  const days = (reset - anchor) / DAY_MS;
  if (!Number.isFinite(days) || days <= 0) return 0;
  const remaining = clamp(Number(basis.remainingPercent) || 0, 0, 100);
  const fraction = clamp((dayEnd - anchor) / DAY_MS, 0, 1);
  const uniform = Math.min(remaining, (remaining / days) * fraction);
  const risk = clamp(Number(riskPercent) || 0, 0, 100) / 100;
  return Math.round(Math.min(remaining, uniform + (remaining - uniform) * risk ** 2 * fraction) * 10) / 10;
}

/** 默认分配：建议值 ÷ 人数；手动覆盖只替换自己的份额，不重新分配他人。 */
export function allocateSharedPlan(total, personIds, overrides = {}) {
  const ids = [...new Set((personIds ?? []).filter((id) => typeof id === "string" && id.length > 0))];
  const share = ids.length > 0 ? total / ids.length : 0;
  const allocations = {};
  for (const id of ids) {
    const override = overrides?.[id];
    allocations[id] = override && Number.isFinite(override.value) ? clamp(override.value, 0, 100) : Math.round(share * 10) / 10;
  }
  const totalAllocated = Object.values(allocations).reduce((sum, value) => sum + value, 0);
  return { allocations, totalAllocated: Math.round(totalAllocated * 10) / 10 };
}

/**
 * 由共享日预算推导当日基线。
 * @returns {{localDate:string, anchorAt:string, remainingPercent:number, resetsAt:string}|null}
 */
export function buildBasisFromSharedCap({ nowMs = Date.now(), spaceTodayTokens = 0, dailyTokenCap = null } = {}) {
  if (!Number.isFinite(dailyTokenCap) || dailyTokenCap <= 0) return null;
  const used = Math.max(0, Number(spaceTodayTokens) || 0);
  const remainingPercent = Math.round(clamp(100 - (used / dailyTokenCap) * 100, 0, 100) * 10) / 10;
  return {
    localDate: beijingDateKey(nowMs),
    anchorAt: new Date(nowMs).toISOString(),
    remainingPercent,
    resetsAt: new Date(nextBeijingMidnight(nowMs)).toISOString(),
  };
}

/**
 * 组装当日计划视图（读取已有计划或给出默认建议）。
 * @param {{plan?: {revision:number, value:object}|null, personIds?: string[], riskPercent?: number,
 *          nowMs?: number, spaceTodayTokens?: number, dailyTokenCap?: number|null}} input
 */
export function composeDayPlan({ plan = null, personIds = [], riskPercent = 0, nowMs = Date.now(), spaceTodayTokens = 0, dailyTokenCap = null } = {}) {
  const existing = plan?.value ?? null;
  const storedBasis = existing?.basis ?? null;
  const today = beijingDateKey(nowMs);
  const basis = storedBasis && storedBasis.localDate === today ? storedBasis : buildBasisFromSharedCap({ nowMs, spaceTodayTokens, dailyTokenCap });
  if (!basis) {
    return {
      available: false,
      policyVersion: DAY_PLAN_POLICY_VERSION,
      reason: "NO_SHARED_DAILY_CAP",
      hint: "先设置共享计划：node src/cli.mjs sync plan --daily-token-cap <tokens>",
    };
  }
  const risk = existing?.risk?.value ?? (Number.isFinite(riskPercent) ? clamp(riskPercent, 0, 100) : null);
  const recommendation = sharedRecommendation(basis, risk ?? 0);
  const { allocations, totalAllocated } = allocateSharedPlan(recommendation, personIds, existing?.people ?? {});
  const people = personIds.map((id) => ({
    personId: id,
    value: allocations[id],
    revision: existing?.people?.[id]?.revision ?? 0,
    manual: Boolean(existing?.people?.[id] && existing.people[id].value !== null),
  }));
  return {
    available: true,
    policyVersion: DAY_PLAN_POLICY_VERSION,
    revision: plan?.revision ?? 0,
    basis,
    risk: { value: risk, revision: existing?.risk?.revision ?? 0 },
    recommendation,
    people,
    totalAllocated,
    overRecommended: totalAllocated > recommendation + 0.05,
    note: "共享计划是建议性的（DSH 无法在请求层限流）；手动修改只替换自己的份额",
  };
}

/** 构造 person 变更（用于 POST /v1/daily-plan）。 */
export function personPlanChange({ personId, value, plan = null }) {
  return {
    kind: "person",
    personId,
    value: value === null ? null : clamp(Number(value), 0, 100),
    expectedRevision: plan?.value?.people?.[personId]?.revision ?? 0,
  };
}

/** 构造 risk 变更。 */
export function riskPlanChange({ value, plan = null }) {
  return {
    kind: "risk",
    value: value === null ? null : clamp(Number(value), 0, 100),
    expectedRevision: plan?.value?.risk?.revision ?? 0,
  };
}
