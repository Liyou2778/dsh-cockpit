/**
 * 成本估算 v2（PRICING_V2）—— 对齐官方价格页（2026-11-03 核对）。
 *
 * 官方规则：
 * - 单位：人民币 / 百万 tokens；
 * - 每个模型有「高峰价」；空闲时段 = 高峰价 × 0.5；
 * - 高峰时段：北京时间周一至周五（不含中国法定节假日）09:00–12:00、14:00–18:00；
 *   其余（含周末、节假日全天）为空闲；
 * - 输入分「缓存命中 / 缓存未命中」；输出单独计价；缓存未命中输入即我们 usage 里的 inputTokens。
 * - Search / Fetch 按成功请求次数单独计费（官方 5 元/1000 次），本地会话事件不含该信息 → 不计入（文档声明）。
 *
 * 语义要点（缺失 ≠ 0）：未知模型不猜价，金额为 null；缺必要桶 → null。
 */
export const PRICING_VERSION = "PRICING_V2";
export const PRICING_REFERENCE_DATE = "2026-11-03";
export const PRICING_CURRENCY = "CNY";
export const DEFAULT_IDLE_RATIO = 0.5;
export const DEFAULT_PEAK_WINDOWS = Object.freeze([
  Object.freeze([9, 12]),
  Object.freeze([14, 18]),
]);
export const DEFAULT_PEAK_WEEKDAYS = Object.freeze([1, 2, 3, 4, 5]); // 周一..周五

/** 高峰价（¥ / 百万 tokens）。cacheWrite 官方未单列，按未命中输入计。 */
export const DEFAULT_PRICING = Object.freeze({
  "deepseek-flash": Object.freeze({ input: 2, cacheHit: 0.04, cacheWrite: 2, output: 8 }),
  "deepseek-v4-pro": Object.freeze({ input: 9, cacheHit: 0.3, cacheWrite: 9, output: 27 }),
});

/** 官方声明的旧模型名 → 现行模型（按现行价格计费）。 */
export const MODEL_ALIASES = Object.freeze({
  "deepseek-v4-flash": "deepseek-flash",
  "deepseek-v4-flash-vision-exp": "deepseek-flash",
  // 本仓库旧配置名 → 现名（保证历史价格覆盖可迁移）
  "deepseek-pro": "deepseek-v4-pro",
});

export const FALLBACK_PRICE = DEFAULT_PRICING["deepseek-v4-pro"];

