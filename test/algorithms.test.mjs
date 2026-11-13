import { test } from "node:test";
import assert from "node:assert/strict";
import { estimateCost, DEFAULT_PRICING, resolvePrice, isPeak, normalizeModel } from "../src/core/pricing.mjs";
import { beijingDateKey, cycleDateKey, cycleBounds } from "../src/core/time.mjs";
import { calculatePace } from "../src/core/pace.mjs";
import { planCalibratedRiskQuota, isWeekend, daysLeft } from "../src/core/plan.mjs";
import { forecastCompaction } from "../src/core/forecast.mjs";
import { efficiencyCurve, fitComfortK, suggestTargetPercent } from "../src/core/comfort.mjs";

const close = (actual, expected, tolerance = 0.15) => {
  assert.ok(Math.abs(actual - expected) <= tolerance, `expected ${expected} ±${tolerance}, got ${actual}`);
};

// ---------------------------------------------------------------------------
// 定价（PRD 16.4 成本公式）
// ---------------------------------------------------------------------------

test("成本 = 非缓存输入×输入价 + 缓存命中×命中价 + 输出×输出价（高峰价）", () => {
  const result = estimateCost(
    { inputTokens: 1000, cacheReadTokens: 500, cacheWriteTokens: 0, outputTokens: 100 },
    "deepseek-flash",
  );
  assert.equal(result.known, true);
  assert.equal(result.peak, true);
  close(result.costCny, (1000 * 2 + 500 * 0.04 + 100 * 8) / 1_000_000, 1e-9);
});

test("空闲时段价格 ×0.5（周末/工作日非高峰）", () => {
  const usage = { inputTokens: 1_000_000, cacheReadTokens: 0, outputTokens: 0 };
  const peak = estimateCost(usage, "deepseek-flash", { tsMs: Date.parse("2026-11-03T10:00:00+08:00") });
  const idle = estimateCost(usage, "deepseek-flash", { tsMs: Date.parse("2026-11-03T20:00:00+08:00") });
  const weekend = estimateCost(usage, "deepseek-flash", { tsMs: Date.parse("2026-11-07T10:00:00+08:00") });
  assert.equal(peak.peak, true);
  assert.equal(idle.peak, false);
  assert.equal(weekend.peak, false);
  close(idle.costCny, peak.costCny * 0.5, 1e-9);
  close(weekend.costCny, peak.costCny * 0.5, 1e-9);
});

test("高峰窗口边界：09:00 含、12:00 不含、14:00 含、18:00 不含", () => {
  const policy = {};
  assert.equal(isPeak(Date.parse("2026-11-03T09:00:00+08:00"), policy), true);
  assert.equal(isPeak(Date.parse("2026-11-03T11:59:00+08:00"), policy), true);
  assert.equal(isPeak(Date.parse("2026-11-03T12:00:00+08:00"), policy), false);
  assert.equal(isPeak(Date.parse("2026-11-03T14:00:00+08:00"), policy), true);
  assert.equal(isPeak(Date.parse("2026-11-03T18:00:00+08:00"), policy), false);
  assert.equal(isPeak(Date.parse("2026-11-07T10:00:00+08:00"), policy), false); // 周六
});

test("可配置法定节假日：整天按空闲计价", () => {
  const policy = { holidays: ["2026-11-03"] };
  const holiday = estimateCost(
    { inputTokens: 1_000_000, outputTokens: 0 },
    "deepseek-flash",
    { policy, tsMs: Date.parse("2026-11-03T10:00:00+08:00") },
  );
  assert.equal(holiday.peak, false);
  close(holiday.costCny, 1, 1e-9); // 输入 2 元/M × 0.5
});

test("未知模型不猜价格：保留 token，成本为 null（缺失≠0）", () => {
  const result = estimateCost({ inputTokens: 100, outputTokens: 10 }, "some-unknown-model");
  assert.equal(result.known, false);
  assert.equal(result.costCny, null);
});

test("必要桶缺失 → 成本未知；可由 totalTokens 反推输入", () => {
  assert.equal(estimateCost({ inputTokens: 100 }, "deepseek-flash").costCny, null);
  const derived = estimateCost({ totalTokens: 1600, cacheReadTokens: 500, outputTokens: 100 }, "deepseek-flash");
  assert.equal(derived.costCny !== null, true);
  assert.equal(derived.billable.input, 1000);
});

