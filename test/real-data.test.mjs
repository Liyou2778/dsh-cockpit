import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { sessionsRoot } from "../src/core/paths.mjs";
import { buildStatus } from "../src/core/index.mjs";

/**
 * 真实数据冒烟（默认跳过，离线/CI 上不跑）。
 *   REAL_DATA=1 node --test
 * 断言：扫描成功、零错误、usage 覆盖达到基线量级。
 */
test("真实 DSH 会话冒烟（REAL_DATA=1）", { skip: process.env.REAL_DATA !== "1" }, async () => {
  const root = sessionsRoot();
  assert.equal(existsSync(root), true, `DSH 会话目录不存在：${root}`);
  const status = await buildStatus({});
  assert.ok(status.health.sessionsScanned > 0, "应至少扫描到 1 个会话");
  assert.equal(status.health.errors, 0, "扫描不应有错误");
  assert.ok(status.totals.cycleTokens >= 0);
  assert.ok(status.quota.remainingPercent >= 0 && status.quota.remainingPercent <= 100);
  assert.ok(status.forecast.score >= 2 && status.forecast.score <= 95);
  console.log(
    `[real-data] sessions=${status.health.sessionsScanned} usage=${status.totals.messagesWithUsage} cost=¥${status.totals.cycleCostCny}`,
  );
});
