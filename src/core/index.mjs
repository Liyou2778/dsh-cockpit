/**
 * 核心编排 v2：扫描 → 范围解析 → 聚合（日期/模型/任务/项目）→ 配额/配速/计划/预测
 * → 风险图/洞察/通知/舒适度/历史 → Status JSON。
 * CLI / HTTP / DSH 插件 / 同步模块共享同一套实现。
 */
import { discoverSessions, readSessionFile } from "./session-reader.mjs";
import { summarizeSession } from "./collect.mjs";
import {
  loadConfig,
  loadState,
  saveState,
  loadComfort,
  recordComfort,
  loadNotificationState,
  saveNotificationState,
  logMetric,
  STATE_SCHEMA_VERSION,
} from "./config.mjs";
import { sessionsRoot } from "./paths.mjs";
import { cycleBounds, cycleDateKey } from "./time.mjs";
import { calculatePace, PACE_POLICY_VERSION } from "./pace.mjs";
import { planCalibratedRiskQuota, daysLeft, isWeekend, PLAN_POLICY_VERSION } from "./plan.mjs";
import { forecastCompaction, pressureGrowthPerHour, FORECAST_POLICY_VERSION } from "./forecast.mjs";
import {
  fitComfortK,
  binComfort,
  comfortCalendar,
  COMFORT_FIT_VERSION,
} from "./comfort.mjs";
import { resolveRange, isValidDateKey } from "./range.mjs";
import {
  aggregateAll,
  createFilter,
  buildSubagentTree,
  taskRows,
  projectRows,
  topModels,
  topTools,
  zeroMetrics,
  mergeMetrics,
  taskKeyOf,
  stableKey,
} from "./aggregate.mjs";
import { buildRiskMap } from "./riskmap.mjs";
import { pricingNow, estimateServiceFees, PRICING_VERSION, PRICING_REFERENCE_DATE } from "./pricing.mjs";
import {
  BALANCE_POLICY_VERSION,
  DEFAULT_RECONCILE_WINDOW_MS,
  fetchBalance,
  getSharedBalanceService,
  loadBalanceHistory,
  reconcileBalance,
  selectReconcileBaseline,
} from "./balance.mjs";
import {
  ACCOUNT_POLICY_VERSION,
  DEFAULT_ACCOUNT_ORIGIN,
  fetchAccountSummary,
  getSharedAccountService,
} from "./account.mjs";
import { buildInsights } from "./insights.mjs";
import { evaluateAlerts, withReadState } from "./notify.mjs";
import { buildCalendar } from "./calendar.mjs";
import { buildBackup, restoreBackup } from "./backup.mjs";
import { round } from "./math.mjs";
import { readGatewayRecords, summarizeGateway } from "../gateway/log.mjs";

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

