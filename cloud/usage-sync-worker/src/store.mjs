/**
 * 存储适配器：同一套高层接口，两种实现。
 *
 * - `createMemoryStore()`：纯内存，Node 单测使用，不依赖 wrangler / D1；
 * - `createD1Store(db)`：Cloudflare D1，全部参数化 prepare/bind，禁止字符串拼接 SQL。
 *
 * 生产者（`handleRequest`）只依赖下面的接口，不感知底层是内存还是 D1，
 * 这样安全/业务规则可以在 Node 里被完整测试。
 *
 * 数据约定：
 * - 令牌、邀请码只接收 SHA-256（`tokenHash` / `inviteHash`），明文永不入库；
 * - 快照 payload 是聚合 JSON 字符串；`ts` 是 payload 里的 `_ts`（epoch 毫秒），
 *   同时作为单调守卫的比较列（D1 侧用 `json_extract(payload, '$._ts')` 交叉校验）。
 */

const SNAPSHOT_SEP = "\u0000";

function cloneRow(row) {
  return row ? { ...row } : null;
}

function normalizeMemberRow(row) {
  return {
    id: row.id,
    spaceId: row.space_id,
    deviceId: row.device_id,
    displayName: row.display_name,
    role: row.role,
    tokenHash: row.token_hash,
    createdAt: row.created_at,
    lastSeenAt: row.last_seen_at,
    revokedAt: row.revoked_at,
    syncInfo: parseSettings(row.sync_info),
    heartbeatAt: row.heartbeat_at ?? null,
  };
}

