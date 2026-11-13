/**
 * DSH 驾驶舱 · 可选团队共享同步 Worker
 * Cloudflare Workers（ESM）+ D1，零运行时依赖。
 *
 * 路由（全部返回 JSON，错误带稳定 code）：
 * - `POST /v1/spaces`          bootstrap secret 创建空间；Bearer owner 令牌 → 生成新邀请码
 * - `POST /v1/enroll`          邀请码换设备令牌（单次使用 / 24h 过期 / ≤32 设备）
 * - `POST /v1/snapshots`       上传本设备聚合快照（payload_hash 去重 + `_ts` 单调守卫）
 * - `GET  /v1/snapshots`       拉取本空间全部设备的最新快照
 * - `POST /v1/devices/revoke`  仅 owner 可撤销其他设备
 * - `GET  /v1/members`         成员列表 + 各设备最新快照摘要
 * - `POST /v1/members/rename`  重命名成员（owner 或本人）
 * - `GET  /v1/space/settings`  空间设置（共享计划）只读
 * - `PUT  /v1/space/settings`  仅 owner 可改空间设置
 *
 * 安全基线（fail-closed）：
 * - 令牌只存 SHA-256；`ccs_` + 43 字符 base64url 格式校验；
 * - 缺 `AUTH_RATE_LIMITER` / `API_RATE_LIMITER` 绑定 → 503，不降级放行；
 * - CORS 仅允许 `ALLOWED_ORIGIN` 中配置的来源；
 * - 所有 SQL 走 D1 prepare/bind 参数化；
 * - 快照按白名单校验（未知字段 400），从协议层阻止会话 id / 标题 / 路径 / 对话外泄。
 *
 * 测试友好：业务逻辑在 `handleRequest(request, env)` 中，`env.DB` 既可传 D1 绑定，
 * 也可传 `createMemoryStore()` 返回的内存适配器，因此 Node `node --test` 可直接覆盖，无需 wrangler。
 */

import {
  constantTimeEqual,
  randomId,
  randomInviteCode,
  randomToken,
  sha256Hex,
  stableStringify,
} from "./crypto.mjs";
import {
  INVITE_TTL_MS,
  MAX_BODY_BYTES,
  MAX_SNAPSHOT_TS_SKEW_MS,
  isValidInviteCode,
  isValidToken,
  normalizeComfort,
  normalizeDailyPlanBasis,
  normalizeDeviceId,
  normalizeDisplayName,
  normalizePlanChange,
  normalizeSharedSettings,
  normalizeSpaceName,
  normalizeSpaceSettings,
  normalizeTaskStats,
  normalizeTaskSummaries,
  resolveDeviceLimit,
  validateSnapshot,
} from "./validation.mjs";
import { createD1Store, createMemoryStore } from "./store.mjs";

export { createD1Store, createMemoryStore } from "./store.mjs";
export { randomInviteCode, randomToken, sha256Hex, stableStringify } from "./crypto.mjs";
export {
  DEVICE_LIMIT_MAX,
  INVITE_PATTERN,
  INVITE_TTL_MS,
  MAX_DAILY_TOKEN_CAP,
  MAX_GROUPS,
  SETTINGS_KEYS,
  SHARED_SETTINGS_SCHEMA_VERSION,
  TOKEN_PATTERN,
  isValidInviteCode,
  isValidToken,
  normalizeDailyPlanBasis,
  normalizePlanChange,
  normalizeSharedSettings,
  normalizeSpaceSettings,
  resolveDeviceLimit,
  validateSnapshot,
} from "./validation.mjs";

export const WORKER_NAME = "dsh-cockpit-usage-sync";
export const WORKER_VERSION = "1.5.0";

const KNOWN_PATHS = new Set([
  "/v1/spaces",
  "/v1/enroll",
  "/v1/snapshots",
  "/v1/devices/revoke",
  "/v1/members",
  "/v1/members/rename",
  "/v1/space/settings",
  "/v1/shared-settings",
  "/v1/heartbeat",
  "/v1/daily-plan",
  "/v1/task-stats",
  "/v1/comfort",
  "/v1/tasks",
]);

// ---------------------------------------------------------------------------
// 通用工具
// ---------------------------------------------------------------------------

function iso(ms) {
  return new Date(ms).toISOString();
}

function errorBody(code, message) {
  return { ok: false, error: { code, message } };
}

function jsonResponse(status, payload, extraHeaders = {}) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      ...extraHeaders,
    },
  });
}

function nowMs(env) {
  return typeof env?.NOW === "number" && Number.isFinite(env.NOW) ? env.NOW : Date.now();
}

function clientIp(request) {
  const direct = request.headers.get("cf-connecting-ip");
  if (direct) return direct;
  const forwarded = request.headers.get("x-forwarded-for") ?? "";
  return forwarded.split(",")[0].trim() || "unknown";
}

function parseAllowedOrigins(value) {
  if (typeof value !== "string" || !value.trim()) return null;
  const origins = value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  return origins.length > 0 ? origins : null;
}