function iso(ms) {
  return typeof ms === "number" && Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

function maskTitle(title, config) {
  if (!config?.ui?.maskTitles || typeof title !== "string") return title;
  const visible = title.trim().slice(0, 1);
  return visible ? `${visible}***` : "***";
}

function maskRows(rows, config) {
  if (!config?.ui?.maskTitles) return rows;
  return rows.map((row) => ({ ...row, title: maskTitle(row.title, config) }));
}

// ---------------------------------------------------------------------------
// 扫描（只读 DSH + 增量缓存）
// ---------------------------------------------------------------------------

export function scanSessions(options) {
  const env = options.env ?? process.env;
  const config = options.config;
  const force = options.force === true;
  const started = Date.now();
  const { sessions, stats } = discoverSessions(sessionsRoot(env));
  const state = loadState(env);
  const nextFiles = {};
  const summaries = [];
  const errors = [];
  let cacheHits = 0;

  for (const entry of sessions) {
    const key = `${entry.path}|${entry.size}|${Math.round(entry.mtimeMs)}`;
    const cached = force ? undefined : state.files[key];
    if (cached?.summary) {
      nextFiles[key] = cached;
      summaries.push(cached.summary);
      cacheHits += 1;
      continue;
    }
    try {
      const parsed = readSessionFile(entry.path);
      const summary = summarizeSession(parsed, {
        sessionId: entry.sessionId,
        projectSlug: entry.projectSlug,
        path: entry.path,
        pricing: config.pricing,
        pricingPolicy: config.pricingPolicy,
        estimation: config.estimation,
        dayStartHour: config.budget.dayStartHour,
      });
      summary.version = summary.version ?? entry.version;
      summary.counts.skippedLines = parsed.skipped;
      nextFiles[key] = { size: entry.size, mtimeMs: entry.mtimeMs, summary };
      summaries.push(summary);
    } catch (error) {
      errors.push({ path: entry.path, code: error?.code ?? "UNKNOWN", message: error?.message ?? String(error) });
    }
  }

  // 状态缓存只是加速层：写失败（文件锁/权限）不应让整个接口 500
  try {
    saveState({ schemaVersion: STATE_SCHEMA_VERSION, files: nextFiles, lastScanAt: Date.now(), unknownEventTypes: {} }, env);
  } catch {
    /* 缓存写失败忽略，下次扫描重算 */
  }
  return { summaries, stats, errors, cacheHits, durationMs: Date.now() - started };
}

// ---------------------------------------------------------------------------
// 范围 + 过滤 + 聚合
// ---------------------------------------------------------------------------

function earliestCreatedAt(summaries) {
  let earliest = null;
  for (const summary of summaries) {
    const createdAt = typeof summary.createdAt === "number" ? summary.createdAt : null;
    if (createdAt !== null && (earliest === null || createdAt < earliest)) earliest = createdAt;
  }
  return earliest;
}

function queryFromOptions(options) {
  return {
    range: options.range,
    from: options.from,
    to: options.to,
    model: options.model,
    project: options.project,
    task: options.task,
    includeSubagents: options.includeSubagents,
    q: options.q,
    sort: options.sort,
    order: options.order,
    page: options.page,
    pageSize: options.pageSize,
    month: options.month,
    tasks: options.tasks,
    models: options.models,
  };
}

function buildContext(env, options) {
  const nowMs = options.nowMs ?? Date.now();
  const loaded = options.config ? { config: options.config, existed: true } : loadConfig(env);
  const config = loaded.config;
  const configExisted = loaded.existed !== false;
  const scan = scanSessions({ env, config, force: options.force === true });
  const range = resolveRange({
    range: options.range,
    from: options.from,
    to: options.to,
    nowMs,
    config,
    earliestMs: earliestCreatedAt(scan.summaries),
  });
  const filter = createFilter({
    range,
    model: options.model,
    project: options.project,
    task: options.task,
    includeSubagents: options.includeSubagents,
  });
  const aggregate = aggregateAll(scan.summaries, filter);
  return { env, nowMs, config, configExisted, scan, range, filter, aggregate };
}

// ---------------------------------------------------------------------------
// 周期级（额度/配速/计划）与活跃会话
// ---------------------------------------------------------------------------

function cycleContext(context) {
  const cycle = cycleBounds(context.nowMs, context.config.budget);
  const cycleRange = resolveRange({ range: "cycle", nowMs: context.nowMs, config: context.config });
  const cycleFilter = createFilter({ range: cycleRange, includeSubagents: true });
  const cycleAggregate = aggregateAll(context.scan.summaries, cycleFilter);
  return { cycle, cycleRange, cycleAggregate };
}

function pickActiveSession(summaries) {
  let best = null;
  for (const summary of summaries) {
    const lastAt = summary.lastAt ?? 0;
    if (!best || lastAt > (best.lastAt ?? 0)) best = summary;
  }
  return best;
}

function computeQuota({ config, cycle, totals, activeSession, serviceFeesCny = 0 }) {
  if (config.budget.axis === "context" && activeSession?.context?.contextWindow) {
    const contextWindow = activeSession.context.contextWindow;
    const pressure = Math.min(contextWindow, Math.max(0, activeSession.context.pressure ?? 0));
    const remainingPercent = Math.max(0, 100 - (pressure / contextWindow) * 100);
    return {
      axis: "context",
      label: "上下文窗口",
      cycleStart: iso(cycle.startMs),
      cycleEnd: iso(cycle.endMs),
      resetsAt: null,
      windowSeconds: cycle.windowSeconds,
      limit: contextWindow,
      used: pressure,
      remainingPercent: round(remainingPercent),
      usedPercent: round(100 - remainingPercent),
      unit: "window",
    };
  }
  const useCny = config.budget.costCny > 0;
  const includeServiceFees = config.budget.includeServiceFees !== false;
  const limit = useCny ? config.budget.costCny : config.budget.tokens;
  const used = useCny ? totals.costCny + (includeServiceFees ? serviceFeesCny : 0) : totals.totalTokens;
  const usedPercent = limit > 0 ? Math.min(100, Math.max(0, (used / limit) * 100)) : 0;
  return {
    axis: "budget",
    label: useCny ? `${cycle.label}成本预算` : `${cycle.label} Token 预算`,
    cycleStart: iso(cycle.startMs),
    cycleEnd: iso(cycle.endMs),
    resetsAt: iso(cycle.endMs),
    windowSeconds: cycle.windowSeconds,
    limit: round(limit, 2),
    used: round(used, 4),
    remainingPercent: round(100 - usedPercent),
    usedPercent: round(usedPercent),
    unit: useCny ? "cny" : "tokens",
    includesServiceFees: useCny && includeServiceFees,
    serviceFeesCny: round(serviceFeesCny, 4),
  };
}

async function fetchDeepSeekBalance(options = {}) {
  const env = options.env ?? process.env;
  const result = await fetchBalance({
    env,
    fetchImpl: options.fetchImpl,
    timeoutMs: options.timeoutMs ?? 4_000,
  });
  if (!result.ok) return null;
  return { currency: result.currency ?? "CNY", total: result.total, isAvailable: result.isAvailable };
}

// ---------------------------------------------------------------------------
// 官方余额（实时）与对账
// ---------------------------------------------------------------------------

function dayKeyToMs(dateKey, dayStartHour = 4) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dateKey));
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  // 北京时间固定 UTC+8；日归属从 dayStartHour 开始
  return Date.UTC(year, month - 1, day, dayStartHour - 8, 0, 0, 0);
}

