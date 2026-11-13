/**
 * 输入校验与安全常量（纯函数，Node 测试可直接覆盖）。
 *
 * 边界原则：
 * - 只接受"聚合快照"：日期级 tokens/成本、模型级聚合、总量、`_ts`；
 * - 白名单校验（而不是黑名单）：未知字段直接 400，避免未来某天把标题/会话 id 带上来；
 * - 缺失数据用 `null` 表达，不补 0（与 `AGENTS.md`「缺失 ≠ 0」一致）。
 */

/** 设备令牌：`ccs_` + 43 字符 base64url（256bit）。 */
export const TOKEN_PATTERN = /^ccs_[A-Za-z0-9_-]{43}$/;
/** 邀请码：`CCI-` + 16 字符 base64url（96bit）。 */
export const INVITE_PATTERN = /^CCI-[A-Za-z0-9_-]{16}$/;
/** 设备 ID：客户端生成的稳定标识（不要求 UUID，但必须可安全出现在 URL/SQL 参数中）。 */
export const DEVICE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,63}$/;

export const SNAPSHOT_SCHEMA_VERSION = 1;
export const INVITE_TTL_MS = 24 * 60 * 60 * 1000;
/** 单空间设备上限（硬上限，配置只能调低不能调高）。 */
export const DEVICE_LIMIT_MAX = 32;
export const MAX_BODY_BYTES = 256 * 1024;
export const MAX_DAYS = 400;
export const MAX_MODELS = 100;
export const MAX_SNAPSHOT_TS_SKEW_MS = 10 * 60 * 1000;

const DATE_KEY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const MODEL_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,79}$/;
const SNAPSHOT_KEYS = new Set(["schemaVersion", "generatedAt", "_ts", "days", "models", "totals"]);
const DAY_KEYS = new Set(["date", "tokens", "costCny"]);
const MODEL_KEYS = new Set(["model", "tokens", "costCny"]);
const TOTALS_KEYS = new Set(["tokens", "costCny"]);

export function isValidToken(value) {
  return typeof value === "string" && TOKEN_PATTERN.test(value);
}

export function isValidInviteCode(value) {
  return typeof value === "string" && INVITE_PATTERN.test(value);
}

export function normalizeDeviceId(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return DEVICE_ID_PATTERN.test(trimmed) ? trimmed : null;
}

export function normalizeDisplayName(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.replace(/[\u0000-\u001f\u007f]/g, "").trim();
  if (!trimmed || trimmed.length > 40) return null;
  return trimmed;
}

export function normalizeSpaceName(value) {
  if (typeof value !== "string") return "shared-team";
  const trimmed = value.replace(/[\u0000-\u001f\u007f]/g, "").trim();
  if (!trimmed) return "shared-team";
  return trimmed.slice(0, 40);
}