/** CORS：只回显配置白名单内的 Origin；配置缺失视为部署错误（fail-closed）。 */
function resolveCors(request, env) {
  const allowed = parseAllowedOrigins(env?.ALLOWED_ORIGIN);
  if (!allowed) {
    return { ok: false, status: 503, code: "SERVER_MISCONFIGURED", message: "未配置 ALLOWED_ORIGIN，服务拒绝处理（fail-closed）" };
  }
  const origin = request.headers.get("origin");
  if (origin && !allowed.includes(origin)) {
    return { ok: false, status: 403, code: "ORIGIN_NOT_ALLOWED", message: "请求来源不在 CORS 白名单" };
  }
  const headers = origin
    ? {
        "access-control-allow-origin": origin,
        "access-control-allow-methods": "GET, POST, OPTIONS",
        "access-control-allow-headers": "authorization, content-type, x-bootstrap-secret",
        "access-control-max-age": "600",
        vary: "Origin",
      }
    : {};
  return { ok: true, headers };
}

/** 免费计划降级：显式 `ALLOW_NO_RATE_LIMITER=1` 时允许缺失限流绑定（仅跳过限流，其余校验不变）。 */
function allowNoRateLimiter(env) {
  const value = env?.ALLOW_NO_RATE_LIMITER;
  return value === "1" || value === "true" || value === true;
}

function checkBindings(env) {
  const auth = env?.AUTH_RATE_LIMITER;
  const api = env?.API_RATE_LIMITER;
  const hasAuth = Boolean(auth) && typeof auth.limit === "function";
  const hasApi = Boolean(api) && typeof api.limit === "function";
  if (hasAuth && hasApi) return { ok: true, degraded: false };
  if (allowNoRateLimiter(env) && !hasAuth && !hasApi) {
    // 免费计划（无 rate limit 绑定）：限流整体降级；认证/校验/存储校验仍然生效。
    return { ok: true, degraded: true };
  }
  return {
    ok: false,
    status: 503,
    code: "RATE_LIMITER_UNAVAILABLE",
    message: "限流绑定缺失（AUTH_RATE_LIMITER / API_RATE_LIMITER），服务拒绝处理（fail-closed）",
  };
}

/** env.DB：可传 D1 绑定，也可传内存适配器（测试/本地）。 */
function resolveStore(env) {
  const db = env?.DB;
  if (!db) return null;
  if (typeof db.getMemberByTokenHash === "function") return db;
  if (typeof db.prepare === "function") return createD1Store(db);
  return null;
}

async function enforceRateLimit(limiter, key) {
  // 免费计划降级模式：limiter 缺失时直接放行（checkBindings 已确认用户显式开启降级）
  if (!limiter || typeof limiter.limit !== "function") return { ok: true, skipped: true };
  try {
    const result = await limiter.limit({ key });
    if (result && result.success === false) {
      return { ok: false, status: 429, code: "RATE_LIMITED", message: "请求过于频繁，请稍后再试" };
    }
    return { ok: true };
  } catch {
    return { ok: false, status: 503, code: "RATE_LIMITER_UNAVAILABLE", message: "限流服务异常，服务拒绝处理（fail-closed）" };
  }
}

async function readJsonObject(request) {
  let text;
  try {
    text = await request.text();
  } catch {
    return { ok: false, status: 400, code: "INVALID_BODY", message: "请求体读取失败" };
  }
  if (new TextEncoder().encode(text).length > MAX_BODY_BYTES) {
    return { ok: false, status: 413, code: "PAYLOAD_TOO_LARGE", message: `请求体超过 ${MAX_BODY_BYTES} 字节上限` };
  }
  if (!text.trim()) return { ok: true, value: {} };
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    return { ok: false, status: 400, code: "INVALID_JSON", message: "请求体不是合法 JSON" };
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, status: 400, code: "INVALID_BODY", message: "请求体必须是 JSON 对象" };
  }
  return { ok: true, value };
}

function replyOk(ctx, status, body) {
  return jsonResponse(status, { ok: true, ...body, serverTime: iso(ctx.now) }, ctx.cors);
}

function replyError(ctx, status, code, message) {
  return jsonResponse(status, errorBody(code, message), ctx.cors);
}

async function issueInvite(store, spaceId, now) {
  const code = randomInviteCode();
  const inviteHash = await sha256Hex(code);
  const expiresAt = now + INVITE_TTL_MS;
  await store.issueInvite(spaceId, { inviteHash, expiresAt });
  return { code, expiresAt };
}

// ---------------------------------------------------------------------------
// 鉴权（Bearer + 限流 + 撤销检查）
// ---------------------------------------------------------------------------

async function authenticate(ctx) {
  const { request, env, store } = ctx;
  const header = request.headers.get("authorization") ?? "";
  const match = /^Bearer\s+(\S+)$/i.exec(header.trim());
  if (!match) return { ok: false, status: 401, code: "UNAUTHORIZED", message: "缺少 Bearer 令牌" };
  const token = match[1];
  if (!isValidToken(token)) {
    return { ok: false, status: 401, code: "INVALID_TOKEN", message: "令牌格式无效（ccs_ + 43 字符 base64url）" };
  }
  const tokenHash = await sha256Hex(token);
  const limited = await enforceRateLimit(env.API_RATE_LIMITER, `token:${tokenHash}`);
  if (!limited.ok) return limited;
  const member = await store.getMemberByTokenHash(tokenHash);
  if (!member) return { ok: false, status: 401, code: "UNAUTHORIZED", message: "令牌无效或已轮换" };
  if (member.revokedAt !== null && member.revokedAt !== undefined) {
    return { ok: false, status: 401, code: "DEVICE_REVOKED", message: "设备已被撤销，令牌已失效" };
  }
  const space = await store.getSpace(member.spaceId);
  if (!space) return { ok: false, status: 401, code: "UNAUTHORIZED", message: "令牌对应的空间不存在" };
  return { ok: true, member, space, tokenHash };
}

