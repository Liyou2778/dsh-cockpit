/**
 * 风险热力图（配速 × 压缩风险）——对应参考产品 ResetRiskQuotaHeatmap。
 * 网格单元的值 = 在该「已用% + 风险%」情景下，今日建议用量（planCalibratedRiskQuota）。
 */
import { planCalibratedRiskQuota } from "./plan.mjs";
import { round } from "./math.mjs";

const X_STEP = 10;
const Y_STEP = 20;

/**
 * @param {{usedPercent:number, riskPercent:number, knee:number, isWeekend:boolean, daysLeftInCycle:number}} input
 */
export function buildRiskMap(input) {
  const knee = Number.isFinite(input.knee) ? input.knee : 25;
  const daysLeft = Number.isFinite(input.daysLeftInCycle) ? input.daysLeftInCycle : 1;
  const cells = [];
  for (let x = 0; x <= 100; x += X_STEP) {
    for (let y = 0; y <= 100; y += Y_STEP) {
      const plan = planCalibratedRiskQuota({
        remainingPercent: 100 - x,
        riskPercent: y,
        fatigueKneePercent: knee,
        isWeekend: input.isWeekend === true,
        daysLeftInCycle: daysLeft,
      });
      cells.push({ x, y, suggestedPercent: plan.suggestedUsagePercent });
    }
  }
  return {
    current: {
      pacePercent: round(Math.min(100, Math.max(0, input.usedPercent ?? 0)), 1),
      riskPercent: round(Math.min(100, Math.max(0, input.riskPercent ?? 0)), 1),
    },
    x: { min: 0, max: 100, step: X_STEP, label: "已用（%）" },
    y: { min: 0, max: 100, step: Y_STEP, label: "压缩风险（%）" },
    cells,
  };
}