test("openai/ 前缀、旧模型名与大小写归一", () => {
  assert.equal(resolvePrice("openai/DeepSeek-Flash").priceKey, "deepseek-flash");
  assert.equal(resolvePrice("deepseek-flash").known, true);
  assert.equal(normalizeModel("deepseek-v4-flash"), "deepseek-flash");
  assert.equal(normalizeModel("deepseek-v4-flash-vision-exp"), "deepseek-flash");
  assert.equal(DEFAULT_PRICING["deepseek-flash"].cacheHit, 0.04);
  assert.equal(DEFAULT_PRICING["deepseek-v4-pro"].output, 27);
});

// ---------------------------------------------------------------------------
// 时间 / 日界（PRD 8.3 DAY_V1）
// ---------------------------------------------------------------------------

test("04:00 换日：03:59 归前一天，04:01 归当天", () => {
  const before = Date.parse("2026-11-02T03:59:00+08:00");
  const after = Date.parse("2026-11-02T04:01:00+08:00");
  assert.equal(cycleDateKey(before, 4), "2026-11-01");
  assert.equal(cycleDateKey(after, 4), "2026-11-02");
  assert.equal(beijingDateKey(before), "2026-11-02");
});

test("周期边界：日 / 周（周一起）/ 月", () => {
  const daily = cycleBounds(Date.parse("2026-11-02T10:00:00+08:00"), { mode: "daily", dayStartHour: 4 });
  assert.equal(new Date(daily.startMs).toISOString(), "2026-11-01T20:00:00.000Z");
  assert.equal(daily.windowSeconds, 86_400);

  const weekly = cycleBounds(Date.parse("2026-11-04T10:00:00+08:00"), { mode: "weekly", dayStartHour: 4 });
  assert.equal(new Date(weekly.startMs).toISOString(), "2026-11-01T20:00:00.000Z");
  assert.equal(weekly.windowSeconds, 7 * 86_400);

  const monthly = cycleBounds(Date.parse("2026-11-15T10:00:00+08:00"), { mode: "monthly", dayStartHour: 4 });
  assert.equal(new Date(monthly.startMs).toISOString(), "2026-10-31T20:00:00.000Z");
});

test("周中/周末判定与剩余天数", () => {
  assert.equal(isWeekend(Date.parse("2026-11-07T12:00:00+08:00")), true); // 周六
  assert.equal(isWeekend(Date.parse("2026-11-04T12:00:00+08:00")), false); // 周三
  assert.equal(daysLeft(Date.parse("2026-11-03T04:00:00+08:00"), Date.parse("2026-11-02T16:00:00+08:00")), 1);
});

// ---------------------------------------------------------------------------
// 配速（移植 quotaPace.ts:172-176）
// ---------------------------------------------------------------------------

test("周期过半、已用 61.7% → 建议 50%、超速 11.7%", () => {
  const start = Date.parse("2026-11-02T04:00:00+08:00");
  const pace = calculatePace({
    windowSeconds: 86_400,
    remainingPercent: 38.3,
    resetsAtMs: start + 86_400_000,
    nowMs: start + 43_200_000,
    cycleStartedAtMs: start,
  });
  close(pace.recommendedUsedPercent, 50, 0.01);
  close(pace.usedPercent, 61.7, 0.01);
  close(pace.overByPercent, 11.7, 0.01);
  assert.equal(pace.status, "over_pace");
  assert.equal(pace.unit, "hour");
  close(pace.averageRate, 38.3 / 12, 0.02); // 单位 hour：剩余 12h → 每小时可用 3.19%
});

test("超出重置时间 → unknown（不误报超速）", () => {
  const start = Date.parse("2026-11-02T04:00:00+08:00");
  const resets = start + 86_400_000;
  const pace = calculatePace({
    windowSeconds: 86_400,
    remainingPercent: 10,
    resetsAtMs: resets,
    nowMs: resets + 3 * 60_000,
    cycleStartedAtMs: start,
  });
  assert.equal(pace.status, "unknown");
});

// ---------------------------------------------------------------------------
// 计划（移植 dynamicQuota.ts:149-165）
// ---------------------------------------------------------------------------

test("planCalibratedRiskQuota：uniform + p² 加成 + 疲劳上限取最小", () => {
  const plan = planCalibratedRiskQuota({
    remainingPercent: 38.3,
    riskPercent: 34,
    fatigueKneePercent: 25,
    isWeekend: false,
    daysLeftInCycle: 1,
  });
  const uniform = 38.3 / 2;
  const boost = (38.3 - uniform) * 0.34 ** 2;
  const softCap = 25 * (1 + 1.5 * 0.34);
  close(plan.uniformPacePercent, uniform);
  close(plan.resetRiskBoostPercent, boost);
  close(plan.softCapPercent, softCap);
  close(plan.suggestedUsagePercent, Math.min(38.3, uniform + boost, softCap));
  assert.ok(plan.suggestedUsagePercent <= plan.uniformPacePercent + plan.resetRiskBoostPercent + 1e-9);
});