// ---------------------------------------------------------------------------
// 路由处理器
// ---------------------------------------------------------------------------

/** POST /v1/spaces：bootstrap secret 创建空间；Bearer owner 令牌生成新邀请码。 */
async function handleCreateSpace(ctx) {
  const { request, env, store, now } = ctx;
  const authorization = request.headers.get("authorization");
  if (authorization) {
    const auth = await authenticate(ctx);
    if (!auth.ok) return replyError(ctx, auth.status, auth.code, auth.message);
    if (auth.member.role !== "owner") return replyError(ctx, 403, "OWNER_REQUIRED", "仅 owner 可生成邀请码");
    const invite = await issueInvite(store, auth.member.spaceId, now);
    return replyOk(ctx, 200, {
      spaceId: auth.member.spaceId,
      inviteCode: invite.code,
      inviteExpiresAt: iso(invite.expiresAt),
    });
  }

  const bootstrapSecret = typeof env?.BOOTSTRAP_SECRET === "string" ? env.BOOTSTRAP_SECRET : "";
  if (bootstrapSecret.length < 16) {
    return replyError(ctx, 503, "BOOTSTRAP_DISABLED", "未配置 BOOTSTRAP_SECRET（≥16 字符），空间创建已禁用（fail-closed）");
  }
  if (!constantTimeEqual(request.headers.get("x-bootstrap-secret") ?? "", bootstrapSecret)) {
    return replyError(ctx, 401, "BOOTSTRAP_DENIED", "bootstrap secret 无效");
  }
  const limited = await enforceRateLimit(env.AUTH_RATE_LIMITER, `bootstrap:${clientIp(request)}`);
  if (!limited.ok) return replyError(ctx, limited.status, limited.code, limited.message);

  const body = await readJsonObject(request);
  if (!body.ok) return replyError(ctx, body.status, body.code, body.message);
  const displayName = normalizeDisplayName(body.value.displayName);
  if (!displayName) return replyError(ctx, 400, "INVALID_DISPLAY_NAME", "displayName 必须是 1–40 个可见字符");
  const deviceId = normalizeDeviceId(body.value.deviceId);
  if (!deviceId) return replyError(ctx, 400, "INVALID_DEVICE_ID", "deviceId 必须是 3–64 位安全字符（字母/数字/._:-）");

  const spaceName = normalizeSpaceName(body.value.spaceName);
  const spaceId = randomId("spc");
  const token = randomToken();
  const tokenHash = await sha256Hex(token);
  const deviceLimit = resolveDeviceLimit(env);

  await store.createSpace({ id: spaceId, name: spaceName, createdAt: now });
  const added = await store.addMember({
    id: randomId("mem"),
    spaceId,
    deviceId,
    displayName,
    role: "owner",
    tokenHash,
    createdAt: now,
    deviceLimit,
  });
  if (!added.ok) return replyError(ctx, 409, "DEVICE_LIMIT", "设备数已达上限");
  const invite = await issueInvite(store, spaceId, now);
  return replyOk(ctx, 201, {
    space: { id: spaceId, name: spaceName },
    deviceId,
    displayName,
    role: "owner",
    token,
    inviteCode: invite.code,
    inviteExpiresAt: iso(invite.expiresAt),
  });
}

/** POST /v1/enroll：邀请码换设备令牌（单次使用，24h 过期）。 */
async function handleEnroll(ctx) {
  const { request, env, store, now } = ctx;
  const limited = await enforceRateLimit(env.AUTH_RATE_LIMITER, `enroll:${clientIp(request)}`);
  if (!limited.ok) return replyError(ctx, limited.status, limited.code, limited.message);

  const body = await readJsonObject(request);
  if (!body.ok) return replyError(ctx, body.status, body.code, body.message);
  const inviteCode = body.value.inviteCode;
  if (!isValidInviteCode(inviteCode)) {
    return replyError(ctx, 400, "INVALID_INVITE", "邀请码格式无效（CCI- + 16 字符 base64url）");
  }
  const displayName = normalizeDisplayName(body.value.displayName);
  if (!displayName) return replyError(ctx, 400, "INVALID_DISPLAY_NAME", "displayName 必须是 1–40 个可见字符");
  const deviceId = normalizeDeviceId(body.value.deviceId);
  if (!deviceId) return replyError(ctx, 400, "INVALID_DEVICE_ID", "deviceId 必须是 3–64 位安全字符（字母/数字/._:-）");

  const inviteHash = await sha256Hex(inviteCode);
  const space = await store.findSpaceByInviteHash(inviteHash);
  if (!space) return replyError(ctx, 410, "INVITE_INVALID", "邀请码无效或已被使用");
  if (space.inviteUsedAt !== null && space.inviteUsedAt !== undefined) {
    return replyError(ctx, 410, "INVITE_USED", "邀请码已被使用（单次有效）");
  }
  if (!(space.inviteExpiresAt > now)) return replyError(ctx, 410, "INVITE_EXPIRED", "邀请码已过期（有效期 24h）");

  const deviceLimit = resolveDeviceLimit(env);
  const existing = await store.getMember(space.id, deviceId);
  const isActive = existing !== null && existing.revokedAt === null;
  if (!isActive && (await store.countActiveDevices(space.id)) >= deviceLimit) {
    return replyError(ctx, 409, "DEVICE_LIMIT", `空间设备数已达上限（${deviceLimit}）`);
  }
  if (!(await store.consumeInvite(space.id, inviteHash, now))) {
    return replyError(ctx, 410, "INVITE_INVALID", "邀请码无效或已被使用");
  }

  const token = randomToken();
  const tokenHash = await sha256Hex(token);
  const added = await store.addMember({
    id: randomId("mem"),
    spaceId: space.id,
    deviceId,
    displayName,
    role: "member",
    tokenHash,
    createdAt: now,
    deviceLimit,
  });
  if (!added.ok) return replyError(ctx, 409, "DEVICE_LIMIT", `空间设备数已达上限（${deviceLimit}）`);
  return replyOk(ctx, 200, {
    spaceId: space.id,
    deviceId,
    displayName,
    role: added.member.role,
    token,
  });
}

