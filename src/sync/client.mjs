/**
 * 团队共享（可选）· Node 侧同步客户端（零依赖，Node ≥22）。
 *
 * 数据边界（与 PRD FR-13 / docs/PRIVACY.md 一致）：
 * - 只构造并上传**聚合快照**：日期级 tokens/成本、模型级聚合、总量、`_ts`；
 * - 绝不包含会话 id、标题、路径、对话正文、工具参数、provider 凭据；
 * - `buildSnapshot()` 用白名单投影（未知字段直接丢弃），`push()` 发送前再次投影 ——
 *   即使调用方误把完整 status 或脏数据传进来，也不会把 L2/L3 数据带到线上。
 *
 * 解耦：本模块不 import `src/core/**`。适配器只接收调用方传入的聚合数据
 * （通常来自 `buildStatus()` 的公开 JSON，见 `buildSnapshotFromStatus()`），
 * 这样核心层不需要为了同步新增导出（详见 docs/SYNC.md「与核心解耦」）。
 */

import { createHash } from "node:crypto";

export const SYNC_SCHEMA_VERSION = 1;
/** 设备令牌：`ccs_` + 43 字符 base64url（256bit），与 Worker 端约定一致。 */
export const TOKEN_PATTERN = /^ccs_[A-Za-z0-9_-]{43}$/;
/** 邀请码：`CCI-` + 16 字符 base64url（96bit）。 */
export const INVITE_PATTERN = /^CCI-[A-Za-z0-9_-]{16}$/;
export const DEFAULT_TIMEOUT_MS = 10_000;
export const DEFAULT_RETRIES = 2;
export const DEFAULT_RETRY_BASE_MS = 300;
/** 设备令牌的环境变量名（核心 config schema 未持久化令牌，见 docs/SYNC.md）。 */
export const SYNC_TOKEN_ENV = "DSH_COCKPIT_SYNC_TOKEN";
export const MAX_SNAPSHOT_DAYS = 400;
export const MAX_SNAPSHOT_MODELS = 100;

/** 客户端本地错误码（服务端稳定错误码会原样透传，如 INVITE_EXPIRED / DEVICE_LIMIT）。 */
export const SYNC_ERROR_CODES = Object.freeze({
  SYNC_DISABLED: "SYNC_DISABLED",
  SYNC_INVALID_ENDPOINT: "SYNC_INVALID_ENDPOINT",
  SYNC_INVALID_TOKEN: "SYNC_INVALID_TOKEN",
  SYNC_INVALID_INVITE: "SYNC_INVALID_INVITE",
  SYNC_INVALID_DEVICE: "SYNC_INVALID_DEVICE",
  SYNC_INVALID_SNAPSHOT: "SYNC_INVALID_SNAPSHOT",
  SYNC_INVALID_DEVICE: "SYNC_INVALID_DEVICE",
  SYNC_INVALID_DISPLAY_NAME: "SYNC_INVALID_DISPLAY_NAME",
  SYNC_INVALID_SETTINGS: "SYNC_INVALID_SETTINGS",
  SYNC_NO_TOKEN: "SYNC_NO_TOKEN",
  SYNC_FETCH_UNAVAILABLE: "SYNC_FETCH_UNAVAILABLE",
  SYNC_NETWORK_ERROR: "SYNC_NETWORK_ERROR",
  SYNC_TIMEOUT: "SYNC_TIMEOUT",
  SYNC_BAD_RESPONSE: "SYNC_BAD_RESPONSE",
  SYNC_HTTP_ERROR: "SYNC_HTTP_ERROR",
});

const SERVER_ERROR_CODES = new Set([
  "INVALID_JSON",
  "INVALID_BODY",
  "INVALID_INVITE",
  "INVITE_INVALID",
  "INVITE_EXPIRED",
  "INVITE_USED",
  "INVALID_DEVICE_ID",
  "INVALID_DISPLAY_NAME",
  "UNAUTHORIZED",
  "INVALID_TOKEN",
  "DEVICE_REVOKED",
  "BOOTSTRAP_DENIED",
  "BOOTSTRAP_DISABLED",
  "OWNER_REQUIRED",
  "DEVICE_NOT_FOUND",
  "CANNOT_REVOKE_SELF",
  "DEVICE_LIMIT",
  "SETTINGS_INVALID",
  "SETTINGS_CONFLICT",
  "TASK_STATS_INVALID",
  "TASKS_INVALID",
  "COMFORT_INVALID",
  "PLAN_INVALID",
  "PLAN_CONFLICT",
  "PLAN_PERSON_DENIED",
  "PLAN_PERSON_UNKNOWN",
  "PLAN_NOT_FOUND",
  "SPACE_NOT_FOUND",
  "SNAPSHOT_INVALID",
  "SNAPSHOT_STALE",
  "PAYLOAD_TOO_LARGE",
  "RATE_LIMITED",
  "RATE_LIMITER_UNAVAILABLE",
  "ORIGIN_NOT_ALLOWED",
  "SERVER_MISCONFIGURED",
  "STORE_UNAVAILABLE",
  "NOT_FOUND",
  "METHOD_NOT_ALLOWED",
  "INTERNAL_ERROR",
]);

