/**
 * 官方余额（BALANCE_V1）——唯一允许的显式网络调用（官方 `GET /user/balance`）。
 *
 * 设计要点：
 * - **按需实时**：每次打开/手动刷新都会取最新值；短 TTL（默认 15s）只用于防抖与合并并发请求，
 *   手动刷新（refresh）会绕过 TTL。
 * - **Key 只从环境变量读**：`DEEPSEEK_API_KEY`；不落盘、不日志、不读 DSH 凭据。
 * - **快照只存金额**：{at, currency, total, granted, toppedUp}，用于"官方扣费 vs 本地估算"对账。
 * - **失败降级**：无 Key / 401 / 402 / 超时 / 网络错误都返回结构化错误，不影响其它数据。
 */
import { chmodSync } from "node:fs";
import { readJson, writeJsonAtomic } from "./json.mjs";
import { balancePath } from "./paths.mjs";

export const BALANCE_POLICY_VERSION = "BALANCE_V1";
export const BALANCE_API_URL = "https://api.deepseek.com/user/balance";
export const DEFAULT_BALANCE_TTL_MS = 15_000;
export const DEFAULT_BALANCE_TIMEOUT_MS = 6_000;
export const BALANCE_HISTORY_LIMIT = 500;
export const DEFAULT_RECONCILE_WINDOW_MS = 24 * 3_600_000;
export const MIN_RECONCILE_SPAN_MS = 3_600_000;
export const MAX_RECONCILE_WINDOW_MS = 7 * 24 * 3_600_000;