/** 空间设备上限：默认 32，`SPACE_DEVICE_LIMIT` 只能调低。 */
export function resolveDeviceLimit(env = {}) {
  const configured = Number.parseInt(env?.SPACE_DEVICE_LIMIT, 10);
  if (!Number.isFinite(configured) || configured < 1) return DEVICE_LIMIT_MAX;
  return Math.min(DEVICE_LIMIT_MAX, configured);
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** 空间设置：目前只允许 `plan`（共享计划），未知字段 400（白名单）。 */
export const SETTINGS_KEYS = new Set(["plan"]);
export const PLAN_KEYS = new Set(["dailyTokenCap", "dayTotalPercent", "note"]);
export const MAX_DAILY_TOKEN_CAP = 1_000_000_000_000;
export const MIN_DAY_TOTAL_PERCENT = 10;
export const MAX_PLAN_NOTE = 200;

/**
 * 规范化空间设置。
 * - `dailyTokenCap`：null（未设置）或 0..1e12 的整数；
 * - `dayTotalPercent`：10..100 的整数，默认 100；
 * - `note`：≤200 字符，去掉控制字符。
 * 缺失值保持 null/默认，不补 0（与「缺失 ≠ 0」一致）。
 */
export function normalizeSpaceSettings(input) {
  if (!isPlainObject(input)) return { ok: false, message: "settings 必须是 JSON 对象" };
  const extra = unknownKey(input, SETTINGS_KEYS);
  if (extra) return { ok: false, message: `settings 含未允许字段：${extra}` };
  const raw = isPlainObject(input.plan) ? input.plan : {};
  const planExtra = unknownKey(raw, PLAN_KEYS);
  if (planExtra) return { ok: false, message: `plan 含未允许字段：${planExtra}` };

  let dailyTokenCap = null;
  if (raw.dailyTokenCap !== undefined && raw.dailyTokenCap !== null) {
    const value = raw.dailyTokenCap;
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > MAX_DAILY_TOKEN_CAP) {
      return { ok: false, message: `dailyTokenCap 必须是 0–${MAX_DAILY_TOKEN_CAP} 的数字或 null` };
    }
    dailyTokenCap = Math.round(value);
  }

  let dayTotalPercent = 100;
  if (raw.dayTotalPercent !== undefined && raw.dayTotalPercent !== null) {
    const value = raw.dayTotalPercent;
    if (typeof value !== "number" || !Number.isFinite(value) || value < MIN_DAY_TOTAL_PERCENT || value > 100) {
      return { ok: false, message: `dayTotalPercent 必须是 ${MIN_DAY_TOTAL_PERCENT}–100 的数字` };
    }
    dayTotalPercent = Math.round(value);
  }

  let note = "";
  if (typeof raw.note === "string") {
    note = raw.note.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, MAX_PLAN_NOTE);
  }

  return { ok: true, settings: { plan: { dailyTokenCap, dayTotalPercent, note } } };
}

// ---------------------------------------------------------------------------
// v2 共享契约：组员 ↔ 多设备、版本化配置、每日共享计划
// ---------------------------------------------------------------------------

export const SHARED_SETTINGS_SCHEMA_VERSION = 2;
export const MAX_GROUPS = 32;
const GROUP_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{1,39}$/;
const SETTINGS_KEYS_V2 = new Set(["schemaVersion", "groups", "plan", "pricing", "costPolicy"]);
const GROUP_KEYS = new Set(["id", "name", "deviceIds"]);
const BASIS_KEYS = new Set(["localDate", "anchorAt", "remainingPercent", "resetsAt"]);
const CHANGE_KEYS = new Set(["kind", "personId", "value", "expectedRevision"]);
const BEIJING_OFFSET_MS = 8 * 3_600_000;
const DAY_MS = 86_400_000;

function beijingDateKey(ms) {
  return new Date(ms + BEIJING_OFFSET_MS).toISOString().slice(0, 10);
}

function normalizePercentValue(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 100 ? value : null;
}

/**
 * 版本化共享配置（owner 发布）：
 * { schemaVersion:2, groups:[{id,name,deviceIds[]}], plan:{dailyTokenCap,dayTotalPercent,note} }
 * 同一设备只能属于一个组员；未知字段 400。
 */