const DATE_KEY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const MODEL_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,79}$/;
const DEVICE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,63}$/;

/** 结构化同步错误：稳定 code + 可判定是否值得重试。 */
export class SyncError extends Error {
  /**
   * @param {string} code 稳定错误码（本地 SYNC_* 或服务端 code）
   * @param {string} message 面向人的说明（不包含令牌等机密）
   * @param {{status?: number|null, retryable?: boolean, detail?: unknown, cause?: unknown}} [options]
   */
  constructor(code, message, options = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "SyncError";
    this.code = code;
    this.status = options.status ?? null;
    this.retryable = options.retryable === true;
    this.detail = options.detail ?? null;
  }

  toJSON() {
    return { code: this.code, message: this.message, status: this.status, retryable: this.retryable };
  }
}

// ---------------------------------------------------------------------------
// 基础工具
// ---------------------------------------------------------------------------

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function roundNumber(value, digits = 6) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

/** 聚合数字：有限非负数 → 6 位小数；其他（含 null/缺失）→ null（缺失 ≠ 0）。 */
function aggregateNumber(value) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return null;
  return roundNumber(value);
}

function sumNullable(left, right) {
  if (left === null || left === undefined) return right ?? null;
  if (right === null || right === undefined) return left;
  return roundNumber(left + right);
}

/**
 * 稳定序列化（用于快照哈希去重）：对象键递归排序、数组保序、输出无空白。
 * 必须与 Worker 端 `stableStringify()` 完全一致，否则两端 hash 不可比。
 */
export function stableStringify(value) {
  if (value === null) return "null";
  const type = typeof value;
  if (type === "number") {
    if (!Number.isFinite(value)) throw new TypeError("stableStringify 不支持非有限数字");
    return JSON.stringify(value);
  }
  if (type === "boolean") return value ? "true" : "false";
  if (type === "string") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  if (type === "object") {
    const keys = Object.keys(value).sort();
    const parts = [];
    for (const key of keys) {
      const item = value[key];
      if (item === undefined) continue;
      parts.push(`${JSON.stringify(key)}:${stableStringify(item)}`);
    }
    return `{${parts.join(",")}}`;
  }
  throw new TypeError(`stableStringify 不支持的类型：${type}`);
}

/** 快照内容哈希（SHA-256 hex），用于服务端 payload_hash 去重与本地比对。 */
export function snapshotHash(snapshot) {
  return createHash("sha256").update(stableStringify(snapshot), "utf8").digest("hex");
}

export function isValidToken(value) {
  return typeof value === "string" && TOKEN_PATTERN.test(value);
}

export function isValidInviteCode(value) {
  return typeof value === "string" && INVITE_PATTERN.test(value);
}

// ---------------------------------------------------------------------------
// 快照构造（白名单投影）
// ---------------------------------------------------------------------------

function normalizeGeneratedAt(value) {
  if (value === undefined || value === null || value === "") return new Date().toISOString();
  if (typeof value !== "string" || Number.isNaN(Date.parse(value))) {
    throw new SyncError("SYNC_INVALID_SNAPSHOT", "generatedAt 必须是合法的 ISO-8601 时间字符串");
  }
  return new Date(Date.parse(value)).toISOString();
}

