/**
 * 配置与本地状态（v2）。
 * - schemaVersion 2：新增 ui.theme/fontScale/language/density、notify、sync、budget 双控件；
 * - 兼容 v1 自动迁移（读旧文件 → 补默认值 → 写回 v2）；
 * - 所有写入原子化；损坏文件备份后回退默认。
 */
import { readJson, writeJsonAtomic, readTextLines } from "./json.mjs";
import * as fs from "node:fs";
import { dirname } from "node:path";
import { comfortPath, configPath, statePath, metricsPath, cockpitHome } from "./paths.mjs";
import { cycleDateKey } from "./time.mjs";
import { join } from "node:path";
import {
  PRICING_VERSION,
  DEFAULT_IDLE_RATIO,
  DEFAULT_PEAK_WINDOWS,
  DEFAULT_PEAK_WEEKDAYS,
  normalizeModel,
  normalizePriceEntry,
} from "./pricing.mjs";

export const CONFIG_SCHEMA_VERSION = 2;
export const STATE_SCHEMA_VERSION = 2;
export const DEFAULT_BUDGET_TOKENS = 2_000_000;

export const DEFAULT_CONFIG = Object.freeze({
  schemaVersion: CONFIG_SCHEMA_VERSION,
  budget: {
    axis: "budget",
    mode: "daily",
    tokens: DEFAULT_BUDGET_TOKENS,
    costCny: 0,
    dayStartHour: 4,
    dailyCapPercent: 90,
    dayTotalPercent: 100,
    includeServiceFees: true,
  },
  pricing: {},
  pricingPolicy: {
    idleRatio: DEFAULT_IDLE_RATIO,
    peakWindows: DEFAULT_PEAK_WINDOWS.map((window) => [...window]),
    peakWeekdays: [...DEFAULT_PEAK_WEEKDAYS],
    holidays: [],
  },
  comfort: { minSamples: 5, halfLifeDays: 14 },
  estimation: { fallback: "none", cnCharTokenRatio: 0.6, enCharTokenRatio: 0.3 },
  // 显式开启后才允许访问官方余额接口（AGENTS.md：唯一允许的网络调用）
  balance: { enabled: false, ttlMs: 15_000, timeoutMs: 6_000, reconcileWindowMs: 86_400_000 },
  // 官方账号数据（DSH 账号授权；用户显式开启；精准余额 + 官方累计花费）
  account: { enabled: false, origin: "https://platform.deepseek.com", ttlMs: 60_000, timeoutMs: 8_000 },
  // 本机代理网关（可选）：让其它工具把 base_url 指到 127.0.0.1，精确记录上游 usage
  gateway: {
    enabled: false,
    host: "127.0.0.1",
    port: 7891,
    captureLimitBytes: 2_097_152,
    upstreams: [{ name: "deepseek", origin: "https://api.deepseek.com" }],
  },
  // 精确优先：严格模式下推算值（成本/服务费/预测）在界面以 ≈ 标注
  precision: { strict: true },
  ui: { maskTitles: false, language: "zh", theme: "dark", fontScale: 1, density: "comfortable" },
  notify: { enabled: true, budgetWarn: 80, budgetCritical: 95, compactionScore: 70, dailyCap: 90 },
  sync: { enabled: false, endpoint: "", spaceLabel: "", autoPush: false, deviceId: "", deviceName: "", shareTasks: true, shareComfort: true, maskTaskTitles: true },
  server: { host: "127.0.0.1", port: 7777 },
  metrics: { enabled: true },
});

const QUOTA_AXES = ["budget", "balance", "context"];
const BUDGET_MODES = ["daily", "weekly", "monthly"];
const THEMES = ["dark", "light", "auto"];
const DENSITIES = ["comfortable", "compact"];
const LANGUAGES = ["zh", "en"];

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function clampNumber(value, fallback, minimum, maximum) {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.min(maximum, Math.max(minimum, value))
    : fallback;
}

function normalizePricing(raw) {
  if (!isObject(raw)) return {};
  const out = {};
  for (const [model, price] of Object.entries(raw)) {
    const entry = normalizePriceEntry(price);
    if (entry) out[normalizeModel(model)] = entry;
  }
  return out;
}

