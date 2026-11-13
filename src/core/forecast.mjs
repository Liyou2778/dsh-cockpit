/**
 * 压缩预测（Forecast）—— 对应参考产品的「重置预测」，改造点见 PRD 16.4。
 *
 * 结构移植自 `src-tauri/src/reset_forecast.rs:166-271`：
 *   基础概率（压力 sigmoid）→ 历史经验校准（±12 上限）→ 周内先验微调 → clamp[2, 95]。
 * DSH 的 `compaction` 事件是真实"重置"点，因此校准用的是本地压缩历史而非第三方数据。
 *
 * ⚠️ 启发式，非官方预测（PRD R5）。
 */
import { clamp, finiteOr, round } from "./math.mjs";

export const FORECAST_POLICY_VERSION = "FORECAST_V1";
export const FORECAST_WINDOW_HOURS = 24;
/** 周一..周日 的周内压缩先验（移植参考产品的星期风险形状，语义改为压缩倾向）。 */
export const WEEKDAY_HAZARD = Object.freeze([0.1, 0.7, 0.1, 0.1, 0.1, 0.7, 0.1]);
const DAY_MS = 86_400_000;

function sigmoid(value) {
  return 1 / (1 + Math.exp(-value));
}

/**
 * @param {{
 *   pressure?: number,
 *   contextWindow?: number|null,
 *   compactions?: Array<{ts:number|null, tokens:number}>,
 *   growthPerHour?: number,
 *   nowMs?: number,
 * }} input
 */
export function forecastCompaction(input = {}) {
  const nowMs = finiteOr(input.nowMs, Date.now());
  const pressure = Math.max(0, finiteOr(input.pressure, 0));
  const contextWindow = Math.max(0, finiteOr(input.contextWindow, 0));
  const ratio = contextWindow > 0 ? clamp(pressure / contextWindow, 0, 1) : 0;
  const factors = [`上下文压力 ${Math.round(ratio * 100)}%`];

  const base = sigmoid((ratio - 0.6) / 0.12) * 100;
  let score = base;

  const compactions = Array.isArray(input.compactions) ? input.compactions : [];
  const recent = compactions.filter((item) => typeof item?.ts === "number" && nowMs - item.ts <= 7 * DAY_MS);
  if (recent.length > 0) {
    const empirical = clamp(recent.length * 18, 0, 95);
    const delta = clamp((empirical - score) * 0.25, -12, 12);
    score += delta;
    factors.push(`近 7 天压缩 ${recent.length} 次`);
  }

  const weekday = new Date(nowMs + 8 * 3_600_000).getUTCDay();
  const hazard = WEEKDAY_HAZARD[(weekday + 6) % 7] ?? 0.1;
  if (hazard >= 0.7) {
    score += 4;
    factors.push("周内先验偏高");
  }

  score = clamp(round(score, 1), 2, 95);

  let etaHours = null;
  const growth = finiteOr(input.growthPerHour, 0);
  if (growth > 0 && contextWindow > 0) {
    const remainingToThreshold = 0.92 * contextWindow - pressure;
    etaHours = remainingToThreshold > 0 ? round(remainingToThreshold / growth, 1) : 0;
  }

  return {
    score,
    windowHours: FORECAST_WINDOW_HOURS,
    etaHours,
    source: recent.length > 0 ? "history" : "pressure",
    factors,
    policyVersion: FORECAST_POLICY_VERSION,
  };
}

/**
 * 由既有 usage 压力序列估算增长速率（tokens/小时），用于 ETA。
 * @param {Array<{ts:number, pressure:number}>} samples 按时间升序
 */
export function pressureGrowthPerHour(samples) {
  if (!Array.isArray(samples) || samples.length < 2) return 0;
  const first = samples[0];
  const last = samples[samples.length - 1];
  const hours = (last.ts - first.ts) / 3_600_000;
  if (!(hours > 0)) return 0;
  return Math.max(0, (last.pressure - first.pressure) / hours);
}
