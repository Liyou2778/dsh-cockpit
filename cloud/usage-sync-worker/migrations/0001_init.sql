-- DSH 驾驶舱 · 团队共享同步：初始 schema（D1 / SQLite）
--
-- 安全约定：
--   * members.token_hash / spaces.invite_hash 只存 SHA-256（hex），明文令牌与邀请码永不落库；
--   * snapshots 只存客户端聚合快照（JSON），不含会话 id / 标题 / 路径 / 对话；
--   * 撤销设备（revoked_at）只停用令牌，不删除历史快照 —— 数据保留期由运营者负责。

PRAGMA foreign_keys = ON;

-- 空间：一个团队 = 一个 space。同一时刻只有一个有效邀请码（单活邀请码，单次使用）。
CREATE TABLE IF NOT EXISTS spaces (
  id                TEXT PRIMARY KEY,
  name              TEXT NOT NULL DEFAULT '',
  created_at        INTEGER NOT NULL,
  invite_hash       TEXT,
  invite_expires_at INTEGER,
  invite_used_at    INTEGER
);

CREATE INDEX IF NOT EXISTS idx_spaces_invite_hash ON spaces (invite_hash);

-- 成员：一台设备 = 一条记录。令牌哈希唯一；撤销后保留记录以便审计/恢复。
CREATE TABLE IF NOT EXISTS members (
  id           TEXT PRIMARY KEY,
  space_id     TEXT NOT NULL REFERENCES spaces (id) ON DELETE CASCADE,
  device_id    TEXT NOT NULL,
  display_name TEXT NOT NULL DEFAULT '',
  role         TEXT NOT NULL CHECK (role IN ('owner', 'member')),
  token_hash   TEXT NOT NULL UNIQUE,
  created_at   INTEGER NOT NULL,
  last_seen_at INTEGER,
  revoked_at   INTEGER,
  UNIQUE (space_id, device_id)
);

CREATE INDEX IF NOT EXISTS idx_members_space ON members (space_id);
CREATE INDEX IF NOT EXISTS idx_members_token_hash ON members (token_hash);

-- 快照：每设备一条"最新聚合快照"（payload 内含 _ts，同时冗余成列用于排序/单调守卫）。
CREATE TABLE IF NOT EXISTS snapshots (
  space_id     TEXT NOT NULL REFERENCES spaces (id) ON DELETE CASCADE,
  device_id    TEXT NOT NULL,
  payload      TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  _ts          INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL,
  PRIMARY KEY (space_id, device_id)
);

CREATE INDEX IF NOT EXISTS idx_snapshots_space_ts ON snapshots (space_id, _ts DESC);