/** POST /v1/snapshots：上传本设备聚合快照（哈希去重 + `_ts` 单调守卫）。 */
async function handlePushSnapshot(ctx) {
  const { request, store, now } = ctx;
  const auth = await authenticate(ctx);
  if (!auth.ok) return replyError(ctx, auth.status, auth.code, auth.message);

  const body = await readJsonObject(request);
  if (!body.ok) return replyError(ctx, body.status, body.code, body.message);
  let candidate = body.value;
  if (Object.prototype.hasOwnProperty.call(body.value, "snapshot")) {
    if (Object.keys(body.value).length !== 1) {
      return replyError(ctx, 400, "INVALID_BODY", "带 snapshot 包装时不得包含其他字段");
    }
    candidate = body.value.snapshot;
  }
  const checked = validateSnapshot(candidate);
  if (!checked.ok) return replyError(ctx, 400, "SNAPSHOT_INVALID", checked.message);
  const snapshot = checked.snapshot;
  if (snapshot._ts > now + MAX_SNAPSHOT_TS_SKEW_MS) {
    return replyError(ctx, 400, "SNAPSHOT_INVALID", "快照 _ts 超前服务器时间过多，请检查设备时钟");
  }

  const payload = JSON.stringify(snapshot);
  const payloadHash = await sha256Hex(stableStringify(snapshot));
  const result = await store.upsertSnapshot({
    spaceId: auth.member.spaceId,
    deviceId: auth.member.deviceId,
    payload,
    payloadHash,
    ts: snapshot._ts,
    updatedAt: now,
  });
  if (result.status === "stale") {
    return replyError(ctx, 409, "SNAPSHOT_STALE", "快照 _ts 不新于服务器已存版本，拒绝覆盖");
  }
  return replyOk(ctx, 200, {
    accepted: result.status !== "deduped",
    deduped: result.status === "deduped",
    _ts: result.ts,
    payloadHash,
  });
}

/** GET /v1/snapshots：拉取本空间全部设备的最新快照。 */
async function handlePullSnapshots(ctx) {
  const auth = await authenticate(ctx);
  if (!auth.ok) return replyError(ctx, auth.status, auth.code, auth.message);
  const rows = await ctx.store.listSnapshots(auth.member.spaceId);
  const snapshots = [];
  for (const row of rows) {
    let snapshot;
    try {
      snapshot = JSON.parse(row.payload);
    } catch {
      continue; // 手工改库导致的坏行直接跳过，不让整个空间拉取失败
    }
    snapshots.push({
      deviceId: row.deviceId,
      displayName: row.displayName,
      role: row.role,
      revoked: row.revoked === true,
      _ts: row.ts,
      updatedAt: iso(row.updatedAt),
      snapshot,
    });
  }
  return replyOk(ctx, 200, { spaceId: auth.member.spaceId, snapshots });
}

/** POST /v1/devices/revoke：仅 owner 可撤销其他设备（撤销 ≠ 删除历史快照）。 */
async function handleRevokeDevice(ctx) {
  const { request, store, now } = ctx;
  const auth = await authenticate(ctx);
  if (!auth.ok) return replyError(ctx, auth.status, auth.code, auth.message);
  if (auth.member.role !== "owner") return replyError(ctx, 403, "OWNER_REQUIRED", "仅 owner 可撤销其他设备");

  const body = await readJsonObject(request);
  if (!body.ok) return replyError(ctx, body.status, body.code, body.message);
  const deviceId = normalizeDeviceId(body.value.deviceId);
  if (!deviceId) return replyError(ctx, 400, "INVALID_DEVICE_ID", "deviceId 必须是 3–64 位安全字符（字母/数字/._:-）");
  if (deviceId === auth.member.deviceId) {
    return replyError(ctx, 400, "CANNOT_REVOKE_SELF", "owner 不能通过该接口撤销自己（避免空间失联）");
  }
  const target = await store.getMember(auth.member.spaceId, deviceId);
  if (!target) return replyError(ctx, 404, "DEVICE_NOT_FOUND", "空间内不存在该设备");
  if (target.revokedAt !== null) {
    return replyOk(ctx, 200, { revoked: false, alreadyRevoked: true, deviceId });
  }
  const revoked = await store.revokeMember(auth.member.spaceId, deviceId, now);
  if (!revoked) return replyOk(ctx, 200, { revoked: false, alreadyRevoked: true, deviceId });
  return replyOk(ctx, 200, { revoked: true, alreadyRevoked: false, deviceId, revokedAt: iso(now) });
}