function normalizePricingPolicy(raw) {
  const source = isObject(raw) ? raw : {};
  const windows = Array.isArray(source.peakWindows)
    ? source.peakWindows
        .filter((window) => Array.isArray(window) && window.length === 2 && Number.isFinite(window[0]) && Number.isFinite(window[1]))
        .map(([start, end]) => [Math.min(23, Math.max(0, start)), Math.min(24, Math.max(1, end))])
        .filter(([start, end]) => end > start)
        .slice(0, 8)
    : [];
  const weekdays = Array.isArray(source.peakWeekdays)
    ? [...new Set(source.peakWeekdays.filter((day) => Number.isInteger(day) && day >= 1 && day <= 7))].sort()
    : [];
  const holidays = Array.isArray(source.holidays)
    ? source.holidays.filter((day) => typeof day === "string" && /^\d{4}-\d{2}-\d{2}$/.test(day)).slice(-400)
    : [];
  return {
    idleRatio: clampNumber(source.idleRatio, DEFAULT_IDLE_RATIO, 0.05, 1),
    peakWindows: windows.length > 0 ? windows : DEFAULT_PEAK_WINDOWS.map((window) => [...window]),
    peakWeekdays: weekdays.length > 0 ? weekdays : [...DEFAULT_PEAK_WEEKDAYS],
    holidays,
  };
}

