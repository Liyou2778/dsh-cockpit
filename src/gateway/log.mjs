/**
 * 网关用量日志：本地 JSONL（只存元数据 + 官方 usage，绝不存请求/响应正文与凭据）。
 */
import { appendFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { cockpitHome } from "../core/paths.mjs";
import { estimateCost } from "../core/pricing.mjs";
import { round } from "../core/math.mjs";

export const GATEWAY_LOG_VERSION = 1;
export const MAX_LOG_RECORDS_READ = 200_000;

export function gatewayLogPath(env = process.env) {
  return join(cockpitHome(env), "gateway-usage.jsonl");
}

export function appendGatewayRecord(env, record) {
  const path = gatewayLogPath(env);
  appendFileSync(path, `${JSON.stringify({ v: GATEWAY_LOG_VERSION, ...record })}\n`, "utf8");
}

export function readGatewayRecords(env, { sinceMs = null, limit = MAX_LOG_RECORDS_READ } = {}) {
  const path = gatewayLogPath(env);
  if (!existsSync(path)) return [];
  const lines = readFileSync(path, "utf8").split(/\r?\n/);
  const records = [];
  for (const line of lines) {
    if (!line) continue;
    try {
      const record = JSON.parse(line);
      if (!record || typeof record.at !== "number") continue;
      if (sinceMs !== null && record.at < sinceMs) continue;
      records.push(record);
    } catch {
      // 坏行跳过，不影响整体统计
    }
  }
  return records.slice(-limit);
}

/** 聚合网关记录：用量精确；成本按价格表推算（缺失模型 = 未知，不补 0）。 */
export function summarizeGateway(records, { pricing = {}, pricingPolicy = {}, nowMs = Date.now() } = {}) {
  const byProvider = {};
  const byModel = {};
  const byDay = {};
  const tokens = { input: 0, cacheRead: 0, cacheWrite: 0, output: 0, total: 0 };
  let requests = 0;
  let unknownUsage = 0;
  let errors = 0;
  let costCny = 0;
  let costUnknown = 0;
  let lastAt = null;

  for (const record of records) {
    requests += 1;
    if (record.status >= 400) errors += 1;
    if (typeof record.at === "number" && (lastAt === null || record.at > lastAt)) lastAt = record.at;
    const provider = typeof record.provider === "string" ? record.provider : "unknown";
    const model = typeof record.model === "string" ? record.model : "unknown";
    const usage = record.usage ?? null;
    byProvider[provider] ??= { requests: 0, tokens: 0, unknownUsage: 0, errors: 0 };
    byProvider[provider].requests += 1;
    if (record.status >= 400) byProvider[provider].errors += 1;
    if (!usage) {
      unknownUsage += 1;
      byProvider[provider].unknownUsage += 1;
      continue;
    }
    const input = Number(usage.inputTokens) || 0;
    const cacheRead = Number(usage.cacheReadTokens) || 0;
    const cacheWrite = Number(usage.cacheWriteTokens) || 0;
    const output = Number(usage.outputTokens) || 0;
    const total = input + cacheRead + cacheWrite + output;
    tokens.input += input;
    tokens.cacheRead += cacheRead;
    tokens.cacheWrite += cacheWrite;
    tokens.output += output;
    tokens.total += total;
    byProvider[provider].tokens += total;
    byModel[model] ??= { requests: 0, tokens: 0, costCny: 0 };
    byModel[model].requests += 1;
    byModel[model].tokens += total;
    const dateKey = new Date(record.at + 8 * 3_600_000).toISOString().slice(0, 10);
    byDay[dateKey] ??= { tokens: 0, requests: 0 };
    byDay[dateKey].tokens += total;
    byDay[dateKey].requests += 1;
    const cost = estimateCost(usage, model, { overrides: pricing, policy: pricingPolicy, tsMs: record.at });
    if (cost.costCny === null) costUnknown += 1;
    else {
      costCny += cost.costCny;
      byModel[model].costCny += cost.costCny;
    }
  }

  return {
    policyVersion: "GATEWAY_V1",
    requests,
    errors,
    unknownUsage,
    tokens: { ...tokens, input: round(tokens.input, 0), genericTotal: tokens.total },
    costCny: round(costCny, 4),
    costEstimated: true,
    costUnknown,
    byProvider,
    byModel: Object.fromEntries(Object.entries(byModel).map(([model, row]) => [model, { ...row, costCny: round(row.costCny, 4) }])),
    byDay,
    lastAt,
    precision: {
      tokens: "exact（来自上游官方 usage）",
      cost: "derived（价格表推算，≈）",
      unknownUsage: "上游响应缺少 usage 时为 null，不估算",
    },
    generatedAt: new Date(nowMs).toISOString(),
  };
}