/** 同一窗口内的本地估算成本（模型成本 + Search/Fetch 服务费），按日桶近似。 */
function sumLocalSpendCny(summaries, fromMs, toMs, dayStartHour) {
  let cost = 0;
  for (const summary of summaries) {
    for (const [dateKey, metrics] of Object.entries(summary.byDay ?? {})) {
      const start = dayKeyToMs(dateKey, dayStartHour);
      if (start === null || start < fromMs || start > toMs) continue;
      cost += metrics?.costCny ?? 0;
    }
    for (const [dateKey, dayService] of Object.entries(summary.byDayService ?? {})) {
      const start = dayKeyToMs(dateKey, dayStartHour);
      if (start === null || start < fromMs || start > toMs) continue;
      cost += estimateServiceFees(dayService).costCny;
    }
  }
  return round(cost, 4);
}

async function buildAccountStatus({ context, nowMs, refresh = false, service, fetchImpl }) {
  const { config, env } = context;
  if (!config.account?.enabled) {
    return {
      enabled: false,
      available: false,
      policyVersion: ACCOUNT_POLICY_VERSION,
      reason: "DISABLED",
      hint: "开启：node src/cli.mjs config --set account.enabled=true（读取 DSH 账号授权，不落盘、不打印）",
    };
  }
  const accountService =
    service ??
    getSharedAccountService(env, {
      fetchImpl,
      ttlMs: config.account.ttlMs,
      timeoutMs: config.account.timeoutMs,
      origin: config.account.origin ?? DEFAULT_ACCOUNT_ORIGIN,
    });
  try {
    return await accountService.get({ force: refresh === true });
  } catch {
    return {
      enabled: true,
      available: false,
      policyVersion: ACCOUNT_POLICY_VERSION,
      fetchedAt: new Date(nowMs).toISOString(),
      error: { code: "ACCOUNT_INTERNAL", message: "官方账号查询内部错误" },
    };
  }
}

export async function buildAccountReport({ env = process.env, refresh = false, config, service, fetchImpl } = {}) {
  const cfg = config ?? loadConfig(env).config;
  if (!cfg.account?.enabled) {
    return {
      enabled: false,
      available: false,
      policyVersion: ACCOUNT_POLICY_VERSION,
      reason: "DISABLED",
      hint: "开启：node src/cli.mjs config --set account.enabled=true",
    };
  }
  const accountService =
    service ??
    getSharedAccountService(env, {
      fetchImpl,
      ttlMs: cfg.account.ttlMs,
      timeoutMs: cfg.account.timeoutMs,
      origin: cfg.account.origin ?? DEFAULT_ACCOUNT_ORIGIN,
    });
  return accountService.get({ force: refresh === true });
}