/** 快照摘要：只投影日级/总量，不返回 payload 原文（避免未来字段外泄）。 */
function summarizeSnapshotRow(row) {
  try {
    const parsed = JSON.parse(row.payload);
    const days = Array.isArray(parsed.days) ? parsed.days : [];
    return {
      generatedAt: typeof parsed.generatedAt === "string" ? parsed.generatedAt : null,
      _ts: typeof parsed._ts === "number" ? parsed._ts : row.ts,
      updatedAt: iso(row.updatedAt),
      totals: parsed.totals ?? null,
      lastDay: days.length > 0 ? days[days.length - 1] : null,
    };
  } catch {
    return null;
  }
}

/** GET /v1/members：成员列表 + 各设备最新快照摘要 + 版本化共享配置 + 今日计划。 */
async function handleListMembers(ctx) {
  const auth = await authenticate(ctx);
  if (!auth.ok) return replyError(ctx, auth.status, auth.code, auth.message);
  const spaceId = auth.member.spaceId;
  const today = new Date(ctx.now + 8 * 3_600_000).toISOString().slice(0, 10);
  const [members, rows, legacySettings, shared, plan, taskRows, comfortRows, taskSummaryRows] = await Promise.all([
    ctx.store.listMembers(spaceId),
    ctx.store.listSnapshots(spaceId),
    ctx.store.getSpaceSettings(spaceId),
    ctx.store.getSharedSettings(spaceId),
    ctx.store.getLatestDailyPlan(spaceId, today),
    ctx.store.listTaskStats(spaceId, today),
    ctx.store.listComfort(spaceId, today),
    ctx.store.listTaskSummaries(spaceId, today),
  ]);
  const taskByDevice = new Map(taskRows.map((row) => [row.deviceId, row.tasks]));
  const taskSummaries = taskSummaryRows.map((row) => ({ ...row }));
  const taskCountByDevice = new Map();
  for (const row of taskSummaries) taskCountByDevice.set(row.deviceId, (taskCountByDevice.get(row.deviceId) ?? 0) + 1);
  const byDevice = new Map(rows.map((row) => [row.deviceId, row]));
  const settings = shared?.settings ?? {
    schemaVersion: 2,
    groups: [],
    plan: legacySettings?.plan ?? null,
  };
  const revision = shared?.revision ?? 0;
  return replyOk(ctx, 200, {
    spaceId,
    space: {
      name: auth.space.name,
      plan: settings.plan ?? null,
      settingsRevision: revision,
      settings,
    },
    self: auth.member.deviceId,
    dailyPlan: plan ? { revision: plan.revision, value: plan.value } : null,
    taskStats: { day: today, byDevice: Object.fromEntries(taskByDevice) },
    tasks: { day: today, rows: taskSummaries },
    comfort: comfortRows.map((row) => ({ personId: row.personId, day: row.day, level: row.level, note: row.note, revision: row.revision })),
    members: members.map((member) => {
      const row = byDevice.get(member.deviceId) ?? null;
      const syncInfo = member.syncInfo ?? null;
      return {
        deviceId: member.deviceId,
        displayName: member.displayName,
        role: member.role,
        isSelf: member.deviceId === auth.member.deviceId,
        createdAt: iso(member.createdAt),
        lastSeenAt: member.lastSeenAt ? iso(member.lastSeenAt) : null,
        heartbeatAt: member.heartbeatAt ? iso(member.heartbeatAt) : null,
        revokedAt: member.revokedAt ? iso(member.revokedAt) : null,
        syncInfo,
        configStale: syncInfo === null ? null : Number(syncInfo.configRevision ?? -1) !== revision,
        todayTasks: taskCountByDevice.has(member.deviceId) ? taskCountByDevice.get(member.deviceId) : taskByDevice.has(member.deviceId) ? taskByDevice.get(member.deviceId) : null,
        snapshot: row ? summarizeSnapshotRow(row) : null,
      };
    }),
  });
}

/** POST /v1/members/rename：owner 可改任意成员，member 只能改自己。 */
async function handleRenameMember(ctx) {
  const auth = await authenticate(ctx);
  if (!auth.ok) return replyError(ctx, auth.status, auth.code, auth.message);
  const body = await readJsonObject(ctx.request);
  if (!body.ok) return replyError(ctx, body.status, body.code, body.message);
  const deviceId = normalizeDeviceId(body.value.deviceId);
  if (!deviceId) return replyError(ctx, 400, "INVALID_DEVICE_ID", "deviceId 必须是 3–64 位安全字符（字母/数字/._:-）");
  const displayName = normalizeDisplayName(body.value.displayName);
  if (!displayName) return replyError(ctx, 400, "INVALID_DISPLAY_NAME", "displayName 必须是 1–40 个可见字符");
  if (deviceId !== auth.member.deviceId && auth.member.role !== "owner") {
    return replyError(ctx, 403, "OWNER_REQUIRED", "仅 owner 可重命名其他成员");
  }
  const target = await ctx.store.getMember(auth.member.spaceId, deviceId);
  if (!target) return replyError(ctx, 404, "DEVICE_NOT_FOUND", "空间内不存在该设备");
  if (target.revokedAt !== null) return replyError(ctx, 409, "DEVICE_REVOKED", "目标设备已撤销");
  const renamed = await ctx.store.renameMember(auth.member.spaceId, deviceId, displayName);
  if (!renamed) return replyError(ctx, 404, "DEVICE_NOT_FOUND", "空间内不存在该设备");
  return replyOk(ctx, 200, { deviceId, displayName });
}

