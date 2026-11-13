-- DSH 驾驶舱 · 团队共享：任务摘要同步（对齐 Codex task sync）
--
-- 隐私开关：
--   * 同步任务摘要（标题 + tokens + 成本 + 最近时间），标题是否打码由本机 `ui.maskTitles` 决定；
--   * 每个设备每天最多 200 条；不含会话原始内容/工具参数/路径。

CREATE TABLE IF NOT EXISTS task_sync (
  space_id  TEXT NOT NULL REFERENCES spaces (id) ON DELETE CASCADE,
  device_id TEXT NOT NULL,
  day       TEXT NOT NULL,
  task_key  TEXT NOT NULL,
  title     TEXT NOT NULL DEFAULT '',
  tokens    REAL,
  cost_cny  REAL,
  last_at   INTEGER,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (space_id, device_id, day, task_key)
);

CREATE INDEX IF NOT EXISTS idx_task_sync_space_day ON task_sync (space_id, day);