async function buildBalanceStatus({ context, nowMs, refresh = false, service, fetchImpl }) {
  const { config, scan, env } = context;
  if (!config.balance?.enabled) {
    return {
      enabled: false,
      available: false,
      policyVersion: BALANCE_POLICY_VERSION,
      reason: "DISABLED",
      hint: "开启：node src/cli.mjs config --set balance.enabled=true（需设置 DEEPSEEK_API_KEY）",
    };
  }
  const balanceService =
    service ??
    getSharedBalanceService(env, {
      fetchImpl,
      ttlMs: config.balance.ttlMs,
      timeoutMs: config.balance.timeoutMs,
    });
  let live;
  try {
    live = await balanceService.get({ force: refresh === true });
  } catch {
    live = {
      enabled: true,
      available: false,
      fetchedAt: null,
      error: { code: "BALANCE_INTERNAL", message: "余额查询内部错误" },
    };
  }
  if (!live.available) {
    return {
      enabled: true,
      available: false,
      policyVersion: BALANCE_POLICY_VERSION,
      fetchedAt: live.fetchedAt ?? null,
      cached: live.cached === true,
      error: live.error ?? { code: "BALANCE_UNAVAILABLE", message: "余额不可用" },
    };
  }
  const windowMs = config.balance.reconcileWindowMs ?? DEFAULT_RECONCILE_WINDOW_MS;
  const snapshots = loadBalanceHistory(env).snapshots;
  // 先选基线（full 或 since-first），本地估算窗口与官方扣费窗口保持一致
  const selected = selectReconcileBaseline({ snapshots, windowMs, now: nowMs });
  const fromMs = selected.baseline ? selected.baseline.at : nowMs - windowMs;
  const localSpendCny = sumLocalSpendCny(scan.summaries, fromMs, nowMs, config.budget.dayStartHour);
  const reconciliation = reconcileBalance({
    snapshots,
    current: { at: Date.parse(live.fetchedAt), total: live.total },
    windowMs,
    now: nowMs,
    localSpendCny,
  });
  return { ...live, policyVersion: BALANCE_POLICY_VERSION, reconciliation };
}

/**
 * 轻量余额查询（供 `/api/balance` 与 CLI 使用）：只拉官方余额 + 最近快照，
 * 不做扫描/聚合；手动刷新传 `refresh: true` 绕过 TTL。
 */
export async function buildBalanceReport({ env = process.env, refresh = false, fetchImpl, service, config } = {}) {
  const cfg = config ?? loadConfig(env).config;
  if (!cfg.balance?.enabled) {
    return {
      enabled: false,
      available: false,
      policyVersion: BALANCE_POLICY_VERSION,
      reason: "DISABLED",
      hint: "开启：node src/cli.mjs config --set balance.enabled=true（需设置 DEEPSEEK_API_KEY）",
    };
  }
  const balanceService =
    service ??
    getSharedBalanceService(env, { fetchImpl, ttlMs: cfg.balance.ttlMs, timeoutMs: cfg.balance.timeoutMs });
  const live = await balanceService.get({ force: refresh === true });
  const history = loadBalanceHistory(env);
  return {
    ...live,
    policyVersion: BALANCE_POLICY_VERSION,
    snapshots: history.snapshots.slice(-24),
  };
}

// ---------------------------------------------------------------------------
// 历史 / 舒适度
// ---------------------------------------------------------------------------

function buildHistory({ summaries, days, config, comfort, nowMs }) {
  const aggregate = aggregateAll(summaries, createFilter({
    range: { startDate: cycleDateKey(nowMs - days * DAY_MS, config.budget.dayStartHour), endDate: cycleDateKey(nowMs, config.budget.dayStartHour) },
    includeSubagents: true,
  }));
  const comfortByDate = new Map((comfort?.entries ?? []).map((entry) => [entry.date, entry.level]));
  const limitTokens = config.budget.tokens > 0 ? config.budget.tokens : 0;
  const list = [];
  for (let offset = days - 1; offset >= 0; offset -= 1) {
    const dateKey = cycleDateKey(nowMs - offset * DAY_MS, config.budget.dayStartHour);
    const metrics = aggregate.byDay[dateKey];
    const tokens = metrics?.totalTokens ?? 0;
    const costCny = round(metrics?.costCny ?? 0, 4);
    let status = "unknown";
    if (metrics) status = limitTokens > 0 && tokens > limitTokens ? "over_pace" : "on_track";
    list.push({ date: dateKey, tokens, costCny, comfort: comfortByDate.get(dateKey) ?? null, status, messages: metrics?.messages ?? 0 });
  }
  return list;
}