function projectDays(input) {
  if (!Array.isArray(input)) return [];
  const byDate = new Map();
  for (const row of input.slice(0, MAX_SNAPSHOT_DAYS)) {
    if (!isPlainObject(row) || typeof row.date !== "string") continue;
    if (!DATE_KEY_PATTERN.test(row.date) || Number.isNaN(Date.parse(`${row.date}T00:00:00Z`))) continue;
    const tokens = aggregateNumber(row.tokens);
    const costCny = aggregateNumber(row.costCny);
    if (tokens === null && costCny === null) continue;
    const previous = byDate.get(row.date) ?? { date: row.date, tokens: null, costCny: null };
    byDate.set(row.date, {
      date: row.date,
      tokens: sumNullable(previous.tokens, tokens),
      costCny: sumNullable(previous.costCny, costCny),
    });
  }
  return [...byDate.values()].sort((left, right) => left.date.localeCompare(right.date));
}

function projectModels(input) {
  if (!Array.isArray(input)) return [];
  const byModel = new Map();
  for (const row of input.slice(0, MAX_SNAPSHOT_MODELS)) {
    if (!isPlainObject(row) || typeof row.model !== "string") continue;
    const model = row.model.trim();
    if (!MODEL_NAME_PATTERN.test(model)) continue;
    const tokens = aggregateNumber(row.tokens);
    const costCny = aggregateNumber(row.costCny);
    if (tokens === null && costCny === null) continue;
    const previous = byModel.get(model) ?? { model, tokens: null, costCny: null };
    byModel.set(model, {
      model,
      tokens: sumNullable(previous.tokens, tokens),
      costCny: sumNullable(previous.costCny, costCny),
    });
  }
  return [...byModel.values()].sort((left, right) => left.model.localeCompare(right.model));
}

function projectTotals(inputTotals, days) {
  let tokens = isPlainObject(inputTotals) ? aggregateNumber(inputTotals.tokens) : null;
  let costCny = isPlainObject(inputTotals) ? aggregateNumber(inputTotals.costCny) : null;
  if (tokens === null && days.length > 0) {
    const known = days.map((day) => day.tokens).filter((value) => value !== null);
    if (known.length > 0) tokens = roundNumber(known.reduce((sum, value) => sum + value, 0));
  }
  if (costCny === null && days.length > 0) {
    const known = days.map((day) => day.costCny).filter((value) => value !== null);
    if (known.length > 0) costCny = roundNumber(known.reduce((sum, value) => sum + value, 0));
  }
  // 空窗口的聚合合计为 0（这是"确实没有用量"的已知聚合，不是缺失数据）。
  return { tokens: tokens ?? 0, costCny: costCny ?? 0 };
}

/**
 * 构造要同步的聚合快照。输入里的任何非白名单字段（会话 id、标题、路径、对话…）都会被丢弃。
 *
 * @param {{days?: Array<{date: string, tokens?: number|null, costCny?: number|null}>, models?: Array<{model: string, tokens?: number|null, costCny?: number|null}>, totals?: {tokens?: number|null, costCny?: number|null}, generatedAt?: string}} input
 * @returns {{schemaVersion: number, generatedAt: string, _ts: number, days: Array<object>, models: Array<object>, totals: {tokens: number, costCny: number}}}
 */
export function buildSnapshot(input = {}) {
  if (!isPlainObject(input)) throw new SyncError("SYNC_INVALID_SNAPSHOT", "buildSnapshot 需要一个对象参数");
  const generatedAt = normalizeGeneratedAt(input.generatedAt);
  const _ts = Date.parse(generatedAt);
  const days = projectDays(input.days);
  const models = projectModels(input.models);
  return {
    schemaVersion: SYNC_SCHEMA_VERSION,
    generatedAt,
    _ts,
    days,
    models,
    totals: projectTotals(input.totals, days),
  };
}

/**
 * 从 `buildStatus()` 的公开 JSON 直接构造快照（不 import 核心，避免耦合）。
 * 只消费 `history` / `breakdown.models` / `totals` 三处聚合字段。
 */
export function buildSnapshotFromStatus(status, options = {}) {
  if (!isPlainObject(status)) throw new SyncError("SYNC_INVALID_SNAPSHOT", "buildSnapshotFromStatus 需要 status 对象");
  const days = Array.isArray(status.history) ? status.history : [];
  const models = isPlainObject(status.breakdown) && Array.isArray(status.breakdown.models) ? status.breakdown.models : [];
  const totals = {
    tokens: status.totals?.cycleTokens ?? status.totals?.todayTokens,
    costCny: status.totals?.cycleCostCny ?? status.totals?.todayCostCny,
  };
  return buildSnapshot({ days, models, totals, generatedAt: options.generatedAt ?? status.generatedAt });
}