export function normalizeSharedSettings(input) {
  if (!isPlainObject(input)) return { ok: false, message: "settings 必须是 JSON 对象" };
  const extra = unknownKey(input, SETTINGS_KEYS_V2);
  if (extra) return { ok: false, message: `settings 含未允许字段：${extra}` };
  if (input.schemaVersion !== undefined && input.schemaVersion !== SHARED_SETTINGS_SCHEMA_VERSION) {
    return { ok: false, message: `schemaVersion 必须为 ${SHARED_SETTINGS_SCHEMA_VERSION}` };
  }

  const groupsRaw = input.groups === undefined ? [] : input.groups;
  if (!Array.isArray(groupsRaw)) return { ok: false, message: "groups 必须是数组" };
  if (groupsRaw.length > MAX_GROUPS) return { ok: false, message: `组员数不能超过 ${MAX_GROUPS}` };

  const seenGroupIds = new Set();
  const seenDevices = new Set();
  const groups = [];
  for (let index = 0; index < groupsRaw.length; index += 1) {
    const raw = groupsRaw[index];
    if (!isPlainObject(raw)) return { ok: false, message: `groups[${index}] 必须是对象` };
    const extraGroup = unknownKey(raw, GROUP_KEYS);
    if (extraGroup) return { ok: false, message: `groups[${index}] 含未允许字段：${extraGroup}` };
    if (typeof raw.id !== "string" || !GROUP_ID_PATTERN.test(raw.id)) {
      return { ok: false, message: `groups[${index}].id 必须是 2–40 位安全字符` };
    }
    if (seenGroupIds.has(raw.id)) return { ok: false, message: `groups[${index}].id 重复` };
    seenGroupIds.add(raw.id);
    const name = normalizeDisplayName(raw.name);
    if (!name) return { ok: false, message: `groups[${index}].name 必须是 1–40 个可见字符` };
    const deviceIdsRaw = raw.deviceIds === undefined ? [] : raw.deviceIds;
    if (!Array.isArray(deviceIdsRaw)) return { ok: false, message: `groups[${index}].deviceIds 必须是数组` };
    if (deviceIdsRaw.length > DEVICE_LIMIT_MAX) return { ok: false, message: `groups[${index}].deviceIds 超过上限` };
    const deviceIds = [];
    for (const deviceId of deviceIdsRaw) {
      if (typeof deviceId !== "string" || !DEVICE_ID_PATTERN.test(deviceId)) {
        return { ok: false, message: `groups[${index}].deviceIds 含非法设备 ID` };
      }
      if (seenDevices.has(deviceId)) return { ok: false, message: `设备 ${deviceId} 被分配给了多个组员` };
      seenDevices.add(deviceId);
      deviceIds.push(deviceId);
    }
    groups.push({ id: raw.id, name, deviceIds });
  }

  const planChecked = normalizeSpaceSettings({ plan: input.plan });
  if (!planChecked.ok) return planChecked;

  // 共享价格表（owner 发布，设备可 adopt；对齐 Codex 的共享价格契约）
  const pricing = {};
  if (input.pricing !== undefined) {
    if (!isPlainObject(input.pricing)) return { ok: false, message: "pricing 必须是对象" };
    const entries = Object.entries(input.pricing);
    if (entries.length > 64) return { ok: false, message: "pricing 模型数不能超过 64" };
    for (const [model, price] of entries) {
      if (!MODEL_NAME_PATTERN.test(model)) return { ok: false, message: "pricing 含非法模型名" };
      if (!isPlainObject(price)) return { ok: false, message: `pricing.${model} 必须是对象` };
      const entry = {};
      for (const key of ["input", "cacheHit", "cacheWrite", "output"]) {
        if (price[key] === undefined) continue;
        const value = price[key];
        if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1_000_000) {
          return { ok: false, message: `pricing.${model}.${key} 必须是 0–1e6 的数字` };
        }
        entry[key] = value;
      }
      if (Object.keys(entry).length === 0) return { ok: false, message: `pricing.${model} 至少需要一个价格字段` };
      pricing[model] = entry;
    }
  }
  const costPolicy = typeof input.costPolicy === "string"
    ? input.costPolicy.replace(/[\u0000-\u001f\u007f]/g, "").slice(0, 40)
    : "local";

  return {
    ok: true,
    settings: {
      schemaVersion: SHARED_SETTINGS_SCHEMA_VERSION,
      groups,
      plan: planChecked.settings.plan,
      pricing,
      costPolicy,
    },
  };
}

