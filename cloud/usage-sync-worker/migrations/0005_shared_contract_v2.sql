-- DSH 驾驶舱 · 团队共享：v2 契约（组员↔多设备 / 版本化共享配置 / 每日共享计划）
--
-- 对齐 Codex Cockpit 的做法：
--   * shared_settings：owner 发布的版本化配置（组员 + 设备归属 + 共享计划参数）；
--   * settings_revision：配置版本，写入走 CAS，冲突 409（绝不静默覆盖）；
--   * members.sync_info / heartbeat_at：每设备上报"采用的配置版本"，用于提示旧设备；
--   * daily_plans：按 space + 北京日期 + 重置周期存当日计划（basis + 每人份额 + 风险，独立 revision）。

ALTER TABLE spaces ADD COLUMN shared_settings TEXT;
ALTER TABLE spaces ADD COLUMN settings_revision INTEGER NOT NULL DEFAULT 0;

ALTER TABLE members ADD COLUMN sync_info TEXT;
ALTER TABLE members ADD COLUMN heartbeat_at INTEGER;

CREATE TABLE IF NOT EXISTS daily_plans (
  space_id TEXT NOT NULL REFERENCES spaces (id) ON DELETE CASCADE,
  day      TEXT NOT NULL,
  cycle    TEXT NOT NULL,
  value    TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (space_id, day, cycle)
);