// ---------------------------------------------------------------------------
// 合并远端快照
// ---------------------------------------------------------------------------

function extractSnapshotRow(row) {
  if (!isPlainObject(row)) return null;
  let snapshot = null;
  if (isPlainObject(row.snapshot)) snapshot = row.snapshot;
  else if (isPlainObject(row.payload)) snapshot = row.payload;
  else if (typeof row.payload === "string") {
    try {
      const parsed = JSON.parse(row.payload);
      if (isPlainObject(parsed)) snapshot = parsed;
    } catch {
      return null;
    }
  }
  if (!snapshot && (Array.isArray(row.days) || Array.isArray(row.models) || isPlainObject(row.totals))) snapshot = row;
  if (!snapshot) return null;
  const deviceId =
    (typeof row.deviceId === "string" && row.deviceId) ||
    (typeof row.device === "string" && row.device) ||
    (typeof snapshot.deviceId === "string" && snapshot.deviceId) ||
    null;
  if (!deviceId) return null;
  return {
    deviceId,
    displayName: typeof row.displayName === "string" ? row.displayName : null,
    snapshot,
  };
}

function projectSnapshot(raw) {
  const days = projectDays(raw?.days);
  const models = projectModels(raw?.models);
  const totals = projectTotals(raw?.totals, days);
  const generatedAtInput = typeof raw?.generatedAt === "string" && !Number.isNaN(Date.parse(raw.generatedAt)) ? raw.generatedAt : null;
  let ts = typeof raw?._ts === "number" && Number.isFinite(raw._ts) ? raw._ts : null;
  if (ts === null && generatedAtInput) ts = Date.parse(generatedAtInput);
  if (ts === null || ts < 0) ts = 0;
  return {
    schemaVersion: SYNC_SCHEMA_VERSION,
    generatedAt: generatedAtInput ?? (ts > 0 ? new Date(ts).toISOString() : null),
    _ts: ts,
    days,
    models,
    totals,
  };
}

/**
 * 按设备合并远端快照：同一设备只保留 `_ts` 最大的版本（旧快照不覆盖新快照）。
 * 接受 `GET /v1/snapshots` 返回的行（`{deviceId, ..., snapshot}`）、`{deviceId, payload}`，
 * 或直接传入快照对象数组（需自带 `deviceId`）。
 *
 * @param {Array<object>} snapshots
 * @returns {{byDevice: Record<string, object>, totals: {devices: number, tokens: number, costCny: number}}}
 */
export function mergeRemote(snapshots) {
  const byDevice = {};
  for (const row of Array.isArray(snapshots) ? snapshots : []) {
    const extracted = extractSnapshotRow(row);
    if (!extracted) continue;
    const snapshot = projectSnapshot(extracted.snapshot);
    const previous = byDevice[extracted.deviceId];
    if (previous && snapshot._ts <= previous._ts) continue;
    byDevice[extracted.deviceId] = {
      deviceId: extracted.deviceId,
      displayName: extracted.displayName,
      _ts: snapshot._ts,
      generatedAt: snapshot.generatedAt,
      totals: snapshot.totals,
      days: snapshot.days,
      models: snapshot.models,
    };
  }
  const devices = Object.values(byDevice);
  const totals = { devices: devices.length, tokens: 0, costCny: 0 };
  for (const device of devices) {
    totals.tokens = roundNumber(totals.tokens + device.totals.tokens);
    totals.costCny = roundNumber(totals.costCny + device.totals.costCny);
  }
  return { byDevice, totals };
}

// ---------------------------------------------------------------------------
// HTTP 客户端
// ---------------------------------------------------------------------------

function normalizePositiveInt(value, fallback) {
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

function normalizeNonNegativeInt(value, fallback) {
  return Number.isInteger(value) && value >= 0 ? value : fallback;
}

function normalizeNonNegativeNumber(value, fallback) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : fallback;
}