/** 每日计划基线：本地日期、锚点、剩余百分比、重置时间（同一北京日期）。 */
export function normalizeDailyPlanBasis(input, now = Date.now()) {
  if (!isPlainObject(input)) return { ok: false, message: "basis 必须是对象" };
  const extra = unknownKey(input, BASIS_KEYS);
  if (extra) return { ok: false, message: `basis 含未允许字段：${extra}` };
  if (typeof input.localDate !== "string" || !DATE_KEY_PATTERN.test(input.localDate)) {
    return { ok: false, message: "basis.localDate 必须是 YYYY-MM-DD" };
  }
  if (input.localDate !== beijingDateKey(now)) return { ok: false, message: "basis.localDate 不是今天（北京时间）" };
  const remaining = normalizePercentValue(input.remainingPercent);
  if (remaining === null) return { ok: false, message: "basis.remainingPercent 必须是 0–100" };
  const anchorMs = Date.parse(input.anchorAt);
  const resetMs = Date.parse(input.resetsAt);
  if (!Number.isFinite(anchorMs)) return { ok: false, message: "basis.anchorAt 必须是时间字符串" };
  if (!Number.isFinite(resetMs)) return { ok: false, message: "basis.resetsAt 必须是时间字符串" };
  if (anchorMs > now + 300_000) return { ok: false, message: "basis.anchorAt 不能超前" };
  if (beijingDateKey(anchorMs) !== input.localDate) return { ok: false, message: "basis.anchorAt 必须与 localDate 同一天" };
  if (resetMs <= now) return { ok: false, message: "basis.resetsAt 必须晚于当前" };
  if (resetMs > now + 8 * DAY_MS) return { ok: false, message: "basis.resetsAt 不能超过 8 天" };
  return {
    ok: true,
    basis: {
      localDate: input.localDate,
      anchorAt: new Date(anchorMs).toISOString(),
      remainingPercent: remaining,
      resetsAt: new Date(resetMs).toISOString(),
    },
  };
}

/** 计划变更：person（需 personId）/ risk；value 为 null 或 0–100；expectedRevision 必填。 */
export function normalizePlanChange(input) {
  if (!isPlainObject(input)) return { ok: false, message: "change 必须是对象" };
  const extra = unknownKey(input, CHANGE_KEYS);
  if (extra) return { ok: false, message: `change 含未允许字段：${extra}` };
  if (input.kind !== "person" && input.kind !== "risk") return { ok: false, message: "change.kind 必须是 person 或 risk" };
  const value = input.value === null ? null : normalizePercentValue(input.value);
  if (input.value !== null && value === null) return { ok: false, message: "change.value 必须是 0–100 或 null" };
  if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0) {
    return { ok: false, message: "change.expectedRevision 必须是非负整数" };
  }
  let personId = null;
  if (input.kind === "person") {
    if (typeof input.personId !== "string" || !GROUP_ID_PATTERN.test(input.personId)) {
      return { ok: false, message: "change.personId 必须是合法组员 ID" };
    }
    personId = input.personId;
  }
  return { ok: true, change: { kind: input.kind, personId, value, expectedRevision: input.expectedRevision } };
}

/** 聚合任务统计：只允许日期级任务数量（不含标题）。 */
export function normalizeTaskStats(input) {
  if (!isPlainObject(input)) return { ok: false, message: "task-stats 必须是对象" };
  if (!Array.isArray(input.days)) return { ok: false, message: "days 必须是数组" };
  if (input.days.length > MAX_DAYS) return { ok: false, message: `days 不能超过 ${MAX_DAYS}` };
  const days = [];
  const seen = new Set();
  for (let index = 0; index < input.days.length; index += 1) {
    const row = input.days[index];
    if (!isPlainObject(row)) return { ok: false, message: `days[${index}] 必须是对象` };
    if (typeof row.date !== "string" || !DATE_KEY_PATTERN.test(row.date) || Number.isNaN(Date.parse(`${row.date}T00:00:00Z`))) {
      return { ok: false, message: `days[${index}].date 必须是合法 YYYY-MM-DD` };
    }
    if (seen.has(row.date)) return { ok: false, message: `days[${index}].date 重复` };
    seen.add(row.date);
    if (!Number.isSafeInteger(row.tasks) || row.tasks < 0 || row.tasks > 10_000) {
      return { ok: false, message: `days[${index}].tasks 必须是 0–10000 的整数` };
    }
    days.push({ date: row.date, tasks: row.tasks });
  }
  if (days.length === 0) return { ok: false, message: "days 不能为空" };
  return { ok: true, days };
}