/** GET /v1/space/settings：空间设置（共享计划）只读。 */
async function handleGetSpaceSettings(ctx) {
  const auth = await authenticate(ctx);
  if (!auth.ok) return replyError(ctx, auth.status, auth.code, auth.message);
  const settings = await ctx.store.getSpaceSettings(auth.member.spaceId);
  return replyOk(ctx, 200, { spaceId: auth.member.spaceId, name: auth.space.name, settings: settings ?? { plan: null } });
}

/** PUT /v1/space/settings：仅 owner；body `{ spaceName?, plan: { dailyTokenCap, dayTotalPercent, note } }`。 */
async function handlePutSpaceSettings(ctx) {
  const auth = await authenticate(ctx);
  if (!auth.ok) return replyError(ctx, auth.status, auth.code, auth.message);
  if (auth.member.role !== "owner") return replyError(ctx, 403, "OWNER_REQUIRED", "仅 owner 可修改空间设置");
  const body = await readJsonObject(ctx.request);
  if (!body.ok) return replyError(ctx, body.status, body.code, body.message);
  for (const key of Object.keys(body.value)) {
    if (key !== "spaceName" && key !== "plan") {
      return replyError(ctx, 400, "INVALID_BODY", `settings 请求含未允许字段：${key}`);
    }
  }
  const checked = normalizeSpaceSettings({ plan: body.value.plan });
  if (!checked.ok) return replyError(ctx, 400, "SETTINGS_INVALID", checked.message);
  const name = body.value.spaceName !== undefined ? normalizeSpaceName(body.value.spaceName) : "";
  const saved = await ctx.store.saveSpaceSettings(auth.member.spaceId, checked.settings, name);

  // 同步写入版本化 shared_settings.plan（保持单一来源；冲突时重试一次，仍失败则保留 legacy 写入）
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const shared = await ctx.store.getSharedSettings(auth.member.spaceId);
    const current = shared?.settings ?? { schemaVersion: 2, groups: [], plan: null };
    const merged = { ...current, plan: checked.settings.plan };
    const written = await ctx.store.saveSharedSettings(auth.member.spaceId, {
      expectedRevision: shared?.revision ?? 0,
      settings: merged,
    });
    if (written.ok) break;
    if (!written.conflict) break;
  }

  return replyOk(ctx, 200, {
    spaceId: auth.member.spaceId,
    name: name || auth.space.name,
    settings: saved ?? checked.settings,
  });
}

/** GET /v1/shared-settings：版本化共享配置（组员↔设备、计划参数），任何成员可读。 */
async function handleGetSharedSettings(ctx) {
  const auth = await authenticate(ctx);
  if (!auth.ok) return replyError(ctx, auth.status, auth.code, auth.message);
  const [shared, legacy] = await Promise.all([
    ctx.store.getSharedSettings(auth.member.spaceId),
    ctx.store.getSpaceSettings(auth.member.spaceId),
  ]);
  return replyOk(ctx, 200, {
    spaceId: auth.member.spaceId,
    revision: shared?.revision ?? 0,
    settings: shared?.settings ?? {
      schemaVersion: 2,
      groups: [],
      plan: legacy?.plan ?? null,
    },
  });
}

/** PUT /v1/shared-settings：仅 owner 发布；revision 不匹配 → 409（绝不静默覆盖）。 */
async function handlePutSharedSettings(ctx) {
  const auth = await authenticate(ctx);
  if (!auth.ok) return replyError(ctx, auth.status, auth.code, auth.message);
  if (auth.member.role !== "owner") return replyError(ctx, 403, "OWNER_REQUIRED", "仅 owner 可发布共享配置");
  const body = await readJsonObject(ctx.request);
  if (!body.ok) return replyError(ctx, body.status, body.code, body.message);
  if (!Number.isSafeInteger(body.value.revision) || body.value.revision < 0) {
    return replyError(ctx, 400, "INVALID_BODY", "revision 必须是非负整数");
  }
  const checked = normalizeSharedSettings(body.value.settings);
  if (!checked.ok) return replyError(ctx, 400, "SETTINGS_INVALID", checked.message);
  const saved = await ctx.store.saveSharedSettings(auth.member.spaceId, {
    expectedRevision: body.value.revision,
    settings: checked.settings,
  });
  if (!saved.ok) {
    if (saved.conflict) return replyError(ctx, 409, "SETTINGS_CONFLICT", "共享配置已被其他设备更新，请拉取后重试");
    return replyError(ctx, 404, "SPACE_NOT_FOUND", "空间不存在");
  }
  return replyOk(ctx, 200, { spaceId: auth.member.spaceId, revision: saved.revision, settings: checked.settings });
}

/** POST /v1/heartbeat：设备上报"采用的配置版本"，用于提示配置落后。 */
async function handleHeartbeat(ctx) {
  const auth = await authenticate(ctx);
  if (!auth.ok) return replyError(ctx, auth.status, auth.code, auth.message);
  const body = await readJsonObject(ctx.request);
  if (!body.ok) return replyError(ctx, body.status, body.code, body.message);
  const configRevision = body.value.configRevision;
  if (!Number.isSafeInteger(configRevision) || configRevision < 0) {
    return replyError(ctx, 400, "INVALID_BODY", "configRevision 必须是非负整数");
  }
  const appVersion = typeof body.value.appVersion === "string" ? body.value.appVersion.replace(/[\u0000-\u001f\u007f]/g, "").slice(0, 40) : null;
  const ok = await ctx.store.setMemberSyncInfo(
    auth.member.spaceId,
    auth.member.deviceId,
    { configRevision, appVersion, reportedAt: iso(ctx.now) },
    ctx.now,
  );
  if (!ok) return replyError(ctx, 404, "DEVICE_NOT_FOUND", "空间内不存在该设备");
  return replyOk(ctx, 200, { deviceId: auth.member.deviceId, configRevision });
}