function normalizeEndpoint(endpoint) {
  if (typeof endpoint !== "string" || !endpoint.trim()) {
    throw new SyncError("SYNC_INVALID_ENDPOINT", "同步端点为空：请设置 config.sync.endpoint 或传入 endpoint");
  }
  let url;
  try {
    url = new URL(endpoint.trim());
  } catch {
    throw new SyncError("SYNC_INVALID_ENDPOINT", "同步端点不是合法 URL");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new SyncError("SYNC_INVALID_ENDPOINT", "同步端点必须使用 https://（本机调试可用 http://）");
  }
  const hostname = url.hostname;
  const loopback = hostname === "127.0.0.1" || hostname === "localhost" || hostname === "::1" || hostname === "[::1]";
  if (url.protocol === "http:" && !loopback) {
    throw new SyncError("SYNC_INVALID_ENDPOINT", "非本机同步端点必须使用 HTTPS，避免令牌明文传输");
  }
  if (url.username || url.password) throw new SyncError("SYNC_INVALID_ENDPOINT", "同步端点不得包含账号密码");
  if (url.search || url.hash) throw new SyncError("SYNC_INVALID_ENDPOINT", "同步端点不得包含查询串或锚点");
  const path = url.pathname === "/" ? "" : url.pathname.replace(/\/+$/, "");
  return `${url.origin}${path}`;
}

function classifyHttpError(status, payload) {
  const serverCode = payload?.error?.code;
  const serverMessage = typeof payload?.error?.message === "string" ? payload.error.message : "";
  const retryable = status === 408 || status === 429 || status >= 500;
  if (typeof serverCode === "string" && SERVER_ERROR_CODES.has(serverCode)) {
    return { code: serverCode, message: serverMessage || `同步服务返回 HTTP ${status}`, retryable };
  }
  const code =
    status === 401
      ? "UNAUTHORIZED"
      : status === 403
        ? "FORBIDDEN"
        : status === 404
          ? "NOT_FOUND"
          : status === 409
            ? "CONFLICT"
            : status === 429
              ? "RATE_LIMITED"
              : status >= 500
                ? "UPSTREAM_ERROR"
                : "SYNC_HTTP_ERROR";
  return { code, message: serverMessage || `同步服务返回 HTTP ${status}`, retryable };
}

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * 创建同步客户端。
 *
 * @param {{endpoint: string, token?: string, fetchImpl?: Function, timeoutMs?: number, retries?: number, retryBaseMs?: number, sleepImpl?: Function}} options
 */