function parseSettings(value) {
  if (value === null || value === undefined || value === "") return {};
  if (typeof value === "object" && !Array.isArray(value)) return { ...value };
  if (typeof value !== "string") return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function normalizeSpaceRow(row) {
  return {
    id: row.id,
    name: row.name,
    createdAt: row.created_at,
    inviteHash: row.invite_hash,
    inviteExpiresAt: row.invite_expires_at,
    inviteUsedAt: row.invite_used_at,
    settings: parseSettings(row.settings),
    sharedSettings: row.shared_settings ? parseSettings(row.shared_settings) : null,
    settingsRevision: Number(row.settings_revision ?? 0),
  };
}

function normalizeSnapshotRow(row) {
  return {
    deviceId: row.device_id,
    displayName: row.display_name ?? null,
    role: row.role ?? null,
    revoked: row.revoked_at !== null && row.revoked_at !== undefined,
    payload: row.payload,
    payloadHash: row.payload_hash,
    ts: row._ts,
    updatedAt: row.updated_at,
  };
}

// ---------------------------------------------------------------------------
// 内存实现（测试 / 本地演示）
// ---------------------------------------------------------------------------

export function createMemoryStore() {
  /** @type {Map<string, any>} */
  const spaces = new Map();
  /** @type {Map<string, any>} memberId → member */
  const members = new Map();
  /** @type {Map<string, any>} `${spaceId}\0${deviceId}` → snapshot */
  const snapshots = new Map();
  /** @type {Map<string, any>} `${spaceId}\0${day}\0${cycle}` → daily plan */
  const dailyPlans = new Map();
  /** @type {Map<string, any>} `${spaceId}\0${deviceId}\0${day}` → task count */
  const taskStats = new Map();
  /** @type {Map<string, any>} `${spaceId}\0${personId}\0${day}` → comfort */
  const comfortSync = new Map();
  /** @type {Map<string, any>} `${spaceId}\0${deviceId}\0${day}\0${key}` → task summary */
  const taskSync = new Map();

  function membersOf(spaceId) {
    return [...members.values()].filter((member) => member.spaceId === spaceId);
  }

  function findMember(spaceId, deviceId) {
    return membersOf(spaceId).find((member) => member.deviceId === deviceId) ?? null;
  }

  function countActive(spaceId) {
    return membersOf(spaceId).filter((member) => member.revokedAt === null).length;
  }

  async function getMember(spaceId, deviceId) {
    return cloneRow(findMember(spaceId, deviceId));
  }

  return {
    kind: "memory",

    async createSpace({ id, name, createdAt }) {
      const space = {
        id,
        name,
        createdAt,
        inviteHash: null,
        inviteExpiresAt: null,
        inviteUsedAt: null,
        settings: {},
        sharedSettings: null,
        settingsRevision: 0,
      };
      spaces.set(id, space);
      return cloneRow(space);
    },

    async getSpace(spaceId) {
      const space = spaces.get(spaceId) ?? null;
      if (!space) return null;
      return {
        ...cloneRow(space),
        settings: { ...space.settings },
        sharedSettings: space.sharedSettings ? { ...space.sharedSettings } : null,
        settingsRevision: space.settingsRevision,
      };
    },

    async getSharedSettings(spaceId) {
      const space = spaces.get(spaceId);
      if (!space) return null;
      return {
        revision: space.settingsRevision,
        settings: space.sharedSettings ? structuredClone(space.sharedSettings) : null,
      };
    },

    /** 版本化共享配置 CAS：expectedRevision 不匹配时返回 `{ok:false, revision}`，绝不静默覆盖。 */
    async saveSharedSettings(spaceId, { expectedRevision, settings }) {
      const space = spaces.get(spaceId);
      if (!space) return { ok: false, missing: true };
      if (space.settingsRevision !== expectedRevision) return { ok: false, conflict: true, revision: space.settingsRevision };
      space.sharedSettings = structuredClone(settings);
      space.settingsRevision += 1;
      return { ok: true, revision: space.settingsRevision };
    },

    async setMemberSyncInfo(spaceId, deviceId, syncInfo, heartbeatAt) {
      const member = findMember(spaceId, deviceId);
      if (!member || member.revokedAt !== null) return false;
      member.syncInfo = syncInfo && typeof syncInfo === "object" ? { ...syncInfo } : {};
      member.heartbeatAt = heartbeatAt;
      return true;
    },

    async getDailyPlan(spaceId, day, cycle) {
      const row = dailyPlans.get(`${spaceId}${SNAPSHOT_SEP}${day}${SNAPSHOT_SEP}${cycle}`);
      if (!row) return null;
      return { revision: row.revision, value: structuredClone(row.value) };
    },

    async getLatestDailyPlan(spaceId, day) {
      let latest = null;
      for (const [key, row] of dailyPlans.entries()) {
        const [sid, planDay] = key.split(SNAPSHOT_SEP);
        if (sid !== spaceId || planDay !== day) continue;
        if (!latest || row.insertedAt >= latest.insertedAt) latest = row;
      }
      return latest ? { revision: latest.revision, value: structuredClone(latest.value) } : null;
    },

    async insertDailyPlanIfAbsent(spaceId, day, cycle, value) {
      const key = `${spaceId}${SNAPSHOT_SEP}${day}${SNAPSHOT_SEP}${cycle}`;
      if (!dailyPlans.has(key)) {
        dailyPlans.set(key, { revision: 0, value: structuredClone(value), insertedAt: Date.now() });
      }
      const row = dailyPlans.get(key);
      return { revision: row.revision, value: structuredClone(row.value) };
    },

    async updateDailyPlanCas(spaceId, day, cycle, value, expectedRowRevision) {
      const row = dailyPlans.get(`${spaceId}${SNAPSHOT_SEP}${day}${SNAPSHOT_SEP}${cycle}`);
      if (!row) return { ok: false, missing: true };
      if (row.revision !== expectedRowRevision) return { ok: false, conflict: true, revision: row.revision };
      row.value = structuredClone(value);
      row.revision += 1;
      return { ok: true, revision: row.revision };
    },

    async getSpaceSettings(spaceId) {
      const space = spaces.get(spaceId);
      return space ? { ...space.settings } : null;
    },

    async saveSpaceSettings(spaceId, settings, name) {
      const space = spaces.get(spaceId);
      if (!space) return null;
      space.settings = { ...settings };
      if (typeof name === "string" && name.length > 0) space.name = name;
      return { ...space.settings };
    },

    async renameMember(spaceId, deviceId, displayName) {
      const member = findMember(spaceId, deviceId);
      if (!member || member.revokedAt !== null) return false;
      member.displayName = displayName;
      return true;
    },

    async issueInvite(spaceId, { inviteHash, expiresAt }) {
      const space = spaces.get(spaceId);
      if (!space) return false;
      space.inviteHash = inviteHash;
      space.inviteExpiresAt = expiresAt;
      space.inviteUsedAt = null;
      return true;
    },

    async findSpaceByInviteHash(inviteHash) {
      for (const space of spaces.values()) {
        if (space.inviteHash === inviteHash) return cloneRow(space);
      }
      return null;
    },

    async consumeInvite(spaceId, inviteHash, now) {
      const space = spaces.get(spaceId);
      if (!space) return false;
      if (space.inviteHash !== inviteHash) return false;
      if (space.inviteUsedAt !== null) return false;
      if (!(space.inviteExpiresAt > now)) return false;
      space.inviteUsedAt = now;
      return true;
    },

    async countActiveDevices(spaceId) {
      return countActive(spaceId);
    },

    async getMemberByTokenHash(tokenHash) {
      for (const member of members.values()) {
        if (member.tokenHash === tokenHash) return cloneRow(member);
      }
      return null;
    },

    getMember,

    /** 新增 / 轮换 / 恢复成员；设备上限不满足时返回 `{ok:false, reason:'device_limit'}`。 */
    async addMember({ id, spaceId, deviceId, displayName, role, tokenHash, createdAt, deviceLimit }) {
      const existing = findMember(spaceId, deviceId);
      if (existing && existing.revokedAt === null) {
        existing.tokenHash = tokenHash;
        existing.displayName = displayName;
        existing.lastSeenAt = createdAt;
        return { ok: true, member: cloneRow(existing) };
      }
      if (countActive(spaceId) >= deviceLimit) return { ok: false, reason: "device_limit" };
      if (existing) {
        existing.tokenHash = tokenHash;
        existing.displayName = displayName;
        existing.role = role === "owner" ? "owner" : existing.role;
        existing.lastSeenAt = createdAt;
        existing.revokedAt = null;
        return { ok: true, member: cloneRow(existing) };
      }
      const member = {
        id,
        spaceId,
        deviceId,
        displayName,
        role,
        tokenHash,
        createdAt,
        lastSeenAt: createdAt,
        revokedAt: null,
        syncInfo: null,
        heartbeatAt: null,
      };
      members.set(id, member);
      return { ok: true, member: cloneRow(member) };
    },

    async revokeMember(spaceId, deviceId, revokedAt) {
      const member = findMember(spaceId, deviceId);
      if (!member || member.revokedAt !== null) return false;
      member.revokedAt = revokedAt;
      return true;
    },

    async listMembers(spaceId) {
      return membersOf(spaceId)
        .sort((left, right) => left.createdAt - right.createdAt)
        .map((member) => cloneRow(member));
    },

    /** 快照幂等去重 + `_ts` 单调守卫。返回 `{status: inserted|updated|deduped|stale, ts}`。 */
    async upsertSnapshot({ spaceId, deviceId, payload, payloadHash, ts, updatedAt }) {
      const key = `${spaceId}${SNAPSHOT_SEP}${deviceId}`;
      const existing = snapshots.get(key);
      if (existing && existing.payloadHash === payloadHash) return { status: "deduped", ts: existing.ts };
      if (existing && ts <= existing.ts) return { status: "stale", ts: existing.ts };
      snapshots.set(key, { spaceId, deviceId, payload, payloadHash, ts, updatedAt });
      return { status: existing ? "updated" : "inserted", ts };
    },

    async listSnapshots(spaceId) {
      return [...snapshots.values()]
        .filter((row) => row.spaceId === spaceId)
        .map((row) => {
          const member = findMember(spaceId, row.deviceId);
          return normalizeSnapshotRow({
            device_id: row.deviceId,
            display_name: member?.displayName ?? null,
            role: member?.role ?? null,
            revoked_at: member?.revokedAt ?? null,
            payload: row.payload,
            payload_hash: row.payloadHash,
            _ts: row.ts,
            updated_at: row.updatedAt,
          });
        })
        .sort((left, right) => right.ts - left.ts);
    },

    async upsertTaskStats(spaceId, deviceId, days, updatedAt) {
      for (const item of days) {
        taskStats.set(`${spaceId}${SNAPSHOT_SEP}${deviceId}${SNAPSHOT_SEP}${item.date}`, {
          spaceId,
          deviceId,
          day: item.date,
          tasks: item.tasks,
          updatedAt,
        });
      }
      return days.length;
    },

    async listTaskStats(spaceId, day) {
      return [...taskStats.values()]
        .filter((row) => row.spaceId === spaceId && (day === undefined || row.day === day))
        .map((row) => ({ deviceId: row.deviceId, day: row.day, tasks: row.tasks }));
    },

    async upsertComfort(spaceId, personId, day, level, note, updatedAt) {
      const key = `${spaceId}${SNAPSHOT_SEP}${personId}${SNAPSHOT_SEP}${day}`;
      const existing = comfortSync.get(key);
      const revision = existing ? existing.revision + 1 : 0;
      const row = { spaceId, personId, day, level, note, revision, updatedAt };
      comfortSync.set(key, row);
      return { personId, day, level, note, revision, updatedAt };
    },

    async listComfort(spaceId, day) {
      return [...comfortSync.values()]
        .filter((row) => row.spaceId === spaceId && (day === undefined || row.day === day))
        .map((row) => ({ personId: row.personId, day: row.day, level: row.level, note: row.note, revision: row.revision, updatedAt: row.updatedAt }));
    },

    async upsertTaskSummaries(spaceId, deviceId, day, tasks, updatedAt) {
      for (const task of tasks) {
        taskSync.set(`${spaceId}${SNAPSHOT_SEP}${deviceId}${SNAPSHOT_SEP}${day}${SNAPSHOT_SEP}${task.key}`, {
          spaceId,
          deviceId,
          day,
          taskKey: task.key,
          title: task.title,
          tokens: task.tokens,
          costCny: task.costCny,
          lastAt: task.lastAt,
          updatedAt,
        });
      }
      return tasks.length;
    },

    async listTaskSummaries(spaceId, day) {
      return [...taskSync.values()]
        .filter((row) => row.spaceId === spaceId && (day === undefined || row.day === day))
        .map((row) => ({
          deviceId: row.deviceId,
          day: row.day,
          taskKey: row.taskKey,
          title: row.title,
          tokens: row.tokens,
          costCny: row.costCny,
          lastAt: row.lastAt,
        }));
    },
  };
}

// ---------------------------------------------------------------------------
// D1 实现（生产）
// ---------------------------------------------------------------------------

export function createD1Store(db) {
  if (!db || typeof db.prepare !== "function") {
    throw new TypeError("createD1Store(db)：D1 绑定缺失或非法");
  }

  async function run(sql, params = []) {
    const result = await db.prepare(sql).bind(...params).run();
    return result?.meta?.changes ?? 0;
  }

  async function first(sql, params = []) {
    return (await db.prepare(sql).bind(...params).first()) ?? null;
  }

  async function all(sql, params = []) {
    const result = await db.prepare(sql).bind(...params).all();
    return result?.results ?? [];
  }

  async function getMember(spaceId, deviceId) {
    const row = await first(
      "SELECT id, space_id, device_id, display_name, role, token_hash, created_at, last_seen_at, revoked_at FROM members WHERE space_id = ? AND device_id = ? LIMIT 1",
      [spaceId, deviceId],
    );
    return row ? normalizeMemberRow(row) : null;
  }

  return {
    kind: "d1",

    async createSpace({ id, name, createdAt }) {
      await run("INSERT INTO spaces (id, name, created_at, settings) VALUES (?, ?, ?, '{}')", [id, name, createdAt]);
      return {
        id,
        name,
        createdAt,
        inviteHash: null,
        inviteExpiresAt: null,
        inviteUsedAt: null,
        settings: {},
        sharedSettings: null,
        settingsRevision: 0,
      };
    },

    async getSpace(spaceId) {
      const row = await first(
        "SELECT id, name, created_at, invite_hash, invite_expires_at, invite_used_at, settings, shared_settings, settings_revision FROM spaces WHERE id = ? LIMIT 1",
        [spaceId],
      );
      return row ? normalizeSpaceRow(row) : null;
    },

    async getSharedSettings(spaceId) {
      const row = await first("SELECT shared_settings, settings_revision FROM spaces WHERE id = ? LIMIT 1", [spaceId]);
      if (!row) return null;
      return {
        revision: Number(row.settings_revision ?? 0),
        settings: row.shared_settings ? parseSettings(row.shared_settings) : null,
      };
    },

    async saveSharedSettings(spaceId, { expectedRevision, settings }) {
      const payload = JSON.stringify(settings ?? {});
      const changes = await run(
        "UPDATE spaces SET shared_settings = ?, settings_revision = settings_revision + 1 WHERE id = ? AND settings_revision = ?",
        [payload, spaceId, expectedRevision],
      );
      if (changes > 0) {
        const row = await first("SELECT settings_revision FROM spaces WHERE id = ? LIMIT 1", [spaceId]);
        return { ok: true, revision: Number(row?.settings_revision ?? expectedRevision + 1) };
      }
      const row = await first("SELECT settings_revision FROM spaces WHERE id = ? LIMIT 1", [spaceId]);
      if (!row) return { ok: false, missing: true };
      return { ok: false, conflict: true, revision: Number(row.settings_revision ?? 0) };
    },

    async setMemberSyncInfo(spaceId, deviceId, syncInfo, heartbeatAt) {
      const changes = await run(
        "UPDATE members SET sync_info = ?, heartbeat_at = ? WHERE space_id = ? AND device_id = ? AND revoked_at IS NULL",
        [JSON.stringify(syncInfo ?? {}), heartbeatAt, spaceId, deviceId],
      );
      return changes > 0;
    },

    async getDailyPlan(spaceId, day, cycle) {
      const row = await first("SELECT value, revision FROM daily_plans WHERE space_id = ? AND day = ? AND cycle = ? LIMIT 1", [
        spaceId,
        day,
        cycle,
      ]);
      if (!row) return null;
      return { revision: Number(row.revision ?? 0), value: parseSettings(row.value) };
    },

    async getLatestDailyPlan(spaceId, day) {
      const row = await first(
        "SELECT value, revision FROM daily_plans WHERE space_id = ? AND day = ? ORDER BY rowid DESC LIMIT 1",
        [spaceId, day],
      );
      if (!row) return null;
      return { revision: Number(row.revision ?? 0), value: parseSettings(row.value) };
    },

    async insertDailyPlanIfAbsent(spaceId, day, cycle, value) {
      await run("INSERT OR IGNORE INTO daily_plans (space_id, day, cycle, value) VALUES (?, ?, ?, ?)", [
        spaceId,
        day,
        cycle,
        JSON.stringify(value),
      ]);
      const row = await first("SELECT value, revision FROM daily_plans WHERE space_id = ? AND day = ? AND cycle = ? LIMIT 1", [
        spaceId,
        day,
        cycle,
      ]);
      return { revision: Number(row?.revision ?? 0), value: parseSettings(row?.value) };
    },

    async updateDailyPlanCas(spaceId, day, cycle, value, expectedRowRevision) {
      const changes = await run(
        "UPDATE daily_plans SET value = ?, revision = revision + 1 WHERE space_id = ? AND day = ? AND cycle = ? AND revision = ?",
        [JSON.stringify(value), spaceId, day, cycle, expectedRowRevision],
      );
      if (changes > 0) {
        const row = await first("SELECT revision FROM daily_plans WHERE space_id = ? AND day = ? AND cycle = ? LIMIT 1", [
          spaceId,
          day,
          cycle,
        ]);
        return { ok: true, revision: Number(row?.revision ?? expectedRowRevision + 1) };
      }
      const row = await first("SELECT revision FROM daily_plans WHERE space_id = ? AND day = ? AND cycle = ? LIMIT 1", [
        spaceId,
        day,
        cycle,
      ]);
      if (!row) return { ok: false, missing: true };
      return { ok: false, conflict: true, revision: Number(row.revision ?? 0) };
    },

    async getSpaceSettings(spaceId) {
      const row = await first("SELECT settings FROM spaces WHERE id = ? LIMIT 1", [spaceId]);
      return row ? parseSettings(row.settings) : null;
    },

    async saveSpaceSettings(spaceId, settings, name) {
      const payload = JSON.stringify(settings ?? {});
      const changes =
        typeof name === "string" && name.length > 0
          ? await run("UPDATE spaces SET settings = ?, name = ? WHERE id = ?", [payload, name, spaceId])
          : await run("UPDATE spaces SET settings = ? WHERE id = ?", [payload, spaceId]);
      return changes > 0 ? settings : null;
    },

    async renameMember(spaceId, deviceId, displayName) {
      const changes = await run(
        "UPDATE members SET display_name = ? WHERE space_id = ? AND device_id = ? AND revoked_at IS NULL",
        [displayName, spaceId, deviceId],
      );
      return changes > 0;
    },

    async issueInvite(spaceId, { inviteHash, expiresAt }) {
      const changes = await run("UPDATE spaces SET invite_hash = ?, invite_expires_at = ?, invite_used_at = NULL WHERE id = ?", [
        inviteHash,
        expiresAt,
        spaceId,
      ]);
      return changes > 0;
    },

    async findSpaceByInviteHash(inviteHash) {
      const row = await first(
        "SELECT id, name, created_at, invite_hash, invite_expires_at, invite_used_at, settings FROM spaces WHERE invite_hash = ? LIMIT 1",
        [inviteHash],
      );
      return row ? normalizeSpaceRow(row) : null;
    },

    async consumeInvite(spaceId, inviteHash, now) {
      // 单条 UPDATE 完成"未用过 + 未过期 + hash 匹配"的原子消费，避免并发双花。
      const changes = await run(
        "UPDATE spaces SET invite_used_at = ? WHERE id = ? AND invite_hash = ? AND invite_used_at IS NULL AND invite_expires_at > ?",
        [now, spaceId, inviteHash, now],
      );
      return changes > 0;
    },

    async countActiveDevices(spaceId) {
      const row = await first("SELECT COUNT(*) AS total FROM members WHERE space_id = ? AND revoked_at IS NULL", [spaceId]);
      return Number(row?.total ?? 0);
    },

    async getMemberByTokenHash(tokenHash) {
      const row = await first(
        "SELECT id, space_id, device_id, display_name, role, token_hash, created_at, last_seen_at, revoked_at FROM members WHERE token_hash = ? LIMIT 1",
        [tokenHash],
      );
      return row ? normalizeMemberRow(row) : null;
    },

    getMember,

    async addMember({ id, spaceId, deviceId, displayName, role, tokenHash, createdAt, deviceLimit }) {
      // 1) 已存在且未撤销 → 轮换令牌（重装/重新 enroll 同一设备）。
      const rotated = await run(
        "UPDATE members SET token_hash = ?, display_name = ?, last_seen_at = ? WHERE space_id = ? AND device_id = ? AND revoked_at IS NULL",
        [tokenHash, displayName, createdAt, spaceId, deviceId],
      );
      if (rotated > 0) return { ok: true, member: await getMember(spaceId, deviceId) };

      // 2) 新设备：INSERT ... SELECT 带设备上限守卫（单语句内计数，缩小竞态窗口）；
      //    额外 NOT EXISTS 防止与已撤销成员的 UNIQUE(space_id, device_id) 冲突。
      const inserted = await run(
        `INSERT INTO members (id, space_id, device_id, display_name, role, token_hash, created_at, last_seen_at, revoked_at)
         SELECT ?, ?, ?, ?, ?, ?, ?, ?, NULL
         WHERE (SELECT COUNT(*) FROM members WHERE space_id = ? AND revoked_at IS NULL) < ?
           AND NOT EXISTS (SELECT 1 FROM members WHERE space_id = ? AND device_id = ?)`,
        [id, spaceId, deviceId, displayName, role, tokenHash, createdAt, createdAt, spaceId, deviceLimit, spaceId, deviceId],
      );
      if (inserted > 0) return { ok: true, member: await getMember(spaceId, deviceId) };

      // 3) 已撤销成员：凭新邀请码恢复（同样受上限守卫）。
      const restored = await run(
        `UPDATE members SET token_hash = ?, display_name = ?, last_seen_at = ?, revoked_at = NULL
         WHERE space_id = ? AND device_id = ? AND revoked_at IS NOT NULL
           AND (SELECT COUNT(*) FROM members WHERE space_id = ? AND revoked_at IS NULL) < ?`,
        [tokenHash, displayName, createdAt, spaceId, deviceId, spaceId, deviceLimit],
      );
      if (restored > 0) return { ok: true, member: await getMember(spaceId, deviceId) };
      return { ok: false, reason: "device_limit" };
    },

    async revokeMember(spaceId, deviceId, revokedAt) {
      const changes = await run("UPDATE members SET revoked_at = ? WHERE space_id = ? AND device_id = ? AND revoked_at IS NULL", [
        revokedAt,
        spaceId,
        deviceId,
      ]);
      return changes > 0;
    },

    async listMembers(spaceId) {
      const rows = await all(
        "SELECT id, space_id, device_id, display_name, role, token_hash, created_at, last_seen_at, revoked_at, sync_info, heartbeat_at FROM members WHERE space_id = ? ORDER BY created_at ASC",
        [spaceId],
      );
      return rows.map(normalizeMemberRow);
    },

    async upsertSnapshot({ spaceId, deviceId, payload, payloadHash, ts, updatedAt }) {
      const existing = await first("SELECT payload_hash, _ts FROM snapshots WHERE space_id = ? AND device_id = ?", [spaceId, deviceId]);
      if (existing && existing.payload_hash === payloadHash) return { status: "deduped", ts: existing._ts };
      if (existing && ts <= existing._ts) return { status: "stale", ts: existing._ts };
      // 单调守卫在 SQL 内再校验一次（`json_extract(_ts)` 双向比较），防止读取与写入之间的竞态覆盖。
      const changes = await run(
        `INSERT INTO snapshots (space_id, device_id, payload, payload_hash, _ts, updated_at)
         VALUES (?, ?, ?, ?, CAST(json_extract(?, '$._ts') AS INTEGER), ?)
         ON CONFLICT(space_id, device_id) DO UPDATE SET
           payload = excluded.payload,
           payload_hash = excluded.payload_hash,
           _ts = excluded._ts,
           updated_at = excluded.updated_at
         WHERE json_extract(excluded.payload, '$._ts') > json_extract(snapshots.payload, '$._ts')`,
        [spaceId, deviceId, payload, payloadHash, payload, updatedAt],
      );
      if (changes === 0) {
        const latest = await first("SELECT _ts FROM snapshots WHERE space_id = ? AND device_id = ?", [spaceId, deviceId]);
        return { status: "stale", ts: latest?._ts ?? ts };
      }
      return { status: existing ? "updated" : "inserted", ts };
    },

    async listSnapshots(spaceId) {
      const rows = await all(
        `SELECT s.device_id, s.payload, s.payload_hash, s._ts, s.updated_at,
                m.display_name, m.role, m.revoked_at
         FROM snapshots s
         LEFT JOIN members m ON m.space_id = s.space_id AND m.device_id = s.device_id
         WHERE s.space_id = ?
         ORDER BY s._ts DESC`,
        [spaceId],
      );
      return rows.map(normalizeSnapshotRow);
    },

    async upsertTaskStats(spaceId, deviceId, days, updatedAt) {
      for (const item of days) {
        await run(
          `INSERT INTO task_usage (space_id, device_id, day, tasks, updated_at)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(space_id, device_id, day) DO UPDATE SET tasks = excluded.tasks, updated_at = excluded.updated_at`,
          [spaceId, deviceId, item.date, item.tasks, updatedAt],
        );
      }
      return days.length;
    },

    async listTaskStats(spaceId, day) {
      const rows = day === undefined
        ? await all("SELECT device_id, day, tasks FROM task_usage WHERE space_id = ?", [spaceId])
        : await all("SELECT device_id, day, tasks FROM task_usage WHERE space_id = ? AND day = ?", [spaceId, day]);
      return rows.map((row) => ({ deviceId: row.device_id, day: row.day, tasks: Number(row.tasks ?? 0) }));
    },

    async upsertComfort(spaceId, personId, day, level, note, updatedAt) {
      const existing = await first("SELECT revision FROM comfort_sync WHERE space_id = ? AND person_id = ? AND day = ?", [
        spaceId,
        personId,
        day,
      ]);
      const revision = existing ? Number(existing.revision ?? 0) + 1 : 0;
      await run(
        `INSERT INTO comfort_sync (space_id, person_id, day, level, note, revision, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(space_id, person_id, day) DO UPDATE SET
           level = excluded.level, note = excluded.note, revision = revision + 1, updated_at = excluded.updated_at`,
        [spaceId, personId, day, level, note, revision, updatedAt],
      );
      return { personId, day, level, note, revision, updatedAt };
    },

    async listComfort(spaceId, day) {
      const rows = day === undefined
        ? await all("SELECT person_id, day, level, note, revision, updated_at FROM comfort_sync WHERE space_id = ?", [spaceId])
        : await all("SELECT person_id, day, level, note, revision, updated_at FROM comfort_sync WHERE space_id = ? AND day = ?", [spaceId, day]);
      return rows.map((row) => ({
        personId: row.person_id,
        day: row.day,
        level: Number(row.level ?? 0),
        note: row.note ?? "",
        revision: Number(row.revision ?? 0),
        updatedAt: row.updated_at,
      }));
    },

    async upsertTaskSummaries(spaceId, deviceId, day, tasks, updatedAt) {
      for (const task of tasks) {
        await run(
          `INSERT INTO task_sync (space_id, device_id, day, task_key, title, tokens, cost_cny, last_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(space_id, device_id, day, task_key) DO UPDATE SET
             title = excluded.title, tokens = excluded.tokens, cost_cny = excluded.cost_cny,
             last_at = excluded.last_at, updated_at = excluded.updated_at`,
          [spaceId, deviceId, day, task.key, task.title, task.tokens, task.costCny, task.lastAt, updatedAt],
        );
      }
      return tasks.length;
    },

    async listTaskSummaries(spaceId, day) {
      const rows = day === undefined
        ? await all("SELECT device_id, day, task_key, title, tokens, cost_cny, last_at FROM task_sync WHERE space_id = ?", [spaceId])
        : await all("SELECT device_id, day, task_key, title, tokens, cost_cny, last_at FROM task_sync WHERE space_id = ? AND day = ?", [spaceId, day]);
      return rows.map((row) => ({
        deviceId: row.device_id,
        day: row.day,
        taskKey: row.task_key,
        title: row.title ?? "",
        tokens: row.tokens === null ? null : Number(row.tokens),
        costCny: row.cost_cny === null ? null : Number(row.cost_cny),
        lastAt: row.last_at === null ? null : Number(row.last_at),
      }));
    },
  };
}
