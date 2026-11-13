/**
 * 北京时间与预算周期。
 * 依据 PRD FR-2 / 8.3：统计用 Asia/Shanghai 自然日；预算周期默认 04:00 换日。
 * 所有函数纯函数、显式传入 now，避免时钟依赖导致测试不稳定。
 */
export const TIME_ZONE = "Asia/Shanghai";
const HOUR_MS = 3_600_000;
const BEIJING_OFFSET_MS = 8 * HOUR_MS;
export const DAY_START_HOUR_DEFAULT = 4;

const dateFormatter = new Intl.DateTimeFormat("en-CA", {
  timeZone: TIME_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

/** 毫秒时间戳 → `YYYY-MM-DD`（Asia/Shanghai 自然日）。 */
export function beijingDateKey(ms) {
  return dateFormatter.format(new Date(ms));
}

/** 预算周期用日键（把 `dayStartHour` 之前的时间归到前一天）。 */
export function cycleDateKey(ms, dayStartHour = DAY_START_HOUR_DEFAULT) {
  return beijingDateKey(ms - dayStartHour * HOUR_MS);
}

function beijingWallParts(ms) {
  const shifted = new Date(ms + BEIJING_OFFSET_MS);
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth(),
    day: shifted.getUTCDate(),
    hour: shifted.getUTCHours(),
  };
}

function wallToUtcMs({ year, month, day, hour = 0 }) {
  return Date.UTC(year, month, day, hour, 0, 0, 0) - BEIJING_OFFSET_MS;
}

/**
 * 计算当前预算周期边界。
 * @param {number} nowMs
 * @param {{mode?: 'daily'|'weekly'|'monthly', dayStartHour?: number}} [options]
 * @returns {{startMs: number, endMs: number, windowSeconds: number, label: string, mode: string}}
 */
export function cycleBounds(nowMs, options = {}) {
  const mode = options.mode ?? "daily";
  const dayStartHour = options.dayStartHour ?? DAY_START_HOUR_DEFAULT;
  const shiftedMs = nowMs - dayStartHour * HOUR_MS;
  const parts = beijingWallParts(shiftedMs);

  if (mode === "weekly") {
    // 以周一为一周起点。
    const date = new Date(Date.UTC(parts.year, parts.month, parts.day));
    const weekday = (date.getUTCDay() + 6) % 7; // 周一=0
    const startWall = Date.UTC(parts.year, parts.month, parts.day - weekday, dayStartHour);
    const startMs = startWall - BEIJING_OFFSET_MS;
    const endMs = startMs + 7 * 24 * HOUR_MS;
    return { startMs, endMs, windowSeconds: 7 * 86_400, label: "本周", mode };
  }

  if (mode === "monthly") {
    const startMs = wallToUtcMs({ year: parts.year, month: parts.month, day: 1, hour: dayStartHour });
    const nextMonth = new Date(Date.UTC(parts.year, parts.month + 1, 1));
    const endMs =
      wallToUtcMs({ year: nextMonth.getUTCFullYear(), month: nextMonth.getUTCMonth(), day: 1, hour: dayStartHour });
    return { startMs, endMs, windowSeconds: Math.round((endMs - startMs) / 1000), label: "本月", mode };
  }

  const startMs = wallToUtcMs({ year: parts.year, month: parts.month, day: parts.day, hour: dayStartHour });
  const endMs = startMs + 24 * HOUR_MS;
  return { startMs, endMs, windowSeconds: 86_400, label: "今日", mode };
}

/** 本地化的 `HH:mm`（Asia/Shanghai），用于 UI 展示。 */
export function formatBeijingHm(ms) {
  const formatter = new Intl.DateTimeFormat("zh-CN", {
    timeZone: TIME_ZONE,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  return formatter.format(new Date(ms));
}

/** 本地化的 `MM-DD HH:mm`（Asia/Shanghai）。 */
export function formatBeijingShort(ms) {
  const formatter = new Intl.DateTimeFormat("zh-CN", {
    timeZone: TIME_ZONE,
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  return formatter.format(new Date(ms));
}