/** 舒适度同步：等级 1–5 + 可选备注（≤120 字符）；日期默认今天（北京）。 */
export function normalizeComfort(input, now = Date.now()) {
  if (!isPlainObject(input)) return { ok: false, message: "comfort 必须是对象" };
  const level = input.level;
  if (!Number.isInteger(level) || level < 1 || level > 5) return { ok: false, message: "level 必须是 1–5 的整数" };
  const day = input.day === undefined ? beijingDateKey(now) : input.day;
  if (typeof day !== "string" || !DATE_KEY_PATTERN.test(day)) return { ok: false, message: "day 必须是 YYYY-MM-DD" };
  const note = typeof input.note === "string" ? input.note.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 120) : "";
  return { ok: true, value: { level, day, note } };
}

/** 任务摘要（对齐 Codex task sync）：标题可选（本机决定是否打码），不含会话正文/工具参数。 */
export function normalizeTaskSummaries(input) {
  if (!isPlainObject(input)) return { ok: false, message: "tasks 必须是对象" };
  if (typeof input.day !== "string" || !DATE_KEY_PATTERN.test(input.day) || Number.isNaN(Date.parse(`${input.day}T00:00:00Z`))) {
    return { ok: false, message: "day 必须是合法 YYYY-MM-DD" };
  }
  if (!Array.isArray(input.tasks)) return { ok: false, message: "tasks 必须是数组" };
  if (input.tasks.length > 200) return { ok: false, message: "tasks 不能超过 200 条" };
  const seen = new Set();
  const tasks = [];
  for (let index = 0; index < input.tasks.length; index += 1) {
    const row = input.tasks[index];
    if (!isPlainObject(row)) return { ok: false, message: `tasks[${index}] 必须是对象` };
    if (typeof row.key !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/.test(row.key)) {
      return { ok: false, message: `tasks[${index}].key 非法` };
    }
    if (seen.has(row.key)) return { ok: false, message: `tasks[${index}].key 重复` };
    seen.add(row.key);
    const title = typeof row.title === "string" ? row.title.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 120) : "";
    const tokens = row.tokens === null || row.tokens === undefined ? null : (typeof row.tokens === "number" && Number.isFinite(row.tokens) && row.tokens >= 0 ? Math.round(row.tokens) : NaN);
    const costCny = row.costCny === null || row.costCny === undefined ? null : (typeof row.costCny === "number" && Number.isFinite(row.costCny) && row.costCny >= 0 ? Math.round(row.costCny * 1e6) / 1e6 : NaN);
    const lastAt = row.lastAt === null || row.lastAt === undefined ? null : (Number.isSafeInteger(row.lastAt) && row.lastAt > 0 ? row.lastAt : NaN);
    if (Number.isNaN(tokens) || Number.isNaN(costCny) || Number.isNaN(lastAt)) {
      return { ok: false, message: `tasks[${index}] 的 tokens/costCny/lastAt 非法` };
    }
    tasks.push({ key: row.key, title, tokens, costCny, lastAt });
  }
  return { ok: true, day: input.day, tasks };
}

/** 聚合数字：有限非负数 → 保留 6 位小数；其他（含 null/缺失）→ null。 */
function aggregateNumber(value) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return null;
  return Math.round(value * 1e6) / 1e6;
}

function unknownKey(object, allowedKeys) {
  for (const key of Object.keys(object)) {
    if (!allowedKeys.has(key)) return key;
  }
  return null;
}

function validateDayRow(row, index) {
  if (!isPlainObject(row)) return { ok: false, message: `days[${index}] 必须是对象` };
  const extra = unknownKey(row, DAY_KEYS);
  if (extra) return { ok: false, message: `days[${index}] 含未允许字段：${extra}` };
  if (typeof row.date !== "string" || !DATE_KEY_PATTERN.test(row.date) || Number.isNaN(Date.parse(`${row.date}T00:00:00Z`))) {
    return { ok: false, message: `days[${index}].date 必须是 YYYY-MM-DD` };
  }
  const tokens = aggregateNumber(row.tokens);
  const costCny = aggregateNumber(row.costCny);
  if (tokens === null && costCny === null) return { ok: false, message: `days[${index}] 缺少 tokens/costCny` };
  return { ok: true, value: { date: row.date, tokens, costCny } };
}