function buildComfortSamples(comfort, history) {
  const historyByDate = new Map(history.map((item) => [item.date, item]));
  const maxTokens = history.reduce((max, item) => Math.max(max, item.tokens), 0);
  return (comfort?.entries ?? []).map((entry) => {
    const day = historyByDate.get(entry.date);
    const usedPercent = maxTokens > 0 && day ? (day.tokens / maxTokens) * 100 : 0;
    return { date: entry.date, level: entry.level, usedPercent, ts: Date.parse(`${entry.date}T12:00:00+08:00`) };
  });
}

// ---------------------------------------------------------------------------
// Status（主入口）
// ---------------------------------------------------------------------------

/**
 * @param {{env?: NodeJS.ProcessEnv, nowMs?: number, force?: boolean, fetchImpl?: Function, config?: object,
 *          range?: string, from?: string, to?: string, model?: string, project?: string, task?: string,
 *          includeSubagents?: boolean, q?: string, sort?: string, order?: string, page?: number, pageSize?: number}} [options]
 */
export async function buildStatus(options = {}) {
  const started = Date.now();
  const env = options.env ?? process.env;
  const context = buildContext(env, options);
  const { nowMs, config, configExisted, scan, range, aggregate } = context;
  const { cycle, cycleRange, cycleAggregate } = cycleContext(context);

  const activeSession = pickActiveSession(scan.summaries);
  const contextWindow = activeSession?.context?.contextWindow ?? null;
  const pressure = activeSession?.context?.pressure ?? 0;
  const compactions = activeSession?.compactions ?? [];
  const compactions24h = compactions.filter((item) => typeof item.ts === "number" && nowMs - item.ts <= DAY_MS).length;
  const pressureGrowth = pressureGrowthPerHour((activeSession?.pressureSamples ?? []).slice(-20));
  const elapsedHours = Math.max(0.25, (nowMs - cycle.startMs) / HOUR_MS);
  const growthPerHour = pressureGrowth > 0 ? pressureGrowth : contextWindow ? cycleAggregate.totals.totalTokens / elapsedHours : 0;
  const forecast = forecastCompaction({ pressure, contextWindow, compactions, growthPerHour, nowMs });

  const comfort = loadComfort(env);
  const history = buildHistory({ summaries: scan.summaries, days: 30, config, comfort, nowMs });
  const comfortSamples = buildComfortSamples(comfort, history);
  const comfortFit = fitComfortK(comfortSamples, {
    minSamples: config.comfort.minSamples,
    halfLifeDays: config.comfort.halfLifeDays,
    nowMs,
  });

  let mode = "local";
  const warnings = [];
  const account = await buildAccountStatus({
    context,
    nowMs,
    refresh: options.refreshAccount === true,
    service: options.accountService,
    fetchImpl: options.fetchImpl,
  });
  if (config.budget.axis === "balance") {
    // 官方账号数据优先（精准余额），API Key 余额接口只作回退
    if (account.available && (account.normalBalance || account.bonusBalance)) mode = "balance";
    else {
      const balance = await fetchDeepSeekBalance({ env, fetchImpl: options.fetchImpl });
      if (balance) mode = "balance";
      else warnings.push("官方账号/余额不可用，已回退预算模式");
    }
  }

  const quota = computeQuota({
    config,
    cycle,
    totals: cycleAggregate.totals,
    activeSession,
    serviceFeesCny: estimateServiceFees(cycleAggregate.service).costCny,
  });
  quota.isDefaultBudget = !configExisted && config.budget.axis === "budget";
  quota.dailyCapPercent = config.budget.dailyCapPercent;

  const pace = calculatePace({
    windowSeconds: cycle.windowSeconds,
    remainingPercent: quota.remainingPercent,
    resetsAtMs: quota.resetsAt ? Date.parse(quota.resetsAt) : null,
    nowMs,
    cycleStartedAtMs: cycle.startMs,
    cycleStartRemainingPercent: 100,
  });

  const plan = planCalibratedRiskQuota({
    remainingPercent: quota.remainingPercent,
    riskPercent: forecast.score,
    fatigueKneePercent: comfortFit.fitted ? comfortFit.k : undefined,
    isWeekend: isWeekend(nowMs),
    daysLeftInCycle: daysLeft(cycle.endMs, nowMs),
  });
  plan.dailyCapPercent = config.budget.dailyCapPercent;
  plan.dayTotalPercent = config.budget.dayTotalPercent;

  const binned = binComfort(comfortSamples, { bins: 5 });
  const comfortCal = comfortCalendar(comfort.entries, history);
  const cycleService = estimateServiceFees(cycleAggregate.service);
  const rangeService = estimateServiceFees(aggregate.service);

  const reliability = {
    ...aggregate.reliability,
    toolErrorRate: aggregate.reliability.toolResults > 0
      ? round(aggregate.reliability.toolErrors / aggregate.reliability.toolResults, 4)
      : 0,
    retriesPerMessage: aggregate.totals.messages > 0
      ? round(aggregate.reliability.retries / aggregate.totals.messages, 4)
      : 0,
    window: range.label,
  };
  const estimation = {
    enabled: config.estimation?.fallback === "chars",
    policy: config.estimation ?? { fallback: "none" },
    messages: aggregate.estimation.messages,
    tokens: aggregate.estimation.tokens,
    note: "按字符数启发式估算，仅供参考，未计入成本",
  };

  const statusForRules = { quota, pace, forecast, context: { percent: contextWindow ? (pressure / contextWindow) * 100 : 0, compactions24h } };
  const insights = buildInsights({
    aggregate,
    status: statusForRules,
    history,
    comfortEntries: comfort.entries,
    config,
    nowMs,
    rangeLabel: range.label,
    reliability,
    serviceFees: rangeService,
  });

  const notificationState = loadNotificationState(env);
  const { alerts, unread } = withReadState(evaluateAlerts({ status: statusForRules, config }), notificationState.read);

  const split = (rows) => maskRows(rows, config);
  const rangeSessions = split(aggregate.sessions.map((row) => ({ ...row, title: row.title })));

  const health = {
    sessionsScanned: scan.summaries.length,
    sessionsDiscovered: scan.stats.seen,
    errors: scan.errors.length,
    durationMs: Date.now() - started,
    scanDurationMs: scan.durationMs,
    cacheHitRate: scan.summaries.length > 0 ? round(scan.cacheHits / scan.summaries.length, 2) : 0,
    messages: aggregate.totals.messages,
    messagesWithUsage: aggregate.totals.messages,
    costKnownTokens: aggregate.totals.costKnownTokens,
    costUnknownTokens: aggregate.totals.costUnknownTokens,
    partialCost: aggregate.totals.costUnknownTokens > 0,
    rangeSessions: rangeSessions.length,
    pressureSamples: activeSession?.pressureSamples?.length ?? 0,
    errors_sample: scan.errors.slice(0, 5),
  };

  if (config.metrics?.enabled) logMetric({ type: "status", durationMs: Date.now() - started, range: range.kind }, env, config);

  const gateway = { enabled: config.gateway?.enabled === true, logPath: null };
  try {
    const gatewayRecords = readGatewayRecords(env, { sinceMs: cycle.startMs });
    Object.assign(gateway, summarizeGateway(gatewayRecords, { pricing: config.pricing, pricingPolicy: config.pricingPolicy, nowMs }));
  } catch {
    gateway.error = { code: "GATEWAY_LOG_ERROR", message: "网关日志读取失败" };
  }

  const balance = await buildBalanceStatus({
    context,
    nowMs,
    refresh: options.refreshBalance === true,
    service: options.balanceService,
    fetchImpl: options.fetchImpl,
  });

  return {
    generatedAt: iso(nowMs),
    mode,
    warnings,
    range,
    quota,
    pace,
    plan,
    forecast,
    pricingNow: pricingNow(nowMs, config.pricingPolicy),
    riskMap: buildRiskMap({
      usedPercent: quota.usedPercent,
      riskPercent: forecast.score,
      knee: comfortFit.fitted ? comfortFit.k : 25,
      isWeekend: isWeekend(nowMs),
      daysLeftInCycle: daysLeft(cycle.endMs, nowMs),
    }),
    context: {
      contextWindow,
      pressure,
      percent: contextWindow ? round((pressure / contextWindow) * 100) : null,
      sessionId: activeSession?.id ?? null,
      title: maskTitle(activeSession?.title, config) ?? null,
      compactions24h,
      provider: activeSession?.context?.provider ?? null,
      model: activeSession?.context?.model ?? null,
    },
    totals: {
      todayTokens: cycleAggregate.totals.totalTokens,
      todayCostCny: round(cycleAggregate.totals.costCny, 4),
      cycleTokens: cycleAggregate.totals.totalTokens,
      cycleCostCny: round(cycleAggregate.totals.costCny, 4),
      rangeTokens: aggregate.totals.totalTokens,
      rangeCostCny: round(aggregate.totals.costCny, 4),
      todayServiceFeesCny: round(cycleService.costCny, 4),
      cycleServiceFeesCny: round(cycleService.costCny, 4),
      rangeServiceFeesCny: round(rangeService.costCny, 4),
      rangeTotalCostCny: round(aggregate.totals.costCny + rangeService.costCny, 4),
      sessions: aggregate.sessions.length,
      messages: aggregate.totals.messages,
      messagesWithUsage: aggregate.totals.messages,
    },
    breakdown: {
      models: topModels(aggregate.models),
      tools: topTools(aggregate.tools),
      sessions: split(rangeSessions.slice(0, 5)),
      tasks: maskRows(taskRows(aggregate.tasks, aggregate.totals, { pageSize: 5 }).items, config),
      projects: projectRows(aggregate.projects, aggregate.totals).slice(0, 5),
      services: {
        rows: rangeService.rows,
        requests: rangeService.requests,
        failed: rangeService.failed,
        costCny: rangeService.costCny,
        version: rangeService.version,
        unitPriceCny: rangeService.unitPriceCny,
        approximation: "按成功工具调用计数（一次 web_search 可能触发多个 provider 请求，结果为下限估计）",
      },
    },
    history,
    comfort: {
      fitted: comfortFit.fitted,
      k: comfortFit.k,
      sampleSize: comfortFit.sampleSize,
      residual: comfortFit.residual,
      policyVersion: COMFORT_FIT_VERSION,
      points: comfortSamples.map((sample) => ({ x: round(sample.usedPercent), y: sample.level })),
      curve: comfortFit.curve,
      binned,
      calendar: comfortCal,
    },
    insights,
    notifications: { alerts, unread, settings: config.notify },
    reliability,
    estimation,
    balance,
    gateway,
    account,
    precision: {
      policyVersion: "PRECISION_V1",
      strict: config.precision?.strict === true,
      official: [
        "account.normalBalance / bonusBalance / totalCost（官方账号接口，精准）",
        "balance.total（API Key 余额接口可用时，精准）",
      ],
      measured: [
        "totals.*Tokens（DSH usage 返回，精准）",
        "context.*（request/context，精准）",
        "reliability.*（llm/retry 事件，精准）",
      ],
      derived: [
        "totals.*CostCny（按价格表推算，非官方账单）",
        "serviceFees（按成功调用计的下限）",
        "forecast/pace/plan（预测或基于自设预算）",
      ],
      note: "官方账户数据为精准值；模型/任务级金额、服务费与预测为推算，界面以 ≈ 标注",
    },
    serviceFees: {
      rows: rangeService.rows,
      requests: rangeService.requests,
      failed: rangeService.failed,
      costCny: rangeService.costCny,
      cycleCostCny: round(cycleService.costCny, 4),
      version: rangeService.version,
      unitPriceCny: rangeService.unitPriceCny,
      approximation: "按成功工具调用计数；一次 web_search 可能触发多个 provider 请求，结果为下限估计",
    },
    health,
    versions: { pace: PACE_POLICY_VERSION, plan: PLAN_POLICY_VERSION, forecast: FORECAST_POLICY_VERSION, comfort: COMFORT_FIT_VERSION },
  };
}