/** 合并默认值 + 校验 + 收敛 + v1→v2 迁移。任何非法输入退化为默认，不抛错。 */
export function normalizeConfig(raw) {
  const source = isObject(raw) ? raw : {};
  const legacy = source.schemaVersion === undefined || source.schemaVersion === 1;
  const budgetRaw = isObject(source.budget) ? source.budget : {};
  const comfortRaw = isObject(source.comfort) ? source.comfort : {};
  const uiRaw = isObject(source.ui) ? source.ui : {};
  const serverRaw = isObject(source.server) ? source.server : {};
  const metricsRaw = isObject(source.metrics) ? source.metrics : {};
  const notifyRaw = isObject(source.notify) ? source.notify : {};
  const syncRaw = isObject(source.sync) ? source.sync : {};

  return {
    schemaVersion: CONFIG_SCHEMA_VERSION,
    budget: {
      axis: QUOTA_AXES.includes(budgetRaw.axis) ? budgetRaw.axis : DEFAULT_CONFIG.budget.axis,
      mode: BUDGET_MODES.includes(budgetRaw.mode) ? budgetRaw.mode : DEFAULT_CONFIG.budget.mode,
      tokens: clampNumber(budgetRaw.tokens, DEFAULT_CONFIG.budget.tokens, 0, 1e12),
      costCny: clampNumber(budgetRaw.costCny, DEFAULT_CONFIG.budget.costCny, 0, 1e9),
      dayStartHour: Math.round(clampNumber(budgetRaw.dayStartHour, 4, 0, 23)),
      dailyCapPercent: clampNumber(budgetRaw.dailyCapPercent, 90, 10, 100),
      dayTotalPercent: clampNumber(budgetRaw.dayTotalPercent, 100, 10, 100),
      includeServiceFees: budgetRaw.includeServiceFees !== false,
    },
    pricing: normalizePricing(source.pricing),
    pricingPolicy: normalizePricingPolicy(source.pricingPolicy),
    comfort: {
      minSamples: Math.round(clampNumber(comfortRaw.minSamples, 5, 1, 60)),
      halfLifeDays: clampNumber(comfortRaw.halfLifeDays, 14, 1, 90),
    },
    estimation: (() => {
      const raw = isObject(source.estimation) ? source.estimation : {};
      return {
        fallback: raw.fallback === "chars" ? "chars" : "none",
        cnCharTokenRatio: clampNumber(raw.cnCharTokenRatio, 0.6, 0.05, 3),
        enCharTokenRatio: clampNumber(raw.enCharTokenRatio, 0.3, 0.05, 3),
      };
    })(),
    balance: (() => {
      const raw = isObject(source.balance) ? source.balance : {};
      return {
        enabled: raw.enabled === true,
        ttlMs: Math.round(clampNumber(raw.ttlMs, 15_000, 1_000, 300_000)),
        timeoutMs: Math.round(clampNumber(raw.timeoutMs, 6_000, 1_000, 30_000)),
        // 对账窗口：1 小时 ~ 7 天；不足窗口时回退"自首个快照起"
        reconcileWindowMs: Math.round(clampNumber(raw.reconcileWindowMs, 86_400_000, 3_600_000, 7 * 86_400_000)),
      };
    })(),
    account: (() => {
      const raw = isObject(source.account) ? source.account : {};
      return {
        enabled: raw.enabled === true,
        origin: typeof raw.origin === "string" && /^https:\/\/[^\s]+$/.test(raw.origin) ? raw.origin.replace(/\/+$/, "") : "https://platform.deepseek.com",
        ttlMs: Math.round(clampNumber(raw.ttlMs, 60_000, 1_000, 600_000)),
        timeoutMs: Math.round(clampNumber(raw.timeoutMs, 8_000, 1_000, 30_000)),
      };
    })(),
    gateway: (() => {
      const raw = isObject(source.gateway) ? source.gateway : {};
      const host = ["127.0.0.1", "localhost", "::1", "[::1]"].includes(raw.host) ? raw.host : "127.0.0.1";
      const upstreams = Array.isArray(raw.upstreams)
        ? raw.upstreams
            .filter((item) => item && typeof item.name === "string" && /^[a-z0-9-]{1,20}$/.test(item.name) && typeof item.origin === "string" && /^https:\/\/[^\s]+$/.test(item.origin))
            .slice(0, 8)
            .map((item) => ({ name: item.name, origin: item.origin.replace(/\/+$/, "") }))
        : [];
      return {
        enabled: raw.enabled === true,
        host,
        port: Math.round(clampNumber(raw.port, 7891, 1024, 65535)),
        captureLimitBytes: Math.round(clampNumber(raw.captureLimitBytes, 2_097_152, 65_536, 8 * 1024 * 1024)),
        upstreams: upstreams.length > 0 ? upstreams : [{ name: "deepseek", origin: "https://api.deepseek.com" }],
      };
    })(),
    precision: (() => {
      const raw = isObject(source.precision) ? source.precision : {};
      return { strict: raw.strict !== false };
    })(),
    ui: {
      maskTitles: uiRaw.maskTitles === true,
      language: LANGUAGES.includes(uiRaw.language) ? uiRaw.language : "zh",
      theme: THEMES.includes(uiRaw.theme) ? uiRaw.theme : "dark",
      fontScale: clampNumber(uiRaw.fontScale, 1, 0.8, 1.4),
      density: DENSITIES.includes(uiRaw.density) ? uiRaw.density : "comfortable",
    },
    notify: {
      enabled: notifyRaw.enabled !== false,
      budgetWarn: clampNumber(notifyRaw.budgetWarn, 80, 10, 100),
      budgetCritical: clampNumber(notifyRaw.budgetCritical, 95, 10, 100),
      compactionScore: clampNumber(notifyRaw.compactionScore, 70, 10, 100),
      dailyCap: clampNumber(notifyRaw.dailyCap, 90, 10, 100),
    },
    sync: {
      enabled: syncRaw.enabled === true,
      endpoint: typeof syncRaw.endpoint === "string" ? syncRaw.endpoint.slice(0, 300) : "",
      spaceLabel: typeof syncRaw.spaceLabel === "string" ? syncRaw.spaceLabel.slice(0, 60) : "",
      autoPush: syncRaw.autoPush === true,
      deviceId:
        typeof syncRaw.deviceId === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{2,63}$/.test(syncRaw.deviceId)
          ? syncRaw.deviceId
          : "",
      deviceName:
        typeof syncRaw.deviceName === "string"
          ? syncRaw.deviceName.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 40)
          : "",
      // 团队同步的可选数据通道（对齐 Codex：默认开启，可显式关闭）
      shareTasks: syncRaw.shareTasks !== false,
      shareComfort: syncRaw.shareComfort !== false,
      maskTaskTitles: syncRaw.maskTaskTitles !== false,
    },
    server: {
      host: "127.0.0.1",
      port: Math.round(clampNumber(serverRaw.port, 7777, 1024, 65535)),
    },
    metrics: { enabled: metricsRaw.enabled !== false },
    _migratedFrom: legacy ? (source.schemaVersion ?? 0) : undefined,
  };
}

export function loadConfig(env = process.env) {
  const { value, existed, repaired } = readJson(configPath(env), null);
  if (!existed) return { config: normalizeConfig({}), existed: false, repaired: false, migrated: false };
  const migrated = isObject(value) && value.schemaVersion !== CONFIG_SCHEMA_VERSION;
  const config = normalizeConfig(value);
  if (migrated) {
    try {
      writeJsonAtomic(configPath(env), { ...config, _migratedFrom: undefined });
    } catch {
      /* 迁移写盘失败不阻塞 */
    }
  }
  return { config, existed: true, repaired, migrated };
}