function validateModelRow(row, index) {
  if (!isPlainObject(row)) return { ok: false, message: `models[${index}] 必须是对象` };
  const extra = unknownKey(row, MODEL_KEYS);
  if (extra) return { ok: false, message: `models[${index}] 含未允许字段：${extra}` };
  if (typeof row.model !== "string" || !MODEL_NAME_PATTERN.test(row.model)) {
    return { ok: false, message: `models[${index}].model 必须是 1–80 位模型名` };
  }
  const tokens = aggregateNumber(row.tokens);
  const costCny = aggregateNumber(row.costCny);
  if (tokens === null && costCny === null) return { ok: false, message: `models[${index}] 缺少 tokens/costCny` };
  return { ok: true, value: { model: row.model, tokens, costCny } };
}

/**
 * 校验并规范化快照。成功返回 `{ok:true, snapshot}`（只含白名单字段的副本）；
 * 失败返回 `{ok:false, code, message}`，message 绝不会回显字段值（避免把敏感内容带进日志/响应）。
 */
export function validateSnapshot(input) {
  if (!isPlainObject(input)) return { ok: false, message: "快照必须是 JSON 对象" };
  const extra = unknownKey(input, SNAPSHOT_KEYS);
  if (extra) return { ok: false, message: `快照含未允许字段：${extra}` };
  if (input.schemaVersion !== SNAPSHOT_SCHEMA_VERSION) {
    return { ok: false, message: `schemaVersion 必须为 ${SNAPSHOT_SCHEMA_VERSION}` };
  }
  if (typeof input.generatedAt !== "string" || Number.isNaN(Date.parse(input.generatedAt))) {
    return { ok: false, message: "generatedAt 必须是 ISO-8601 时间字符串" };
  }
  if (!Number.isSafeInteger(input._ts) || input._ts <= 0) {
    return { ok: false, message: "_ts 必须是正整数的 epoch 毫秒" };
  }
  if (!Array.isArray(input.days) || input.days.length > MAX_DAYS) {
    return { ok: false, message: `days 必须是不超过 ${MAX_DAYS} 项的数组` };
  }
  if (!Array.isArray(input.models) || input.models.length > MAX_MODELS) {
    return { ok: false, message: `models 必须是不超过 ${MAX_MODELS} 项的数组` };
  }
  const days = [];
  for (let index = 0; index < input.days.length; index += 1) {
    const checked = validateDayRow(input.days[index], index);
    if (!checked.ok) return { ok: false, message: checked.message };
    days.push(checked.value);
  }
  const models = [];
  for (let index = 0; index < input.models.length; index += 1) {
    const checked = validateModelRow(input.models[index], index);
    if (!checked.ok) return { ok: false, message: checked.message };
    models.push(checked.value);
  }
  if (!isPlainObject(input.totals)) return { ok: false, message: "totals 必须是对象" };
  const extraTotals = unknownKey(input.totals, TOTALS_KEYS);
  if (extraTotals) return { ok: false, message: `totals 含未允许字段：${extraTotals}` };
  const totals = {
    tokens: aggregateNumber(input.totals.tokens),
    costCny: aggregateNumber(input.totals.costCny),
  };
  if (totals.tokens === null && totals.costCny === null) {
    return { ok: false, message: "totals 至少需要 tokens 或 costCny" };
  }
  return {
    ok: true,
    snapshot: {
      schemaVersion: SNAPSHOT_SCHEMA_VERSION,
      generatedAt: new Date(input.generatedAt).toISOString(),
      _ts: input._ts,
      days,
      models,
      totals,
    },
  };
}