export function createSyncClient(options = {}) {
  const baseUrl = normalizeEndpoint(options.endpoint);
  const fetchImpl = options.fetchImpl ?? (typeof globalThis.fetch === "function" ? globalThis.fetch : null);
  if (typeof fetchImpl !== "function") {
    throw new SyncError("SYNC_FETCH_UNAVAILABLE", "运行环境没有 fetch，请通过 fetchImpl 注入");
  }
  const timeoutMs = normalizePositiveInt(options.timeoutMs, DEFAULT_TIMEOUT_MS);
  const retries = normalizeNonNegativeInt(options.retries, DEFAULT_RETRIES);
  const retryBaseMs = normalizeNonNegativeNumber(options.retryBaseMs, DEFAULT_RETRY_BASE_MS);
  const sleep = typeof options.sleepImpl === "function" ? options.sleepImpl : defaultSleep;

  const state = { token: "" };

  function setToken(value) {
    if (typeof value !== "string") throw new SyncError("SYNC_INVALID_TOKEN", "同步令牌必须是字符串");
    const trimmed = value.trim();
    if (!TOKEN_PATTERN.test(trimmed)) {
      throw new SyncError("SYNC_INVALID_TOKEN", "同步令牌格式无效（应为 ccs_ + 43 字符 base64url）");
    }
    state.token = trimmed;
    return state.token;
  }

  if (options.token !== undefined && options.token !== null && options.token !== "") setToken(options.token);

  async function attemptRequest(url, { method, headers, bodyText }) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response;
    let text;
    try {
      response = await fetchImpl(url, {
        method,
        headers,
        body: bodyText,
        signal: controller.signal,
        redirect: "error",
        credentials: "omit",
        cache: "no-store",
      });
      text = await response.text();
    } catch (cause) {
      if (controller.signal.aborted) {
        throw new SyncError("SYNC_TIMEOUT", `同步请求超时（${timeoutMs}ms）`, { retryable: true, cause });
      }
      throw new SyncError("SYNC_NETWORK_ERROR", `同步请求失败：${cause instanceof Error ? cause.message : String(cause)}`, {
        retryable: true,
        cause,
      });
    } finally {
      clearTimeout(timer);
    }

    let payload = null;
    if (typeof text === "string" && text.trim()) {
      try {
        payload = JSON.parse(text);
      } catch {
        payload = null;
      }
    }
    if (!response.ok) {
      const mapped = classifyHttpError(response.status, payload);
      throw new SyncError(mapped.code, mapped.message, {
        status: response.status,
        retryable: mapped.retryable,
        detail: payload?.error ?? null,
      });
    }
    if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
      throw new SyncError("SYNC_BAD_RESPONSE", "同步服务响应不是合法 JSON 对象", { status: response.status });
    }
    return payload;
  }

  async function request(method, path, { body, authenticated = true, token = null } = {}) {
    const headers = { accept: "application/json" };
    if (body !== undefined) headers["content-type"] = "application/json";
    if (authenticated) {
      const bearer = token ?? state.token;
      if (!bearer) throw new SyncError("SYNC_NO_TOKEN", "缺少同步令牌：请先用邀请码 enroll，或通过 token 传入");
      if (!TOKEN_PATTERN.test(bearer)) {
        throw new SyncError("SYNC_INVALID_TOKEN", "同步令牌格式无效（应为 ccs_ + 43 字符 base64url）");
      }
      headers.authorization = `Bearer ${bearer}`;
    }
    const bodyText = body === undefined ? undefined : JSON.stringify(body);
    let attempt = 0;
    for (;;) {
      try {
        return await attemptRequest(`${baseUrl}${path}`, { method, headers, bodyText });
      } catch (error) {
        if (!(error instanceof SyncError) || error.retryable !== true || attempt >= retries) throw error;
        const delay = retryBaseMs * 2 ** attempt;
        attempt += 1;
        if (delay > 0) await sleep(delay);
      }
    }
  }

  /** 邀请码换令牌；成功后客户端自动采用返回的令牌（可继续 push/pull）。 */
  async function enroll({ inviteCode, displayName, deviceId } = {}) {
    if (typeof inviteCode !== "string" || !INVITE_PATTERN.test(inviteCode.trim())) {
      throw new SyncError("SYNC_INVALID_INVITE", "邀请码格式无效（应为 CCI- + 16 字符 base64url）");
    }
    const payload = await request("POST", "/v1/enroll", {
      authenticated: false,
      body: { inviteCode: inviteCode.trim(), displayName, deviceId },
    });
    const token = typeof payload.token === "string" ? payload.token : "";
    if (!TOKEN_PATTERN.test(token)) throw new SyncError("SYNC_BAD_RESPONSE", "enroll 响应缺少合法设备令牌");
    state.token = token;
    return {
      spaceId: payload.spaceId ?? null,
      deviceId: payload.deviceId ?? null,
      role: payload.role ?? "member",
      displayName: payload.displayName ?? null,
      token,
    };
  }

  /** 上传聚合快照：发送前再投影一次，确保线上 payload 只含白名单字段。 */
  async function push(snapshot) {
    if (!isPlainObject(snapshot)) throw new SyncError("SYNC_INVALID_SNAPSHOT", "push 需要 buildSnapshot() 生成的快照对象");
    const safe = buildSnapshot({
      days: snapshot.days,
      models: snapshot.models,
      totals: snapshot.totals,
      generatedAt: snapshot.generatedAt,
    });
    const payload = await request("POST", "/v1/snapshots", { body: { snapshot: safe } });
    return {
      accepted: payload.accepted === true,
      deduped: payload.deduped === true,
      _ts: typeof payload._ts === "number" ? payload._ts : safe._ts,
      payloadHash: typeof payload.payloadHash === "string" ? payload.payloadHash : snapshotHash(safe),
    };
  }

  /** 拉取本空间全部设备最新快照（含服务端注入的 deviceId / displayName / _ts）。 */
  async function pull() {
    const payload = await request("GET", "/v1/snapshots");
    if (!Array.isArray(payload.snapshots)) throw new SyncError("SYNC_BAD_RESPONSE", "同步服务响应缺少 snapshots 数组");
    return payload.snapshots;
  }

  /** 撤销其他设备（仅 owner；撤销 ≠ 删除历史快照）。 */
  async function revoke(deviceId) {
    if (typeof deviceId !== "string" || !deviceId.trim()) {
      throw new SyncError("SYNC_INVALID_DEVICE", "revoke 需要非空 deviceId");
    }
    const payload = await request("POST", "/v1/devices/revoke", { body: { deviceId: deviceId.trim() } });
    return {
      revoked: payload.revoked === true,
      alreadyRevoked: payload.alreadyRevoked === true,
      deviceId: payload.deviceId ?? deviceId.trim(),
    };
  }

  /** 成员列表（设备即成员）：`{space, self, members, dailyPlan}`。 */
  async function members() {
    const payload = await request("GET", "/v1/members");
    if (!Array.isArray(payload.members)) throw new SyncError("SYNC_BAD_RESPONSE", "同步服务响应缺少 members 数组");
    const members = payload.members;
    return {
      spaceId: payload.spaceId ?? null,
      space: payload.space ?? null,
      self: payload.self ?? null,
      members,
      dailyPlan: payload.dailyPlan ?? null,
      taskStats: payload.taskStats ?? null,
      tasks: payload.tasks ?? null,
      comfort: Array.isArray(payload.comfort) ? payload.comfort : [],
    };
  }

  /** 重命名成员：owner 可改任意成员，member 只能改自己（服务端校验）。 */
  async function renameMember({ deviceId, displayName } = {}) {
    if (typeof deviceId !== "string" || !DEVICE_ID_PATTERN.test(deviceId.trim())) {
      throw new SyncError("SYNC_INVALID_DEVICE", "deviceId 格式无效（3–64 位安全字符）");
    }
    const name = typeof displayName === "string" ? displayName.trim() : "";
    if (!name || name.length > 40) {
      throw new SyncError("SYNC_INVALID_DISPLAY_NAME", "displayName 必须是 1–40 个可见字符");
    }
    const payload = await request("POST", "/v1/members/rename", {
      body: { deviceId: deviceId.trim(), displayName: name },
    });
    return { deviceId: payload.deviceId ?? deviceId.trim(), displayName: payload.displayName ?? name };
  }

  /** 读取空间设置（共享计划）。 */
  async function getSpaceSettings() {
    const payload = await request("GET", "/v1/space/settings");
    return { spaceId: payload.spaceId ?? null, name: payload.name ?? null, settings: payload.settings ?? { plan: null } };
  }

  /** 修改空间设置（仅 owner 服务端放行）：`{spaceName?, plan?}`。 */
  async function saveSpaceSettings({ spaceName, plan } = {}) {
    const body = {};
    if (typeof spaceName === "string" && spaceName.trim()) body.spaceName = spaceName.trim();
    if (plan !== undefined) body.plan = plan;
    if (Object.keys(body).length === 0) {
      throw new SyncError("SYNC_INVALID_SETTINGS", "至少需要 spaceName 或 plan");
    }
    const payload = await request("PUT", "/v1/space/settings", { body });
    return { spaceId: payload.spaceId ?? null, name: payload.name ?? null, settings: payload.settings ?? null };
  }

  /** 读取版本化共享配置（组员↔设备 + 计划参数）。 */
  async function getSharedSettings() {
    const payload = await request("GET", "/v1/shared-settings");
    return {
      spaceId: payload.spaceId ?? null,
      revision: Number.isSafeInteger(payload.revision) ? payload.revision : 0,
      settings: payload.settings ?? null,
    };
  }

  /** 发布版本化共享配置（仅 owner）：`{revision, settings}`，冲突时抛 SETTINGS_CONFLICT。 */
  async function saveSharedSettings({ revision, settings } = {}) {
    if (!Number.isSafeInteger(revision) || revision < 0) {
      throw new SyncError("SYNC_INVALID_SETTINGS", "revision 必须是非负整数");
    }
    if (!isPlainObject(settings)) throw new SyncError("SYNC_INVALID_SETTINGS", "settings 必须是对象");
    const payload = await request("PUT", "/v1/shared-settings", { body: { revision, settings } });
    return { spaceId: payload.spaceId ?? null, revision: payload.revision ?? revision + 1, settings: payload.settings ?? settings };
  }

  /** 上报本设备采用的配置版本（用于提示配置落后）。 */
  async function heartbeat({ configRevision, appVersion } = {}) {
    if (!Number.isSafeInteger(configRevision) || configRevision < 0) {
      throw new SyncError("SYNC_INVALID_SETTINGS", "configRevision 必须是非负整数");
    }
    const payload = await request("POST", "/v1/heartbeat", {
      body: { configRevision, ...(typeof appVersion === "string" ? { appVersion: appVersion.slice(0, 40) } : {}) },
    });
    return { deviceId: payload.deviceId ?? null, configRevision: payload.configRevision ?? configRevision };
  }

  /** 读取/写入每日共享计划（basis + 每人份额 + 风险，独立修订 + CAS）。 */
  async function dailyPlan({ basis, initialRisk = null, change = null } = {}) {
    if (!isPlainObject(basis)) throw new SyncError("SYNC_INVALID_SETTINGS", "dailyPlan 需要 basis 对象");
    const body = { basis };
    if (initialRisk !== null) body.initialRisk = initialRisk;
    if (change !== null) body.change = change;
    const payload = await request("POST", "/v1/daily-plan", { body });
    return { revision: Number.isSafeInteger(payload.revision) ? payload.revision : 0, plan: payload.plan ?? null };
  }

  /** 上报聚合任务统计（每设备每天任务数，不含标题）。 */
  async function taskStats({ days } = {}) {
    if (!Array.isArray(days) || days.length === 0) throw new SyncError("SYNC_INVALID_SNAPSHOT", "taskStats 需要 days 数组");
    const payload = await request("POST", "/v1/task-stats", { body: { days } });
    return { days: Number.isSafeInteger(payload.days) ? payload.days : days.length };
  }

  /** 同步任务摘要（每设备每天；标题是否打码由调用方决定）。 */
  async function taskSummaries({ day, tasks } = {}) {
    if (typeof day !== "string" || !Array.isArray(tasks)) throw new SyncError("SYNC_INVALID_SNAPSHOT", "taskSummaries 需要 {day, tasks}");
    const payload = await request("POST", "/v1/tasks", { body: { day, tasks } });
    return { day: payload.day ?? day, tasks: Number.isSafeInteger(payload.tasks) ? payload.tasks : tasks.length };
  }

  /** 可选同步个人体感（1–5 + 可选备注）。 */
  async function comfort({ day, level, note } = {}) {
    if (!Number.isInteger(level) || level < 1 || level > 5) {
      throw new SyncError("SYNC_INVALID_SETTINGS", "comfort.level 必须是 1–5 的整数");
    }
    const body = { level };
    if (typeof day === "string") body.day = day;
    if (typeof note === "string" && note.trim()) body.note = note.trim().slice(0, 120);
    const payload = await request("POST", "/v1/comfort", { body });
    return { personId: payload.personId ?? null, day: payload.day ?? day ?? null, level: payload.level ?? level };
  }

  /** 生成新邀请码（仅 owner）：`{inviteCode, inviteExpiresAt}`。 */
  async function invite() {
    const payload = await request("POST", "/v1/spaces", { body: {} });
    const inviteCode = typeof payload.inviteCode === "string" ? payload.inviteCode : null;
    if (!inviteCode) throw new SyncError("SYNC_BAD_RESPONSE", "邀请码响应缺少 inviteCode");
    return { spaceId: payload.spaceId ?? null, inviteCode, inviteExpiresAt: payload.inviteExpiresAt ?? null };
  }

  return Object.freeze({
    endpoint: baseUrl,
    getToken: () => state.token,
    setToken,
    enroll,
    push,
    pull,
    revoke,
    invite,
    members,
    renameMember,
    getSpaceSettings,
    saveSpaceSettings,
    getSharedSettings,
    saveSharedSettings,
    heartbeat,
    dailyPlan,
    taskStats,
    taskSummaries,
    comfort,
  });
}