/**
 * POST /v1/daily-plan：每日共享计划（对齐 Codex Cockpit）。
 * body：{ basis, initialRisk?, change?: { kind: person|risk, personId?, value, expectedRevision } }
 * - 首次写入 seed 当日计划（basis 由首个设备提供）；
 * - person/risk 修订号独立；行级 CAS，冲突 409；
 * - person 只能改"设备列表包含自己"的组员；risk 任何成员可改。
 */
async function handleDailyPlan(ctx) {
  const auth = await authenticate(ctx);
  if (!auth.ok) return replyError(ctx, auth.status, auth.code, auth.message);
  const body = await readJsonObject(ctx.request);
  if (!body.ok) return replyError(ctx, body.status, body.code, body.message);

  const basisChecked = normalizeDailyPlanBasis(body.value.basis, ctx.now);
  if (!basisChecked.ok) return replyError(ctx, 400, "PLAN_INVALID", basisChecked.message);
  const basis = basisChecked.basis;
  const initialRisk = body.value.initialRisk === undefined || body.value.initialRisk === null ? null : body.value.initialRisk;
  if (initialRisk !== null && !(typeof initialRisk === "number" && Number.isFinite(initialRisk) && initialRisk >= 0 && initialRisk <= 100)) {
    return replyError(ctx, 400, "PLAN_INVALID", "initialRisk 必须是 0–100 或 null");
  }

  let row = await ctx.store.insertDailyPlanIfAbsent(auth.member.spaceId, basis.localDate, basis.resetsAt, {
    basis,
    people: {},
    risk: { value: initialRisk, revision: 0 },
  });
  if (body.value.change === undefined || body.value.change === null) {
    return replyOk(ctx, 200, { revision: row.revision, plan: row.value });
  }

  const changeChecked = normalizePlanChange(body.value.change);
  if (!changeChecked.ok) return replyError(ctx, 400, "PLAN_INVALID", changeChecked.message);
  const change = changeChecked.change;

  for (let attempt = 0; attempt < 4; attempt += 1) {
    if (attempt > 0) {
      const fresh = await ctx.store.getDailyPlan(auth.member.spaceId, basis.localDate, basis.resetsAt);
      if (!fresh) return replyError(ctx, 404, "PLAN_NOT_FOUND", "当日计划不存在");
      row = fresh;
    }
    const plan = structuredClone(row.value);
    let field;
    if (change.kind === "person") {
      const shared = await ctx.store.getSharedSettings(auth.member.spaceId);
      const groups = shared?.settings?.groups ?? [];
      const group = groups.find((item) => item.id === change.personId);
      if (!group) return replyError(ctx, 404, "PLAN_PERSON_UNKNOWN", "组员不存在");
      if (!Array.isArray(group.deviceIds) || !group.deviceIds.includes(auth.member.deviceId)) {
        return replyError(ctx, 403, "PLAN_PERSON_DENIED", "只能修改自己设备所属组员的计划");
      }
      field = plan.people[change.personId] ?? { value: null, revision: 0 };
    } else {
      field = plan.risk ?? { value: null, revision: 0 };
    }
    if (field.revision !== change.expectedRevision) {
      return replyError(ctx, 409, "PLAN_CONFLICT", "计划已被其他设备更新，请刷新后重试");
    }
    const updated = { value: change.value, revision: field.revision + 1 };
    if (change.kind === "person") plan.people[change.personId] = updated;
    else plan.risk = updated;
    const saved = await ctx.store.updateDailyPlanCas(
      auth.member.spaceId,
      basis.localDate,
      basis.resetsAt,
      plan,
      row.revision,
    );
    if (saved.ok) return replyOk(ctx, 200, { revision: saved.revision, plan });
    if (!saved.conflict) return replyError(ctx, 404, "PLAN_NOT_FOUND", "当日计划不存在");
  }
  return replyError(ctx, 409, "PLAN_CONFLICT", "并发冲突，请重试");
}

/** POST /v1/task-stats：只上报"每设备每天任务数量"（不含标题）。 */
async function handleTaskStats(ctx) {
  const auth = await authenticate(ctx);
  if (!auth.ok) return replyError(ctx, auth.status, auth.code, auth.message);
  const body = await readJsonObject(ctx.request);
  if (!body.ok) return replyError(ctx, body.status, body.code, body.message);
  const checked = normalizeTaskStats(body.value);
  if (!checked.ok) return replyError(ctx, 400, "TASK_STATS_INVALID", checked.message);
  await ctx.store.upsertTaskStats(auth.member.spaceId, auth.member.deviceId, checked.days, ctx.now);
  return replyOk(ctx, 200, { days: checked.days.length });
}

