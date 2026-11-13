/**
 * 舒适度（Comfort）—— 移植 Codex Cockpit `comfortFeedback.ts` 的
 * 「固定 k 拟合」思路与 `dynamicQuota.ts:200-230` 的膝点效率曲线：
 *
 *   η(x; k) = exp(−sharpness × ((x − k) / (1 − k))^power)   (x > k，否则 1)
 *   目标 y = (level − 1) / 4                                   (1..5 档)
 *   加权最小二乘，权重 = 0.5^(ageDays / halfLife)
 *
 * 产出的 k 作为「疲劳膝点」回灌 plan.mjs 的 fatigueKneePercent（PRD FR-6）。
 */
import { clamp, round } from "./math.mjs";

export const COMFORT_FIT_VERSION = "COMFORT_FIT_V1";
export const COMFORT_HALF_LIFE_DAYS = 14;
export const SHARPNESS = 4.3;
export const POWER = 1.5;

export const COMFORT_LEVELS = Object.freeze([
  { level: 1, label: "很轻松", emoji: "😌" },
  { level: 2, label: "轻松", emoji: "🙂" },
  { level: 3, label: "刚好", emoji: "😐" },
  { level: 4, label: "有点撑", emoji: "😣" },
  { level: 5, label: "很撑", emoji: "😵" },
]);

export function comfortLevelLabel(level) {
  return COMFORT_LEVELS.find((item) => item.level === level)?.label ?? null;
}

export function comfortLevelToTarget(level) {
  return clamp((clamp(level, 1, 5) - 1) / 4, 0, 1);
}

/**
 * 利用率 → 效率（0..1）。
 * @param {number} usedPercent 0..100
 * @param {number} kPercent 膝点 0..100
 */
export function efficiencyCurve(usedPercent, kPercent, options = {}) {
  const x = clamp(usedPercent, 0, 100) / 100;
  const knee = clamp(kPercent, 0.1, 99.5) / 100;
  if (x <= knee) return 1;
  const t = (x - knee) / Math.max(1e-6, 1 - knee);
  const sharpness = options.sharpness ?? SHARPNESS;
  const power = options.power ?? POWER;
  return clamp(Math.exp(-sharpness * t ** power), 0, 1);
}

/**
 * 拟合 k（网格搜索，加权最小二乘）。
 * @param {Array<{date?: string, usedPercent: number, level: number, ts?: number}>} samples
 * @param {{halfLifeDays?: number, nowMs?: number, minSamples?: number}} [options]
 */
export function fitComfortK(samples, options = {}) {
  const list = (Array.isArray(samples) ? samples : []).filter(
    (item) => Number.isFinite(item?.usedPercent) && Number.isFinite(item?.level),
  );
  const minSamples = options.minSamples ?? 5;
  const fitted = list.length >= minSamples;
  if (!fitted) {
    return { fitted: false, k: null, sampleSize: list.length, residual: null, curve: [] };
  }

  const nowMs = options.nowMs ?? Date.now();
  const halfLife = options.halfLifeDays ?? COMFORT_HALF_LIFE_DAYS;
  const weighted = list.map((item) => {
    const ts = Number.isFinite(item.ts) ? item.ts : Date.parse(`${item.date}T12:00:00+08:00`);
    const ageDays = Number.isFinite(ts) ? Math.max(0, (nowMs - ts) / 86_400_000) : halfLife;
    return {
      x: clamp(item.usedPercent, 0, 100),
      y: comfortLevelToTarget(item.level),
      weight: 0.5 ** (ageDays / halfLife),
    };
  });

  let bestK = 25;
  let bestResidual = Number.POSITIVE_INFINITY;
  for (let k = 5; k <= 95; k += 1) {
    let residual = 0;
    let weightSum = 0;
    for (const point of weighted) {
      const predicted = efficiencyCurve(point.x, k);
      residual += point.weight * (predicted - point.y) ** 2;
      weightSum += point.weight;
    }
    const normalized = weightSum > 0 ? residual / weightSum : Number.POSITIVE_INFINITY;
    if (normalized < bestResidual) {
      bestResidual = normalized;
      bestK = k;
    }
  }

  const curve = [];
  for (let x = 0; x <= 100; x += 5) curve.push({ x, y: round(efficiencyCurve(x, bestK), 3) });

  return {
    fitted: true,
    k: bestK,
    sampleSize: list.length,
    residual: round(bestResidual, 4),
    curve,
    points: weighted.map((point) => ({ x: round(point.x, 1), y: round(point.y, 3) })),
    policyVersion: COMFORT_FIT_VERSION,
  };
}

/** 基于舒适膝点给出今日目标（与 plan.mjs 的 softCap 同构）。 */
export function suggestTargetPercent({ k = 25, riskPercent = 10, isWeekend = false } = {}) {
  const risk = clamp(riskPercent, 0, 100) / 100;
  const knee = clamp(k, 0.1, 100);
  return round(clamp(knee * (1 + 1.5 * risk) * (isWeekend ? 0.75 : 1), 0, 100));
}

/**
 * 舒适度分箱（对应参考产品 tokenComfort 的分箱模型）：
 * 把「已用%」切成 bins 段，统计每段的平均体感与效率。
 * @param {Array<{usedPercent:number, level:number}>} samples
 * @param {{bins?: number}} [options]
 */
export function binComfort(samples, options = {}) {
  const bins = Math.max(2, Math.min(20, Math.round(options.bins ?? 5)));
  const width = 100 / bins;
  const rows = Array.from({ length: bins }, (_, index) => {
    const start = index * width;
    const end = index === bins - 1 ? 100 : start + width;
    return { bin: `${Math.round(start)}-${Math.round(end)}`, start, end, count: 0, levelSum: 0, avgLevel: null, efficiency: null };
  });

  for (const sample of Array.isArray(samples) ? samples : []) {
    if (!Number.isFinite(sample?.usedPercent) || !Number.isFinite(sample?.level)) continue;
    const index = Math.min(bins - 1, Math.max(0, Math.floor(sample.usedPercent / width)));
    rows[index].count += 1;
    rows[index].levelSum += clamp(sample.level, 1, 5);
  }

  return rows.map((row) => {
    if (row.count === 0) return { bin: row.bin, count: 0, avgLevel: null, efficiency: null };
    const avgLevel = row.levelSum / row.count;
    return {
      bin: row.bin,
      count: row.count,
      avgLevel: round(avgLevel, 2),
      // 效率：体感 1（很轻松）→1.0，体感 5（很撑）→0.0
      efficiency: round(1 - (avgLevel - 1) / 4, 3),
    };
  });
}

/**
 * 舒适度历史日历：把记录与当日用量/状态对齐。
 * @param {Array<{date:string, level:number}>} entries
 * @param {Array<{date:string, tokens:number, costCny:number, status:string}>} history
 */
export function comfortCalendar(entries, history) {
  const byDate = new Map((history ?? []).map((row) => [row.date, row]));
  return (entries ?? []).map((entry) => {
    const day = byDate.get(entry.date);
    return {
      date: entry.date,
      level: entry.level,
      tokens: day?.tokens ?? 0,
      costCny: day?.costCny ?? 0,
      status: day?.status ?? "unknown",
    };
  });
}

