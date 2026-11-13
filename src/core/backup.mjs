/**
 * 备份 / 恢复（本地 JSON）——对应参考产品的 export/import + 自动备份。
 * 只导出「配置 + 舒适度 + 通知已读」；不导出会话缓存（可重扫），更不导出任何会话内容。
 */
import { loadConfig, saveConfig, loadComfort, recordComfort, normalizeComfortStore, loadNotificationState, saveNotificationState, CONFIG_SCHEMA_VERSION } from "./config.mjs";
import { CockpitError, ERROR_CODES } from "./errors.mjs";

/**
 * @param {{env?: NodeJS.ProcessEnv, nowMs?: number}} [options]
 */
export function buildBackup(options = {}) {
  const env = options.env ?? process.env;
  const { config } = loadConfig(env);
  const comfort = loadComfort(env);
  const notifications = loadNotificationState(env);
  return {
    product: "dsh-cockpit",
    schemaVersion: CONFIG_SCHEMA_VERSION,
    exportedAt: new Date(options.nowMs ?? Date.now()).toISOString(),
    config: { ...config, schemaVersion: CONFIG_SCHEMA_VERSION },
    comfort,
    notifications,
  };
}

/**
 * 恢复：校验 + 归一化 + 原子写。任何字段非法都退化为默认，绝不写坏现有配置。
 * @param {{payload: object, env?: NodeJS.ProcessEnv}} options
 */
export function restoreBackup(options) {
  const env = options.env ?? process.env;
  const payload = options.payload;
  if (!payload || typeof payload !== "object") {
    throw new CockpitError(ERROR_CODES.CONFIG_INVALID, "备份内容必须是 JSON 对象");
  }
  if (payload.product !== undefined && payload.product !== "dsh-cockpit") {
    throw new CockpitError(ERROR_CODES.CONFIG_INVALID, "备份来源不是 dsh-cockpit");
  }
  const version = payload.schemaVersion;
  if (version !== undefined && ![1, CONFIG_SCHEMA_VERSION].includes(version)) {
    throw new CockpitError(ERROR_CODES.CONFIG_INVALID, `不支持的备份版本：${version}`);
  }
  const restored = [];

  if (payload.config && typeof payload.config === "object") {
    saveConfig(payload.config, env);
    restored.push("config");
  }

  if (payload.comfort && typeof payload.comfort === "object") {
    const store = normalizeComfortStore(payload.comfort);
    const target = loadComfort(env);
    const merged = new Map(target.entries.map((entry) => [entry.date, entry]));
    for (const entry of store.entries) merged.set(entry.date, entry);
    const entries = [...merged.values()].sort((a, b) => a.date.localeCompare(b.date));
    // 通过公开写入路径落盘（保持原子与 schema）
    for (const entry of entries) {
      recordComfort({ level: entry.level, note: entry.note, date: entry.date, nowMs: entry.updatedAt }, env);
    }
    restored.push("comfort");
  }

  if (payload.notifications && Array.isArray(payload.notifications.read)) {
    saveNotificationState({ read: payload.notifications.read.filter((item) => typeof item === "string") }, env);
    restored.push("notifications");
  }

  return { ok: true, restored };
}