export function normalizeModel(model) {
  if (typeof model !== "string") return "";
  const base = model.trim().toLowerCase().replace(/^openai\//, "");
  return MODEL_ALIASES[base] ?? base;
}

/**
 * 把任意来源的价格条目归一化为 {input, cacheHit, cacheWrite, output}。
 * 兼容旧字段名 cacheRead（= 缓存命中）。
 */
export function normalizePriceEntry(raw) {
  if (!raw || typeof raw !== "object") return null;
  const num = (value) => (typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined);
  const input = num(raw.input);
  const cacheHit = num(raw.cacheHit) ?? num(raw.cacheRead);
  const output = num(raw.output);
  if (input === undefined || cacheHit === undefined || output === undefined) return null;
  return { input, cacheHit, cacheWrite: num(raw.cacheWrite) ?? input, output };
}

/**
 * 判断某一时刻是否为高峰时段（北京时间）。
 * @param {number} tsMs
 * @param {{timeZone?:string, peakWindows?:Array<[number,number]>, peakWeekdays?:number[], holidays?:string[]}} [policy]
 */
export function isPeak(tsMs, policy = {}) {
  if (!Number.isFinite(tsMs)) return true; // 无时间信息时按高峰保守估算
  const holidays = Array.isArray(policy.holidays) ? policy.holidays : [];
  const windows = Array.isArray(policy.peakWindows) && policy.peakWindows.length > 0 ? policy.peakWindows : DEFAULT_PEAK_WINDOWS;
  const weekdays = Array.isArray(policy.peakWeekdays) && policy.peakWeekdays.length > 0 ? policy.peakWeekdays : DEFAULT_PEAK_WEEKDAYS;
  // 中国无夏令时：固定 UTC+8 即可安全换算
  const wall = new Date(tsMs + 8 * 3_600_000);
  const dateKey = wall.toISOString().slice(0, 10);
  if (holidays.includes(dateKey)) return false;
  const weekday = wall.getUTCDay(); // 0=周日
  if (!weekdays.includes(weekday === 0 ? 7 : weekday)) return false;
  const minutes = wall.getUTCHours() * 60 + wall.getUTCMinutes();
  return windows.some(([start, end]) => minutes >= start * 60 && minutes < end * 60);
}

/**
 * 解析模型价格（高峰价）。
 * @param {string} model
 * @param {Record<string, object>} [overrides]
 */
export function resolvePrice(model, overrides = {}) {
  const key = normalizeModel(model);
  const overrideEntry = key ? normalizePriceEntry(overrides?.[key] ?? overrides?.[model]) : null;
  if (overrideEntry) return { priceKey: key, price: overrideEntry, known: true, source: "override" };
  const defaultEntry = key ? normalizePriceEntry(DEFAULT_PRICING[key]) : null;
  if (defaultEntry) return { priceKey: key, price: defaultEntry, known: true, source: "builtin" };
  return { priceKey: key || "unknown", price: FALLBACK_PRICE, known: false, source: "unknown" };
}

function num(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

/**
 * 估算单次 usage 成本。
 * @param {{inputTokens?:number,totalTokens?:number,cacheReadTokens?:number,cacheWriteTokens?:number,outputTokens?:number,reasoningTokens?:number}} usage
 * @param {string} model
 * @param {{overrides?: Record<string, object>, policy?: object, tsMs?: number|null}|Record<string, object>} [optionsOrOverrides]
 * @returns {{costCny:number|null, known:boolean, partial:boolean, priceKey:string, peak:boolean, multiplier:number, billable:object|null}}
 */
export function estimateCost(usage, model, optionsOrOverrides = {}) {
  // 兼容旧签名：第三参直接是「价格覆盖表」
  const looksLikeOverrides =
    optionsOrOverrides &&
    typeof optionsOrOverrides === "object" &&
    !("overrides" in optionsOrOverrides) &&
    !("policy" in optionsOrOverrides) &&
    !("tsMs" in optionsOrOverrides);
  const options = looksLikeOverrides ? { overrides: optionsOrOverrides } : optionsOrOverrides;
  const overrides = options.overrides ?? {};
  const policy = options.policy ?? {};
  const tsMs = Number.isFinite(options.tsMs) ? options.tsMs : null;
  const peak = isPeak(tsMs, policy);
  const idleRatio = typeof policy.idleRatio === "number" && policy.idleRatio > 0 ? policy.idleRatio : DEFAULT_IDLE_RATIO;
  const multiplier = peak ? 1 : idleRatio;

  const { price, priceKey, known, source } = resolvePrice(model, overrides);
  if (!usage || typeof usage !== "object" || !known) {
    return { costCny: null, known, partial: true, priceKey, peak, multiplier, source, billable: null };
  }

  const output = num(usage.outputTokens);
  const cacheHit = num(usage.cacheReadTokens) ?? 0;
  const cacheWrite = num(usage.cacheWriteTokens) ?? 0;
  let input = num(usage.inputTokens);

  if (input === undefined) {
    const total = num(usage.totalTokens);
    if (total !== undefined && output !== undefined) {
      const derived = total - cacheHit - cacheWrite - output;
      if (derived >= 0) input = derived;
    }
  }
  if (input === undefined || output === undefined) {
    return { costCny: null, known, partial: true, priceKey, peak, multiplier, source, billable: null };
  }

  const partial = num(usage.cacheReadTokens) === undefined || num(usage.cacheWriteTokens) === undefined;
  const rawCost =
    (input * price.input + cacheHit * price.cacheHit + cacheWrite * price.cacheWrite + output * price.output) / 1_000_000;
  const costCny = rawCost * multiplier;

  return {
    costCny: Math.round(costCny * 1_000_000) / 1_000_000,
    known: true,
    partial,
    priceKey,
    peak,
    multiplier,
    source,
    billable: { input, cacheHit, cacheWrite, output },
  };
}

/** 供 UI/诊断：当前时刻的计价状态。 */
export function pricingNow(tsMs, policy = {}) {
  const peak = isPeak(tsMs, policy);
  const idleRatio = typeof policy.idleRatio === "number" && policy.idleRatio > 0 ? policy.idleRatio : DEFAULT_IDLE_RATIO;
  return {
    peak,
    multiplier: peak ? 1 : idleRatio,
    label: peak ? "高峰价" : "空闲价（×0.5）",
    version: PRICING_VERSION,
    referenceDate: PRICING_REFERENCE_DATE,
  };
}

// ---------------------------------------------------------------------------
// Search / Fetch 服务费（官方：5 元 / 1000 次成功请求）
// ---------------------------------------------------------------------------

export const SERVICE_POLICY_VERSION = "SERVICE_V1";
export const SERVICE_FEE_PER_REQUEST = 0.005;
export const SERVICE_REFERENCE_DATE = PRICING_REFERENCE_DATE;

/**
 * 从采集到的服务调用统计估算费用。
 * 只对成功请求计费（官方口径）；失败请求不计费。
 * @param {{webSearch?: {success?:number, failed?:number}, webFetch?: {success?:number, failed?:number}}} service
 */
export function estimateServiceFees(service = {}) {
  const rows = [];
  let requests = 0;
  let failed = 0;
  for (const [kind, label] of [["webSearch", "Search"], ["webFetch", "Fetch"]]) {
    const success = Math.max(0, Math.round(service?.[kind]?.success ?? 0));
    const fail = Math.max(0, Math.round(service?.[kind]?.failed ?? 0));
    requests += success;
    failed += fail;
    rows.push({ kind, label, success, failed: fail, costCny: Math.round(success * SERVICE_FEE_PER_REQUEST * 1e6) / 1e6 });
  }
  const costCny = Math.round(rows.reduce((sum, row) => sum + row.costCny, 0) * 1e6) / 1e6;
  return { rows, requests, failed, costCny, version: SERVICE_POLICY_VERSION, unitPriceCny: SERVICE_FEE_PER_REQUEST };
}

// ---------------------------------------------------------------------------
// 缺失 usage 时的字符启发式（默认关闭；只统计字符数，不保留文本）
// ---------------------------------------------------------------------------

export const ESTIMATION_POLICY_VERSION = "ESTIMATION_V1";
export const DEFAULT_CN_CHARS_PER_TOKEN = 0.6;
export const DEFAULT_EN_CHARS_PER_TOKEN = 0.3;

const CJK_PATTERN = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/g;

/**
 * 按官方给出的换算比例估算 token：中文 ≈0.6 token/字，英文 ≈0.3 token/字符。
 * 只返回估算值（不写回 usage，不计入成本）。
 * @param {Array<{type?:string, text?:string}>} contentBlocks
 * @param {{cnRatio?:number, enRatio?:number}} [options]
 */
export function estimateTokensFromContent(contentBlocks, options = {}) {
  const cnRatio = Number.isFinite(options.cnRatio) ? options.cnRatio : DEFAULT_CN_CHARS_PER_TOKEN;
  const enRatio = Number.isFinite(options.enRatio) ? options.enRatio : DEFAULT_EN_CHARS_PER_TOKEN;
  let text = "";
  for (const block of Array.isArray(contentBlocks) ? contentBlocks : []) {
    if (block && typeof block.text === "string") text += block.text;
  }
  if (text.length === 0) return { tokens: 0, cjkChars: 0, otherChars: 0 };
  const cjkChars = (text.match(CJK_PATTERN) ?? []).length;
  const otherChars = Math.max(0, text.length - cjkChars);
  return {
    tokens: Math.round(cjkChars * cnRatio + otherChars * enRatio),
    cjkChars,
    otherChars,
  };
}
