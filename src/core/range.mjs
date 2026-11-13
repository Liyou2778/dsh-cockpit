/**
 * 统计范围解析（API v2）。
 * range: cycle | today | 7d | 30d | 90d | all | custom
 * 日期边界一律按"使用日"（dayStartHour 换日，Asia/Shanghai）对齐。
 */
import { cycleBounds, cycleDateKey, beijingDateKey, DAY_START_HOUR_DEFAULT } from "./time.mjs";

export const RANGE_KINDS = Object.freeze(["cycle", "today", "7d", "30d", "90d", "all", "custom"]);
const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;

function dayStartMs(dateKey, dayStartHour) {
  // dateKey 形如 2026-11-03；使用日 04:00 = 该日 04:00 北京时间
  const [year, month, day] = dateKey.split("-").map(Number);
  return Date.UTC(year, month - 1, day, dayStartHour) - 8 * HOUR_MS;
}

function dateKeyToMs(dateKey) {
  const [year, month, day] = dateKey.split("-").map(Number);
  return Date.UTC(year, month - 1, day, 12) - 8 * HOUR_MS;
}

export function isValidDateKey(value) {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(`${value}T12:00:00+08:00`));
}

/**
 * @param {{range?: string, from?: string, to?: string, nowMs?: number, config: object, earliestMs?: number|null}} options
 * @returns {{kind:string, startMs:number, endMs:number, startDate:string, endDate:string, label:string, days:number}}
 */
export function resolveRange(options) {
  const nowMs = options.nowMs ?? Date.now();
  const config = options.config ?? {};
  const dayStartHour = config?.budget?.dayStartHour ?? DAY_START_HOUR_DEFAULT;
  const kindRaw = typeof options.range === "string" ? options.range : "cycle";
  const kind = RANGE_KINDS.includes(kindRaw) ? kindRaw : "cycle";
  const today = cycleDateKey(nowMs, dayStartHour);

  const finish = (startMs, endMs, label, startDate, endDate) => {
    const days = Math.max(1, Math.round((dateKeyToMs(endDate) - dateKeyToMs(startDate)) / DAY_MS) + 1);
    return { kind, startMs, endMs, startDate, endDate, label, days };
  };

  if (kind === "custom") {
    const from = isValidDateKey(options.from) ? options.from : today;
    const to = isValidDateKey(options.to) ? options.to : today;
    const [startDate, endDate] = from <= to ? [from, to] : [to, from];
    return finish(dayStartMs(startDate, dayStartHour), dayStartMs(endDate, dayStartHour) + DAY_MS, "自定义", startDate, endDate);
  }

  if (kind === "all") {
    const earliest = Number.isFinite(options.earliestMs) ? options.earliestMs : nowMs - 365 * DAY_MS;
    const startDate = cycleDateKey(earliest, dayStartHour);
    return finish(dayStartMs(startDate, dayStartHour), nowMs + 1, "全部", startDate, today);
  }

  if (kind === "today") {
    return finish(dayStartMs(today, dayStartHour), nowMs + 1, "今日", today, today);
  }

  if (kind === "7d" || kind === "30d" || kind === "90d") {
    const days = Number.parseInt(kind, 10);
    const startMs = dayStartMs(today, dayStartHour) - (days - 1) * DAY_MS;
    const startDate = cycleDateKey(startMs + 1, dayStartHour);
    return finish(startMs, nowMs + 1, `近 ${days} 天`, startDate, today);
  }

  // cycle
  const cycle = cycleBounds(nowMs, { mode: config?.budget?.mode ?? "daily", dayStartHour });
  const startDate = cycleDateKey(cycle.startMs, dayStartHour);
  const endDate = cycleDateKey(cycle.endMs - 1, dayStartHour);
  return finish(cycle.startMs, nowMs + 1, cycle.label, startDate, endDate);
}

/** 生成范围内的使用日 key 列表（升序）。 */
export function dateKeysInRange(range) {
  const keys = [];
  const startMs = dateKeyToMs(range.startDate);
  const days = Math.max(1, Math.round((dateKeyToMs(range.endDate) - startMs) / DAY_MS) + 1);
  for (let index = 0; index < days; index += 1) {
    const ms = startMs + index * DAY_MS;
    keys.push(beijingDateKey(ms));
  }
  return keys;
}