function numberOrNull(value) {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

export function normalizeBalancePayload(payload) {
  const infos = Array.isArray(payload?.balance_infos) ? payload.balance_infos : [];
  const info = infos.find((item) => item?.currency === "CNY") ?? infos[0] ?? null;
  return {
    isAvailable: payload?.is_available === true,
    currency: typeof info?.currency === "string" ? info.currency : null,
    total: numberOrNull(info?.total_balance),
    granted: numberOrNull(info?.granted_balance),
    toppedUp: numberOrNull(info?.topped_up_balance),
  };
}

/**
 * 调用官方余额接口。任何失败都返回 `{ ok:false, code, message }`，且不包含 Key/请求头。
 * @returns {Promise<{ok:true, isAvailable:boolean, currency:string|null, total:number|null, granted:number|null, toppedUp:number|null, fetchedAt:number} | {ok:false, code:string, message:string}>}
 */
export async function fetchBalance({ env = process.env, fetchImpl = globalThis.fetch, timeoutMs = DEFAULT_BALANCE_TIMEOUT_MS, apiKey } = {}) {
  const key = typeof apiKey === "string" && apiKey.length > 0 ? apiKey : env?.DEEPSEEK_API_KEY;
  if (!key) {
    return { ok: false, code: "BALANCE_NO_API_KEY", message: "未设置 DEEPSEEK_API_KEY（环境变量）" };
  }
  if (typeof fetchImpl !== "function") {
    return { ok: false, code: "BALANCE_NO_FETCH", message: "当前运行环境没有 fetch" };
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(BALANCE_API_URL, {
      method: "GET",
      headers: { Authorization: `Bearer ${key}`, Accept: "application/json" },
      signal: controller.signal,
    });
    if (!response?.ok) {
      const status = response?.status ?? 0;
      const code = status === 401 ? "BALANCE_UNAUTHORIZED" : status === 402 ? "BALANCE_PAYMENT_REQUIRED" : `BALANCE_HTTP_${status || "UNKNOWN"}`;
      return { ok: false, code, message: `官方余额接口返回 HTTP ${status || "?"}` };
    }
    const payload = await response.json();
    return { ok: true, ...normalizeBalancePayload(payload), fetchedAt: Date.now() };
  } catch (error) {
    if (error?.name === "AbortError") {
      return { ok: false, code: "BALANCE_TIMEOUT", message: `官方余额请求超时（>${timeoutMs}ms）` };
    }
    return { ok: false, code: "BALANCE_NETWORK", message: "官方余额接口网络错误" };
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// 快照历史（仅金额与时间；用于对账，不含 Key / 账户标识）
// ---------------------------------------------------------------------------

export function loadBalanceHistory(env = process.env) {
  const { value } = readJson(balancePath(env), null);
  const snapshots = Array.isArray(value?.snapshots) ? value.snapshots : [];
  return {
    version: typeof value?.version === "string" ? value.version : BALANCE_POLICY_VERSION,
    snapshots: snapshots.filter(
      (item) => item && typeof item.at === "number" && Number.isFinite(item.at) && typeof item.total === "number" && Number.isFinite(item.total),
    ),
  };
}

export function appendBalanceSnapshot(env, snapshot, now = Date.now()) {
  if (!snapshot || typeof snapshot.at !== "number") return loadBalanceHistory(env);
  const history = loadBalanceHistory(env);
  const snapshots = history.snapshots;
  const last = snapshots[snapshots.length - 1] ?? null;
  const changed =
    !last ||
    last.total !== snapshot.total ||
    last.granted !== snapshot.granted ||
    last.toppedUp !== snapshot.toppedUp;
  // 值未变化且 60s 内不重复写，避免刷新造成快照膨胀
  if (changed || now - (last?.at ?? 0) >= 60_000) {
    snapshots.push({
      at: snapshot.at,
      currency: snapshot.currency ?? null,
      total: snapshot.total,
      granted: snapshot.granted ?? null,
      toppedUp: snapshot.toppedUp ?? null,
      isAvailable: snapshot.isAvailable === true,
    });
  }
  const cutoff = now - 7 * 24 * 3_600_000;
  const trimmed = snapshots.filter((item) => item.at >= cutoff).slice(-BALANCE_HISTORY_LIMIT);
  const path = balancePath(env);
  writeJsonAtomic(path, { version: BALANCE_POLICY_VERSION, snapshots: trimmed });
  try {
    chmodSync(path, 0o600);
  } catch {
    /* Windows 上 chmod 可能无效；不阻塞 */
  }
  return { version: BALANCE_POLICY_VERSION, snapshots: trimmed };
}

/**
 * 选择对账基线：
 * 1. 优先窗口起点之前的最近快照（full 模式，严格 windowMs）；
 * 2. 若该窗口内没有更早快照，回退到"首个快照"（since-first 模式），
 *    但要求首个快照距今至少 minSpanMs（默认 1 小时），否则不可对账。
 */
export function selectReconcileBaseline({
  snapshots = [],
  windowMs = DEFAULT_RECONCILE_WINDOW_MS,
  minSpanMs = MIN_RECONCILE_SPAN_MS,
  now = Date.now(),
} = {}) {
  const points = snapshots
    .filter((item) => Number.isFinite(item?.at) && Number.isFinite(item?.total))
    .slice()
    .sort((a, b) => a.at - b.at);
  if (points.length === 0) return { baseline: null, mode: null, oldestAt: null };
  const cutoff = now - windowMs;
  const full = points.filter((item) => item.at <= cutoff).pop() ?? null;
  if (full) return { baseline: full, mode: "full", oldestAt: points[0].at };
  const oldest = points[0];
  if (now - oldest.at >= minSpanMs) return { baseline: oldest, mode: "since-first", oldestAt: oldest.at };
  return { baseline: null, mode: null, oldestAt: oldest.at };
}

/**
 * 官方余额 vs 本地估算对账。
 * - baseline：优先 windowMs 前最近快照；没有则回退"首个快照"（since-first，需 ≥1h）；
 * - officialSpend = baseline.total − current.total（为负说明期间有充值，标记 topupDetected）；
 * - localSpendCny 由调用方按 baseline 到现在的窗口聚合（本地成本 + 服务费）。
 */
export function reconcileBalance({
  snapshots = [],
  current = null,
  windowMs = DEFAULT_RECONCILE_WINDOW_MS,
  minSpanMs = MIN_RECONCILE_SPAN_MS,
  now = Date.now(),
  localSpendCny = 0,
} = {}) {
  const points = snapshots
    .filter((item) => Number.isFinite(item?.at) && Number.isFinite(item?.total))
    .slice()
    .sort((a, b) => a.at - b.at);
  const currentPoint =
    current && Number.isFinite(current.total) && typeof current.at === "number"
      ? { at: current.at, total: current.total }
      : points[points.length - 1] ?? null;
  if (!currentPoint) {
    return { available: false, windowMs, note: "暂无余额快照" };
  }
  const selected = selectReconcileBaseline({ snapshots: points, windowMs, minSpanMs, now });
  if (!selected.baseline) {
    return {
      available: false,
      windowMs,
      mode: null,
      currentAt: new Date(currentPoint.at).toISOString(),
      oldestAt: selected.oldestAt === null ? null : new Date(selected.oldestAt).toISOString(),
      note:
        selected.oldestAt === null
          ? "暂无余额快照；打开/刷新仪表盘后开始记录"
          : "首个快照距今不足 1 小时，暂不能对账",
    };
  }
  const round4 = (value) => Math.round(value * 10_000) / 10_000;
  const officialSpend = round4(selected.baseline.total - currentPoint.total);
  const topupDetected = officialSpend < 0;
  const localSpend = round4(localSpendCny);
  const drift = topupDetected ? null : round4(officialSpend - localSpend);
  const windowActualMs = Math.max(0, now - selected.baseline.at);
  return {
    available: true,
    windowMs,
    mode: selected.mode,
    windowActualMs,
    baselineAt: new Date(selected.baseline.at).toISOString(),
    baselineTotal: selected.baseline.total,
    currentAt: new Date(currentPoint.at).toISOString(),
    currentTotal: currentPoint.total,
    officialSpend,
    localSpend,
    drift,
    driftPercent: !topupDetected && officialSpend > 0 && drift !== null ? round4((drift / officialSpend) * 100) : null,
    topupDetected,
    note: topupDetected
      ? "窗口内检测到充值/赠金变化，无法对账"
      : selected.mode === "since-first"
        ? "自首个快照起对账（快照不足完整窗口）；官方余额为账户级口径，本地估算含服务费"
        : "官方余额为账户级口径；本地估算含服务费，按日近似",
  };
}

// ---------------------------------------------------------------------------
// 实时服务：TTL 防抖 + 并发合并 + 快照落盘
// ---------------------------------------------------------------------------

const sharedServices = new Map();

export function createBalanceService({
  env = process.env,
  fetchImpl = globalThis.fetch,
  ttlMs = DEFAULT_BALANCE_TTL_MS,
  timeoutMs = DEFAULT_BALANCE_TIMEOUT_MS,
  now = Date.now,
} = {}) {
  let cached = null;
  let inflight = null;

  async function get({ force = false } = {}) {
    if (!force && cached && now() - cached.at < ttlMs) {
      return { ...cached.value, cached: true, ageMs: now() - cached.at, ttlMs };
    }
    if (inflight) return inflight;
    inflight = (async () => {
      const fetched = await fetchBalance({ env, fetchImpl, timeoutMs });
      const at = now();
      let value;
      if (fetched.ok) {
        appendBalanceSnapshot(env, { at, currency: fetched.currency, total: fetched.total, granted: fetched.granted, toppedUp: fetched.toppedUp, isAvailable: fetched.isAvailable }, at);
        value = {
          enabled: true,
          available: true,
          source: "official-api",
          currency: fetched.currency,
          total: fetched.total,
          granted: fetched.granted,
          toppedUp: fetched.toppedUp,
          isAvailable: fetched.isAvailable,
          fetchedAt: new Date(at).toISOString(),
          policyVersion: BALANCE_POLICY_VERSION,
          error: null,
        };
      } else {
        value = {
          enabled: true,
          available: false,
          source: "official-api",
          fetchedAt: new Date(at).toISOString(),
          policyVersion: BALANCE_POLICY_VERSION,
          error: { code: fetched.code, message: fetched.message },
        };
      }
      cached = { at, value };
      return { ...value, cached: false, ageMs: 0, ttlMs };
    })().finally(() => {
      inflight = null;
    });
    return inflight;
  }

  function invalidate() {
    cached = null;
  }

  return { get, invalidate, ttlMs, timeoutMs };
}

/** 进程内共享（同一 cockpit home 复用，避免同一请求链路重复拉取）。 */
export function getSharedBalanceService(env = process.env, options = {}) {
  const key = `${balancePath(env)}::${options.ttlMs ?? DEFAULT_BALANCE_TTL_MS}`;
  if (!sharedServices.has(key)) {
    sharedServices.set(key, createBalanceService({ env, ...options }));
  }
  return sharedServices.get(key);
}
