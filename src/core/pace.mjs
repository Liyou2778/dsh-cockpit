/**
 * 配速（Pace）—— 移植 Codex Cockpit `src/lib/quotaPace.ts:126-212`。
 * 公式：recommended = cycleStartUsed + cycleStartRemaining × elapsed / (reset − start)
 * 容差：调度 0.5%、时钟 2 分钟（与参考产品一致）。
 */
import { clamp, finiteOr, round } from "./math.mjs";

export const PACE_POLICY_VERSION = "PACE_V1";
export const SCHEDULE_TOLERANCE_PERCENT = 0.5;
export const CLOCK_TOLERANCE_MS = 2 * 60_000;
const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
const BEIJING_OFFSET_MS = 8 * HOUR_MS;

function endOfBeijingDay(ms) {
  const wall = new Date(ms + BEIJING_OFFSET_MS);
  return Date.UTC(wall.getUTCFullYear(), wall.getUTCMonth(), wall.getUTCDate() + 1) - BEIJING_OFFSET_MS;
}

/**
 * @param {{
 *   windowSeconds: number,
 *   remainingPercent: number,
 *   resetsAtMs: number|null,
 *   nowMs?: number,
 *   cycleStartedAtMs?: number|null,
 *   cycleStartRemainingPercent?: number,
 * }} input
 */
export function calculatePace(input) {
  const windowSeconds = Math.max(1, finiteOr(input.windowSeconds, 86_400));
  const durationMs = windowSeconds * 1000;
  const unit = durationMs <= DAY_MS ? "hour" : "day";
  const unitMs = unit === "hour" ? HOUR_MS : DAY_MS;
  const nowMs = finiteOr(input.nowMs, Date.now());
  const remainingPercent = clamp(finiteOr(input.remainingPercent, 0), 0, 100);
  const usedPercent = 100 - remainingPercent;
  const baselineRate = 100 / (durationMs / unitMs);

  const unknown = {
    status: usedPercent <= SCHEDULE_TOLERANCE_PERCENT ? "on_track" : "unknown",
    usedPercent: round(usedPercent),
    recommendedUsedPercent: null,
    todayUsedPercent: round(usedPercent),
    todayRemainingPercent: null,
    overByPercent: 0,
    averageRate: round(baselineRate, 2),
    unit,
  };

  const resetsAtMs = input.resetsAtMs;
  if (!Number.isFinite(resetsAtMs)) return unknown;

  const startsAt = Number.isFinite(input.cycleStartedAtMs)
    ? input.cycleStartedAtMs
    : resetsAtMs - durationMs;
  if (nowMs < startsAt - CLOCK_TOLERANCE_MS || nowMs > resetsAtMs + CLOCK_TOLERANCE_MS) return unknown;

  const cycleStartRemaining = clamp(finiteOr(input.cycleStartRemainingPercent, 100), 0, 100);
  const cycleStartUsed = 100 - cycleStartRemaining;
  const elapsedRatio = (nowMs - startsAt) / Math.max(1, resetsAtMs - startsAt);
  const recommendedUsedPercent = clamp(cycleStartUsed + cycleStartRemaining * elapsedRatio, 0, 100);

  const baselineRemainingMs = Math.max(0, resetsAtMs - nowMs);
  const planningHorizon = Math.min(resetsAtMs, endOfBeijingDay(nowMs));
  const horizonMs = Math.max(0, planningHorizon - nowMs);
  const dailyBudget = baselineRemainingMs > 0 ? clamp(remainingPercent * (horizonMs / baselineRemainingMs), 0, remainingPercent) : 0;
  const averageRate = baselineRemainingMs > 0 ? remainingPercent / (baselineRemainingMs / unitMs) : 0;

  const overByPercent = Math.max(0, usedPercent - recommendedUsedPercent);
  return {
    status: overByPercent <= SCHEDULE_TOLERANCE_PERCENT ? "on_track" : "over_pace",
    usedPercent: round(usedPercent),
    recommendedUsedPercent: round(recommendedUsedPercent),
    todayUsedPercent: round(usedPercent),
    todayRemainingPercent: round(dailyBudget),
    overByPercent: round(overByPercent),
    averageRate: round(averageRate, 2),
    unit,
  };
}