test("风险为 0 时无加成；建议值永不超过剩余", () => {
  const plan = planCalibratedRiskQuota({ remainingPercent: 80, riskPercent: 0, daysLeftInCycle: 3 });
  assert.equal(plan.resetRiskBoostPercent, 0);
  assert.ok(plan.suggestedUsagePercent <= 80);
});

test("周末软上限 ×0.75", () => {
  const weekday = planCalibratedRiskQuota({ remainingPercent: 80, riskPercent: 10, fatigueKneePercent: 40, isWeekend: false, daysLeftInCycle: 0 });
  const weekend = planCalibratedRiskQuota({ remainingPercent: 80, riskPercent: 10, fatigueKneePercent: 40, isWeekend: true, daysLeftInCycle: 0 });
  close(weekend.softCapPercent, weekday.softCapPercent * 0.75);
});

// ---------------------------------------------------------------------------
// 压缩预测（移植 reset_forecast.rs:166-271 的结构）
// ---------------------------------------------------------------------------

test("压力 41% → 低风险；85% → 高风险；恒在 [2,95]", () => {
  const now = Date.parse("2026-11-04T12:00:00+08:00"); // 周三，避开周内先验
  const low = forecastCompaction({ pressure: 410_000, contextWindow: 1_000_000, nowMs: now });
  assert.ok(low.score >= 2 && low.score < 30, `low=${low.score}`);
  const high = forecastCompaction({ pressure: 850_000, contextWindow: 1_000_000, nowMs: now });
  assert.ok(high.score > 60 && high.score <= 95, `high=${high.score}`);
});

test("ETA 由压力增长速率推导；无速率时为 null", () => {
  const now = Date.parse("2026-11-04T12:00:00+08:00");
  const withGrowth = forecastCompaction({ pressure: 410_000, contextWindow: 1_000_000, growthPerHour: 5000, nowMs: now });
  assert.ok(withGrowth.etaHours > 0);
  const noGrowth = forecastCompaction({ pressure: 410_000, contextWindow: 1_000_000, nowMs: now });
  assert.equal(noGrowth.etaHours, null);
});

test("有压缩历史时 source=history 并给出因素", () => {
  const now = Date.parse("2026-11-04T12:00:00+08:00");
  const result = forecastCompaction({
    pressure: 500_000,
    contextWindow: 1_000_000,
    nowMs: now,
    compactions: [
      { ts: now - 3_600_000, tokens: 1000 },
      { ts: now - 7_200_000, tokens: 2000 },
    ],
  });
  assert.equal(result.source, "history");
  assert.ok(result.factors.length >= 2);
});

// ---------------------------------------------------------------------------
// 舒适度（移植 COMFORT_FIT_V1）
// ---------------------------------------------------------------------------

test("效率曲线单调不增，且膝点前为 1", () => {
  assert.equal(efficiencyCurve(10, 40), 1);
  const a = efficiencyCurve(60, 40);
  const b = efficiencyCurve(80, 40);
  assert.ok(a > b, `${a} > ${b}`);
});

test("合成样本可恢复膝点 k（±15）", () => {
  const now = Date.parse("2026-11-02T12:00:00+08:00");
  const truthK = 40;
  const samples = [];
  for (let index = 0; index < 10; index += 1) {
    const usedPercent = 10 + index * 9;
    const eta = efficiencyCurve(usedPercent, truthK);
    const level = Math.max(1, Math.min(5, Math.round(1 + 4 * eta)));
    samples.push({ date: `2026-10-${String(20 + index).padStart(2, "0")}`, usedPercent, level, ts: now - (10 - index) * 86_400_000 });
  }
  const fit = fitComfortK(samples, { nowMs: now, minSamples: 5 });
  assert.equal(fit.fitted, true);
  assert.ok(Math.abs(fit.k - truthK) <= 15, `k=${fit.k}`);
});

test("样本不足时不拟合", () => {
  const fit = fitComfortK([{ date: "2026-11-01", usedPercent: 50, level: 3 }], { minSamples: 5 });
  assert.equal(fit.fitted, false);
  assert.equal(fit.k, null);
});

test("今日目标随风险上升、周末下降", () => {
  const base = suggestTargetPercent({ k: 30, riskPercent: 0, isWeekend: false });
  const risky = suggestTargetPercent({ k: 30, riskPercent: 50, isWeekend: false });
  assert.ok(risky > base);
});