export function saveConfig(raw, env = process.env) {
  const { _migratedFrom, ...rest } = normalizeConfig(raw);
  writeJsonAtomic(configPath(env), rest);
  return normalizeConfig(rest);
}

// ---------------------------------------------------------------------------
// 舒适度记录
// ---------------------------------------------------------------------------

function normalizeComfort(raw) {
  const entries = Array.isArray(raw?.entries) ? raw.entries : [];
  const byDate = new Map();
  for (const entry of entries) {
    if (!isObject(entry)) continue;
    const date = typeof entry.date === "string" ? entry.date : null;
    const level = Math.round(clampNumber(entry.level, 0, 0, 5));
    if (!date || level < 1) continue;
    byDate.set(date, {
      date,
      level,
      note: typeof entry.note === "string" ? entry.note.slice(0, 200) : "",
      updatedAt: clampNumber(entry.updatedAt, Date.now(), 0, Number.MAX_SAFE_INTEGER),
    });
  }
  return {
    schemaVersion: CONFIG_SCHEMA_VERSION,
    entries: [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date)),
  };
}

export function loadComfort(env = process.env) {
  const { value } = readJson(comfortPath(env), { entries: [] });
  return normalizeComfortStore(value);
}

/** 归一化外部传入的舒适度存储（供备份恢复/测试使用）。 */
export function normalizeComfortStore(raw) {
  return normalizeComfort(raw);
}

export function recordComfort({ level, note = "", date = null, nowMs = Date.now() }, env = process.env) {
  const store = loadComfort(env);
  const dateKey = date ?? cycleDateKey(nowMs, 0);
  const entries = store.entries.filter((entry) => entry.date !== dateKey);
  entries.push({
    date: dateKey,
    level: Math.round(clampNumber(level, 3, 1, 5)),
    note: String(note ?? "").slice(0, 200),
    updatedAt: nowMs,
  });
  const next = { schemaVersion: CONFIG_SCHEMA_VERSION, entries: entries.sort((a, b) => a.date.localeCompare(b.date)) };
  writeJsonAtomic(comfortPath(env), next);
  return next;
}

// ---------------------------------------------------------------------------
// 扫描缓存
// ---------------------------------------------------------------------------

export function emptyState() {
  return { schemaVersion: STATE_SCHEMA_VERSION, files: {}, lastScanAt: null, unknownEventTypes: {} };
}

export function loadState(env = process.env) {
  const { value } = readJson(statePath(env), null);
  // 价格政策变化会使缓存里的成本失真 → 按 PRICING_VERSION 失效并重扫
  if (
    !isObject(value) ||
    value.schemaVersion !== STATE_SCHEMA_VERSION ||
    !isObject(value.files) ||
    value.pricingVersion !== PRICING_VERSION
  ) {
    return emptyState();
  }
  return {
    schemaVersion: STATE_SCHEMA_VERSION,
    files: value.files,
    lastScanAt: typeof value.lastScanAt === "number" ? value.lastScanAt : null,
    unknownEventTypes: isObject(value.unknownEventTypes) ? value.unknownEventTypes : {},
  };
}

export function saveState(state, env = process.env) {
  writeJsonAtomic(statePath(env), { ...state, pricingVersion: PRICING_VERSION });
}

// ---------------------------------------------------------------------------
// 通知已读状态（本地，不联网）
// ---------------------------------------------------------------------------

export function notificationStatePath(env = process.env) {
  return join(cockpitHome(env), "notifications.json");
}

export function loadNotificationState(env = process.env) {
  const { value } = readJson(notificationStatePath(env), { read: [] });
  const read = Array.isArray(value?.read) ? value.read.filter((item) => typeof item === "string").slice(-500) : [];
  return { read };
}

export function saveNotificationState(state, env = process.env) {
  writeJsonAtomic(notificationStatePath(env), { read: state.read.slice(-500) });
  return state;
}

// ---------------------------------------------------------------------------
// 本地事件日志（零遥测）
// ---------------------------------------------------------------------------

export function logMetric(event, env = process.env, config = DEFAULT_CONFIG) {
  if (!config?.metrics?.enabled) return;
  try {
    const path = metricsPath(env);
    const dir = dirname(path);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.appendFileSync(path, `${JSON.stringify({ ts: new Date().toISOString(), event })}\n`, { mode: 0o600 });
  } catch {
    /* 日志失败不影响主流程 */
  }
}

export function readMetrics(env = process.env) {
  return readTextLines(metricsPath(env));
}