// ---------------------------------------------------------------------------
// 子资源（任务 / 项目 / 子代理 / 洞察 / 日历 / 通知）
// ---------------------------------------------------------------------------

export async function buildTasks(options = {}) {
  const context = buildContext(options.env ?? process.env, options);
  const rows = taskRows(context.aggregate.tasks, context.aggregate.totals, {
    q: options.q,
    sort: options.sort,
    order: options.order,
    page: options.page,
    pageSize: options.pageSize,
  });
  return { range: context.range, ...rows, items: maskRows(rows.items, context.config) };
}

export async function buildProjects(options = {}) {
  const context = buildContext(options.env ?? process.env, options);
  const items = projectRows(context.aggregate.projects, context.aggregate.totals);
  return { range: context.range, items, total: items.length };
}

export async function buildSubagents(options = {}) {
  const context = buildContext(options.env ?? process.env, options);
  const tree = buildSubagentTree(context.scan.summaries.filter((summary) => context.filter.acceptSummary(summary)));
  return { range: context.range, ...tree };
}

export async function buildInsightsReport(options = {}) {
  const status = await buildStatus(options);
  return { range: status.range, items: status.insights };
}

export async function buildCalendarReport(options = {}) {
  const context = buildContext(options.env ?? process.env, options);
  return buildCalendar({
    summaries: context.scan.summaries,
    month: options.month,
    config: context.config,
    comfortEntries: loadComfort(context.env).entries,
    filter: context.filter,
  });
}

