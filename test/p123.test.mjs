import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeSyntheticSession, sessionHeader, contextEvent, assistantEvent } from "./helpers.mjs";
import { summarizeSession } from "../src/core/collect.mjs";
import { parseSessionText, readSessionFile } from "../src/core/session-reader.mjs";
import { estimateServiceFees, estimateTokensFromContent, SERVICE_FEE_PER_REQUEST } from "../src/core/pricing.mjs";
import { buildStatus, buildReceipt } from "../src/core/index.mjs";
import { saveConfig } from "../src/core/config.mjs";

const NOW = Date.parse("2026-11-03T16:00:00+08:00");

function setupEnv() {
  const root = mkdtempSync(join(tmpdir(), "cockpit-p123-"));
  return { root, env: { DSH_HOME: join(root, ".dsh"), DSH_COCKPIT_HOME: join(root, ".cockpit") }, sessions: join(root, ".dsh", "sessions") };
}

const toolCall = (time, { callId, name, args = "{}" }) =>
  JSON.stringify({ type: "tool/call", seq: 1, time, data: { turn: 1, step: 1, callId, name, arguments: args } });

const toolResult = (time, { callId, error = null }) => {
  const data = {
    turn: 1,
    step: 1,
    message: {
      role: "tool",
      source: { kind: "tool", callId },
      toolCallId: callId,
      content: [{ type: "tool-result", toolCallId: callId, content: [{ type: "text", text: "[synthetic]" }] }],
    },
  };
  if (error) data.error = error;
  return JSON.stringify({ type: "tool/result", seq: 2, time, data });
};

const retryEvent = (time, code) =>
  JSON.stringify({ type: "llm/retry", seq: 3, time, data: { retryId: `r-${code}`, retry: 1, maxRetries: 5, delayMs: 500, failure: { message: `fail ${code}`, code } } });

const retryStarted = (time) => JSON.stringify({ type: "llm/retry-started", seq: 4, time, data: { retryId: "r-1" } });

const assistantNoUsage = (time, text) =>
  JSON.stringify({ type: "assistant/message", seq: 5, time, data: { turn: 1, step: 1, message: { role: "assistant", content: [{ type: "text", text }], source: { kind: "model", provider: "deepseek-official", model: "deepseek-flash" } } } });

function writeAll(sessions) {
  return writeSyntheticSession(sessions, {
    projectSlug: "--p--",
    sessionId: "session-p123",
    lines: [
      sessionHeader({ id: "session-p123", createdAt: NOW - 3 * 3_600_000 }),
      contextEvent({ time: NOW - 3 * 3_600_000 }),
      assistantEvent({ time: NOW - 2 * 3_600_000, inputTokens: 1000, outputTokens: 100 }),
      toolCall(NOW - 1_900_000, { callId: "c-search", name: "web_search" }),
      toolResult(NOW - 1_800_000, { callId: "c-search" }),
      toolCall(NOW - 1_700_000, { callId: "c-fetch", name: "web_fetch" }),
      toolResult(NOW - 1_600_000, { callId: "c-fetch", error: { name: "WebError", code: "WEB_PROVIDER_ERROR" } }),
      retryEvent(NOW - 1_500_000, "RATE_LIMIT"),
      retryEvent(NOW - 1_450_000, "RATE_LIMIT"),
      retryEvent(NOW - 1_420_000, "RATE_LIMIT"),
      retryEvent(NOW - 1_400_000, "TRANSPORT"),
      retryStarted(NOW - 1_300_000),
      assistantNoUsage(NOW - 1_200_000, "你好hello"),
    ],
  });
}

test("P1：web_search/web_fetch 成功计费、失败不计费", () => {
  const { root, env, sessions } = setupEnv();
  try {
    const { path } = writeAll(sessions);
    const summary = summarizeSession(readSessionFile(path), { sessionId: "session-p123" });
    assert.deepEqual(summary.service.webSearch, { success: 1, failed: 0 });
    assert.deepEqual(summary.service.webFetch, { success: 0, failed: 1 });
    const fees = estimateServiceFees(summary.service);
    assert.equal(fees.requests, 1);
    assert.equal(fees.failed, 1);
    assert.equal(fees.costCny, SERVICE_FEE_PER_REQUEST);
    assert.equal(fees.rows.find((row) => row.kind === "webSearch").costCny, 0.005);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("P2：重试/限流/工具失败统计", () => {
  const { root, env, sessions } = setupEnv();
  try {
    const { path } = writeAll(sessions);
    const summary = summarizeSession(readSessionFile(path), { sessionId: "session-p123" });
    assert.equal(summary.reliability.retries, 4);
    assert.equal(summary.reliability.retryStarted, 1);
    assert.equal(summary.reliability.rateLimit, 3);
    assert.equal(summary.reliability.byCode.RATE_LIMIT, 3);
    assert.equal(summary.reliability.byCode.TRANSPORT, 1);
    assert.equal(summary.reliability.toolResults, 2);
    assert.equal(summary.reliability.toolErrors, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("P3：字符启发式（仅显式开启；中文 0.6 / 其他 0.3）", () => {
  const estimate = estimateTokensFromContent([{ type: "text", text: "你好hello" }]);
  assert.deepEqual(estimate, { tokens: 3, cjkChars: 2, otherChars: 5 });

  const { root, env, sessions } = setupEnv();
  try {
    writeAll(sessions);
    const off = summarizeSession(readSessionFile(writeAll(sessions).path), { sessionId: "session-p123" });
    assert.equal(off.estimation.messages, 0);
    assert.equal(off.estimation.tokens, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("状态集成：服务费进总成本、可靠性/估算字段、小票含服务行", async () => {
  const { root, env, sessions } = setupEnv();
  try {
    writeAll(sessions);
    saveConfig({ budget: { costCny: 1, includeServiceFees: true }, estimation: { fallback: "chars" } }, env);
    const status = await buildStatus({ env, nowMs: NOW, range: "cycle" });
    assert.equal(status.serviceFees.requests, 1);
    assert.equal(status.serviceFees.costCny, SERVICE_FEE_PER_REQUEST);
    assert.equal(status.totals.rangeServiceFeesCny, SERVICE_FEE_PER_REQUEST);
    assert.ok(status.quota.includesServiceFees);
    assert.ok(status.quota.used >= SERVICE_FEE_PER_REQUEST);
    assert.equal(status.reliability.rateLimit, 3);
    assert.equal(status.reliability.retries, 4);
    assert.ok(status.reliability.toolErrorRate > 0);
    assert.equal(status.estimation.enabled, true);
    assert.equal(status.estimation.messages, 1);
    assert.equal(status.estimation.tokens, 3);
    assert.ok(status.insights.some((item) => item.id === "rate-limit"));

    const receipt = await buildReceipt({ env, nowMs: NOW, range: "cycle" });
    const serviceLine = receipt.lines.find((line) => line.kind === "service");
    assert.ok(serviceLine);
    assert.equal(receipt.totalServiceFeesCny, SERVICE_FEE_PER_REQUEST);
    assert.ok(receipt.totalCostCny >= receipt.totalServiceFeesCny);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