/** POST /v1/tasks：同步任务摘要（每设备每天；标题是否打码由本机决定）。 */
async function handleTaskSummaries(ctx) {
  const auth = await authenticate(ctx);
  if (!auth.ok) return replyError(ctx, auth.status, auth.code, auth.message);
  const body = await readJsonObject(ctx.request);
  if (!body.ok) return replyError(ctx, body.status, body.code, body.message);
  const checked = normalizeTaskSummaries(body.value);
  if (!checked.ok) return replyError(ctx, 400, "TASKS_INVALID", checked.message);
  await ctx.store.upsertTaskSummaries(auth.member.spaceId, auth.member.deviceId, checked.day, checked.tasks, ctx.now);
  return replyOk(ctx, 200, { day: checked.day, tasks: checked.tasks.length });
}

/** POST /v1/comfort：可选同步个人体感（1–5 + 可选备注），归属到设备所在组员。 */
async function handleComfort(ctx) {
  const auth = await authenticate(ctx);
  if (!auth.ok) return replyError(ctx, auth.status, auth.code, auth.message);
  const body = await readJsonObject(ctx.request);
  if (!body.ok) return replyError(ctx, body.status, body.code, body.message);
  const checked = normalizeComfort(body.value, ctx.now);
  if (!checked.ok) return replyError(ctx, 400, "COMFORT_INVALID", checked.message);
  const shared = await ctx.store.getSharedSettings(auth.member.spaceId);
  const groups = shared?.settings?.groups ?? [];
  const group = groups.find((item) => Array.isArray(item.deviceIds) && item.deviceIds.includes(auth.member.deviceId));
  const personId = group?.id ?? auth.member.deviceId;
  const saved = await ctx.store.upsertComfort(
    auth.member.spaceId,
    personId,
    checked.value.day,
    checked.value.level,
    checked.value.note,
    ctx.now,
  );
  return replyOk(ctx, 200, { personId, day: saved.day, level: saved.level, revision: saved.revision });
}

// ---------------------------------------------------------------------------
// 入口
// ---------------------------------------------------------------------------

/**
 * 纯函数式请求处理器：Node 测试直接传入 `new Request(...)` 与 `env`（env.DB 可为内存适配器）。
 * @param {Request} request
 * @param {{DB?: unknown, BOOTSTRAP_SECRET?: string, ALLOWED_ORIGIN?: string, AUTH_RATE_LIMITER?: {limit: Function}, API_RATE_LIMITER?: {limit: Function}, SPACE_DEVICE_LIMIT?: string|number, NOW?: number}} env
 * @returns {Promise<Response>}
 */
export async function handleRequest(request, env = {}) {
  let cors = {};
  try {
    const corsResult = resolveCors(request, env);
    if (!corsResult.ok) return jsonResponse(corsResult.status, errorBody(corsResult.code, corsResult.message), {});
    cors = corsResult.headers;

    if (request.method.toUpperCase() === "OPTIONS") {
      return new Response(null, { status: 204, headers: cors });
    }
    const bindings = checkBindings(env);
    if (!bindings.ok) return jsonResponse(bindings.status, errorBody(bindings.code, bindings.message), cors);
    if (bindings.degraded) cors = { ...cors, "x-cockpit-degraded": "no-rate-limiter" };

    const store = resolveStore(env);
    if (!store) {
      return jsonResponse(503, errorBody("STORE_UNAVAILABLE", "D1 绑定（DB）缺失或非法"), cors);
    }

    const url = new URL(request.url);
    const path = url.pathname.length > 1 ? url.pathname.replace(/\/+$/, "") : url.pathname;
    const ctx = { request, env, store, now: nowMs(env), cors };
    const method = request.method.toUpperCase();

    if (path === "/v1/spaces" && method === "POST") return await handleCreateSpace(ctx);
    if (path === "/v1/enroll" && method === "POST") return await handleEnroll(ctx);
    if (path === "/v1/snapshots" && method === "POST") return await handlePushSnapshot(ctx);
    if (path === "/v1/snapshots" && method === "GET") return await handlePullSnapshots(ctx);
    if (path === "/v1/devices/revoke" && method === "POST") return await handleRevokeDevice(ctx);
    if (path === "/v1/members" && method === "GET") return await handleListMembers(ctx);
    if (path === "/v1/members/rename" && method === "POST") return await handleRenameMember(ctx);
    if (path === "/v1/space/settings" && method === "GET") return await handleGetSpaceSettings(ctx);
    if (path === "/v1/space/settings" && method === "PUT") return await handlePutSpaceSettings(ctx);
    if (path === "/v1/shared-settings" && method === "GET") return await handleGetSharedSettings(ctx);
    if (path === "/v1/shared-settings" && method === "PUT") return await handlePutSharedSettings(ctx);
    if (path === "/v1/heartbeat" && method === "POST") return await handleHeartbeat(ctx);
    if (path === "/v1/daily-plan" && method === "POST") return await handleDailyPlan(ctx);
    if (path === "/v1/task-stats" && method === "POST") return await handleTaskStats(ctx);
    if (path === "/v1/comfort" && method === "POST") return await handleComfort(ctx);
    if (path === "/v1/tasks" && method === "POST") return await handleTaskSummaries(ctx);
    if (KNOWN_PATHS.has(path)) {
      return jsonResponse(405, errorBody("METHOD_NOT_ALLOWED", `不支持的方法：${method}`), cors);
    }
    return jsonResponse(404, errorBody("NOT_FOUND", "路由不存在"), cors);
  } catch {
    // 绝不回显内部异常详情（可能含 SQL 片段/令牌），只返回稳定错误码。
    return jsonResponse(500, errorBody("INTERNAL_ERROR", "服务器内部错误"), cors);
  }
}

export default {
  async fetch(request, env) {
    return handleRequest(request, env);
  },
};