export async function buildNotificationsReport(options = {}) {
  const status = await buildStatus(options);
  return { range: status.range, ...status.notifications };
}

export function markNotificationsRead({ ids = [], all = false } = {}, env = process.env) {
  const state = loadNotificationState(env);
  const next = all ? { read: [...new Set([...state.read, "budget-warn", "budget-critical", "daily-cap", "compaction", "pace-over", "context-high"])] } : { read: [...new Set([...state.read, ...ids])] };
  saveNotificationState(next, env);
  return { ok: true, read: next.read.length };
}

export async function buildHistoryReport(options = {}) {
  const context = buildContext(options.env ?? process.env, options);
  const days = Math.min(400, Math.max(1, Math.round(options.days ?? context.range.days)));
  const list = buildHistory({ summaries: context.scan.summaries, days, config: context.config, comfort: loadComfort(context.env), nowMs: context.nowMs });
  return { range: context.range, days: list };
}

/** 小票（支持按任务/模型筛选）。 */
export async function buildReceipt(options = {}) {
  const context = buildContext(options.env ?? process.env, options);
  const taskSet = typeof options.tasks === "string" && options.tasks.length > 0 ? new Set(options.tasks.split(",")) : null;
  const modelSet = typeof options.models === "string" && options.models.length > 0 ? new Set(options.models.split(",")) : null;
  const rows = [];
  for (const [model, metrics] of context.aggregate.models.entries()) {
    if (modelSet && !modelSet.has(model)) continue;
    rows.push({ label: model, kind: "model", tokens: metrics.totalTokens, costCny: round(metrics.costCny, 4), messages: metrics.messages });
  }
  if (taskSet) {
    for (const task of context.aggregate.tasks.values()) {
      if (!taskSet.has(task.key)) continue;
      rows.push({ label: maskTitle(task.title, context.config), kind: "task", tokens: task.metrics.totalTokens, costCny: round(task.metrics.costCny, 4), messages: task.metrics.messages });
    }
  }
  const totalTokens = rows.reduce((sum, row) => sum + row.tokens, 0);
  const modelCost = rows.reduce((sum, row) => sum + row.costCny, 0);
  const service = estimateServiceFees(context.aggregate.service);
  if (service.requests > 0 || service.failed > 0) {
    rows.push({
      label: `Search/Fetch 服务费（成功 ${service.requests} 次，失败 ${service.failed} 次）`,
      kind: "service",
      tokens: 0,
      costCny: service.costCny,
      messages: service.requests,
    });
  }
  const totalCost = modelCost + service.costCny;
  return {
    title: typeof options.title === "string" && options.title.length > 0 ? options.title : `DSH 驾驶舱 · ${context.range.label}小票`,
    range: context.range,
    lines: rows.sort((a, b) => b.tokens - a.tokens),
    totalTokens,
    totalCostCny: round(totalCost, 4),
    totalModelCostCny: round(modelCost, 4),
    totalServiceFeesCny: round(service.costCny, 4),
    service,
    generatedAt: new Date(context.nowMs).toISOString(),
    notes: ["金额为估算，非账单", "Search/Fetch 按成功调用次数估算（下限）", "任务标题可在设置中打码"],
  };
}

export { buildBackup, restoreBackup, resolveRange, createFilter, aggregateAll, taskKeyOf, stableKey, zeroMetrics, mergeMetrics };
export { percent } from "./math.mjs";
export { DEFAULT_PRICING } from "./pricing.mjs";
