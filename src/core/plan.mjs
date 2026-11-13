/**
 * 今日计划（Plan）—— 移植 Codex Cockpit `src/lib/dynamicQuota.ts:149-165`
 * （planCalibratedRiskQuota）：
 *   uniform = remaining / (daysLeft + 1)
 *   boost   = max(0, remaining − uniform) × p²        ← 风险平方前移未来额度
 *   softCap = knee × (1 + 1.5p) × (周末 ? 0.75 : 1)  ← 疲劳上限
 *   suggested = min(remaining, uniform + boost, softCap)
 */
import { clamp, finiteOr, round } from "./math.mjs";

export const PLAN_POLICY_VERSION = "PLAN_V1";
export const DEFAULT_FATIGUE_KNEE_PERCENT = 25;
export const DEFAULT_DAILY_FLOOR = 0.1;

/**
 * @param {{
 *   remainingPercent: number,
 *   riskPercent?: number,
 *   fatigueKneePercent?: number,
 *   isWeekend?: boolean,
 *   daysLeftInCycle?: number,
 * }} input
 */
export function planCalibratedRiskQuota(input) {
  const remaining = clamp(finiteOr(input.remainingPercent, 0), 0, 100);
  const riskPercent = clamp(finiteOr(input.riskPercent, 10), 0, 100);
  const risk = riskPercent / 100;
  const fatigueKnee = clamp(finiteOr(input.fatigueKneePercent, DEFAULT_FATIGUE_KNEE_PERCENT), 0.1, 100);
  const daysLeft = Math.max(0, Math.trunc(clamp(finiteOr(input.daysLeftInCycle, 1), 0, 31)));

  const uniformPace = remaining / (daysLeft + 1);
  const resetRiskBoost = Math.max(0, remaining - uniformPace) * risk ** 2;
  const softCap = fatigueKnee * (1 + 1.5 * risk) * (input.isWeekend ? 0.75 : 1);
  const suggestedUsage = Math.min(remaining, uniformPace + resetRiskBoost, softCap);

  return {
    suggestedUsagePercent: round(suggestedUsage),
    suggestedRemainingPercent: round(remaining - suggestedUsage),
    uniformPacePercent: round(uniformPace),
    resetRiskBoostPercent: round(resetRiskBoost),
    softCapPercent: round(Math.min(remaining, softCap)),
    riskPercent: round(riskPercent),
    policyVersion: PLAN_POLICY_VERSION,
  };
}

/** 距离周期结束的天数（向上取整，至少 0）。 */
export function daysLeft(resetsAtMs, nowMs) {
  if (!Number.isFinite(resetsAtMs) || !Number.isFinite(nowMs)) return 0;
  return Math.max(0, Math.ceil((resetsAtMs - nowMs) / 86_400_000));
}

/** 是否周末（Asia/Shanghai）。 */
export function isWeekend(nowMs) {
  const weekday = new Date(nowMs + 8 * 3_600_000).getUTCDay(); // 0=周日
  return weekday === 0 || weekday === 6;
}
