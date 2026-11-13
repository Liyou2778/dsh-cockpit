-- DSH 驾驶舱 · 团队共享：聚合任务统计 + 可选舒适度同步
--
-- 隐私约定：
--   * task_usage 只存「每设备每天的任务数量」——不含标题、会话 id、项目、路径；
--   * comfort_sync 只在成员显式开启后写入：等级(1–5)+可选短备注，按"人"（组员）归属；
--   * 两者都不随快照上传，独立端点、独立开关。

CREATE TABLE IF NOT EXISTS task_usage (
  space_id  TEXT NOT NULL REFERENCES spaces (id) ON DELETE CASCADE,
  device_id TEXT NOT NULL,
  day       TEXT NOT NULL,
  tasks     INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (space_id, device_id, day)
);

CREATE INDEX IF NOT EXISTS idx_task_usage_space_day ON task_usage (space_id, day);

CREATE TABLE IF NOT EXISTS comfort_sync (
  space_id  TEXT NOT NULL REFERENCES spaces (id) ON DELETE CASCADE,
  person_id TEXT NOT NULL,
  day       TEXT NOT NULL,
  level     INTEGER NOT NULL,
  note      TEXT NOT NULL DEFAULT '',
  revision  INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (space_id, person_id, day)
);

CREATE INDEX IF NOT EXISTS idx_comfort_space_day ON comfort_sync (space_id, day);