// ---------------------------------------------------------------------------
// 配置集成（默认关闭）
// ---------------------------------------------------------------------------

/** 团队共享默认关闭：只有 `config.sync.enabled === true` 才算启用。 */
export function isSyncEnabled(config) {
  return isPlainObject(config) && isPlainObject(config.sync) && config.sync.enabled === true;
}

/**
 * 从核心 `config` 对象创建客户端；`sync.enabled !== true` 时直接抛 `SYNC_DISABLED`（默认关闭）。
 * 令牌不入 `~/.dsh-cockpit/config.json`：优先用参数 `token`，其次环境变量 `DSH_COCKPIT_SYNC_TOKEN`。
 */
export function createSyncClientFromConfig(config, options = {}) {
  if (!isSyncEnabled(config)) {
    throw new SyncError("SYNC_DISABLED", "团队同步未启用（config.sync.enabled=false，默认关闭）");
  }
  const sourceEnv = options.env ?? (typeof process !== "undefined" ? process.env : undefined);
  const envToken = typeof sourceEnv?.[SYNC_TOKEN_ENV] === "string" ? sourceEnv[SYNC_TOKEN_ENV] : "";
  return createSyncClient({
    ...options,
    endpoint: options.endpoint ?? config.sync.endpoint,
    token: options.token ?? envToken,
  });
}
