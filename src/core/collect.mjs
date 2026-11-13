/**
 * 采集与归因：把一个会话的事件流折叠成可缓存的摘要（PRD FR-1）。
 *
 * 关键事实（实测）：DSH 的 `assistant/message.data.usage` 是**单次桶**，
 * 不是累计值 —— 因此参考产品的「累计差分 / fork 重放去重」在这里不需要（PRD 16.3）。
 *
 * 隐私：只保留数字与元数据（模型、时间、工具名、会话标题）；**绝不保留**对话正文、
 * 工具参数、文件路径内容。
 */
import { estimateCost, normalizeModel, estimateTokensFromContent } from "./pricing.mjs";
import { cycleDateKey } from "./time.mjs";

const ZERO = { inputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0, reasoningTokens: 0, totalTokens: 0 };

function emptyMetrics() {
  return { ...ZERO, costCny: 0, costKnownTokens: 0, costUnknownTokens: 0, messages: 0 };
}

function addMetrics(target, bucket) {
  target.inputTokens += bucket.inputTokens;
  target.cacheReadTokens += bucket.cacheReadTokens;
  target.cacheWriteTokens += bucket.cacheWriteTokens;
  target.outputTokens += bucket.outputTokens;
  target.reasoningTokens += bucket.reasoningTokens;
  target.totalTokens += bucket.totalTokens;
  target.messages += 1;
}

function safeNumber(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function bucketsOf(usage) {
  const inputTokens = safeNumber(usage.inputTokens) ?? 0;
  const cacheReadTokens = safeNumber(usage.cacheReadTokens) ?? 0;
  const cacheWriteTokens = safeNumber(usage.cacheWriteTokens) ?? 0;
  const outputTokens = safeNumber(usage.outputTokens) ?? 0;
  const reasoningTokens = safeNumber(usage.reasoningTokens) ?? 0;
  const totalTokens =
    safeNumber(usage.totalTokens) ?? inputTokens + cacheReadTokens + cacheWriteTokens + outputTokens;
  return { inputTokens, cacheReadTokens, cacheWriteTokens, outputTokens, reasoningTokens, totalTokens };
}

/**
 * @param {{header: object|null, events: object[]}} parsed
 * @param {{sessionId?: string|null, projectSlug?: string|null, path?: string, pricing?: Record<string, object>}} options
 */
export function summarizeSession(parsed, options = {}) {
  const header = parsed.header ?? null;
  const events = parsed.events ?? [];
  const pricing = options.pricing ?? {};

  const summary = {
    id: header?.id ?? options.sessionId ?? null,
    sessionDir: options.sessionId ?? null,
    projectSlug: options.projectSlug ?? null,
    path: options.path ?? null,
    version: header?.version ?? null,
    cwd: header?.cwd ?? null,
    createdAt: header?.createdAt ?? null,
    title: null,
    titleSource: null,
    delegationDepth: header?.delegationDepth ?? 0,
    parentSession: header?.parentSession ?? null,
    agentPreset: header?.agentPreset ?? null,
    firstAt: null,
    lastAt: null,
    byDay: {},
    byModel: {},
    byDayModel: {},
    tools: {},
    byDayTools: {},
    compactions: [],
    pressureSamples: [],
    context: { contextWindow: null, pressure: 0, provider: null, model: null, updatedAt: null },
    counts: { events: events.length, assistantMessages: 0, usageMessages: 0, toolCalls: 0, userMessages: 0 },
    cost: { knownTokens: 0, unknownTokens: 0 },
    // P1：Search / Fetch 服务调用统计（官方按成功请求计费）
    service: {
      webSearch: { success: 0, failed: 0 },
      webFetch: { success: 0, failed: 0 },
    },
    byDayService: {},
    // P2：可靠性（重试/限流/服务端错误/工具失败）
    reliability: {
      retries: 0,
      retryStarted: 0,
      byCode: {},
      toolResults: 0,
      toolErrors: 0,
      rateLimit: 0,
    },
    byDayReliability: {},
    // P3：缺失 usage 时的字符启发式估算（默认关闭，不计入成本）
    estimation: { messages: 0, tokens: 0 },
    byDayEstimation: {},
  };

  const estimationOptions = options.estimation ?? {};
  const estimationEnabled = estimationOptions.fallback === "chars";
  const toolCallNames = new Map();

  const touch = (ms) => {
    if (typeof ms !== "number" || !Number.isFinite(ms)) return;
    if (summary.firstAt === null || ms < summary.firstAt) summary.firstAt = ms;
    if (summary.lastAt === null || ms > summary.lastAt) summary.lastAt = ms;
  };

  for (const event of events) {
    const time = event.time;
    touch(time);
    const data = event.data ?? {};

    switch (event.type) {
      case "session/title": {
        if (typeof data.title === "string" && data.title.trim().length > 0) {
          summary.title = data.title.trim();
          summary.titleSource = data.source?.kind ?? "unknown";
        }
        break;
      }
      case "request/context": {
        if (safeNumber(data.contextWindow) !== undefined) summary.context.contextWindow = data.contextWindow;
        if (typeof data.provider === "string") summary.context.provider = data.provider;
        if (typeof data.model === "string") summary.context.model = data.model;
        break;
      }
      case "assistant/message": {
        summary.counts.assistantMessages += 1;
        const usage = data.usage;
        if (!usage || typeof usage !== "object") {
          // P3：仅在显式开启估算时统计字符数（不保留文本），结果单独计数、不进成本
          if (estimationEnabled) {
            const estimate = estimateTokensFromContent(data.message?.content, {
              cnRatio: estimationOptions.cnCharTokenRatio,
              enRatio: estimationOptions.enCharTokenRatio,
            });
            if (estimate.tokens > 0) {
              summary.estimation.messages += 1;
              summary.estimation.tokens += estimate.tokens;
              const estimateDate = cycleDateKey(typeof time === "number" ? time : Date.now(), options.dayStartHour ?? 4);
              if (!summary.byDayEstimation[estimateDate]) summary.byDayEstimation[estimateDate] = { messages: 0, tokens: 0 };
              summary.byDayEstimation[estimateDate].messages += 1;
              summary.byDayEstimation[estimateDate].tokens += estimate.tokens;
            }
          }
          break;
        }
        summary.counts.usageMessages += 1;

        const bill = bucketsOf(usage);
        const model = normalizeModel(data.message?.source?.model ?? summary.context.model ?? "unknown");

        const dateKey = cycleDateKey(typeof time === "number" ? time : Date.now(), options.dayStartHour ?? 4);
        if (!summary.byDay[dateKey]) summary.byDay[dateKey] = emptyMetrics();
        addMetrics(summary.byDay[dateKey], bill);

        if (!summary.byModel[model]) summary.byModel[model] = emptyMetrics();
        addMetrics(summary.byModel[model], bill);

        if (!summary.byDayModel[dateKey]) summary.byDayModel[dateKey] = {};
        if (!summary.byDayModel[dateKey][model]) summary.byDayModel[dateKey][model] = emptyMetrics();
        addMetrics(summary.byDayModel[dateKey][model], bill);

        const cost = estimateCost(usage, model, {
          overrides: pricing,
          policy: options.pricingPolicy ?? {},
          tsMs: typeof time === "number" ? time : null,
        });
        if (cost.costCny === null) {
          summary.cost.unknownTokens += bill.totalTokens;
          summary.byDay[dateKey].costUnknownTokens += bill.totalTokens;
          summary.byModel[model].costUnknownTokens += bill.totalTokens;
          summary.byDayModel[dateKey][model].costUnknownTokens += bill.totalTokens;
        } else {
          summary.cost.knownTokens += bill.totalTokens;
          summary.byDay[dateKey].costCny += cost.costCny;
          summary.byDay[dateKey].costKnownTokens += bill.totalTokens;
          summary.byModel[model].costCny += cost.costCny;
          summary.byModel[model].costKnownTokens += bill.totalTokens;
          summary.byDayModel[dateKey][model].costCny += cost.costCny;
          summary.byDayModel[dateKey][model].costKnownTokens += bill.totalTokens;
        }

        // 上下文压力口径与 DSH 官方 dsh-token-meter 一致：
        // inputTokens（非缓存）+ cacheReadTokens + cacheWriteTokens。
        const pressure = bill.inputTokens + bill.cacheReadTokens + bill.cacheWriteTokens;
        if (typeof time === "number" && time >= (summary.context.updatedAt ?? 0)) {
          summary.context.pressure = pressure;
          summary.context.updatedAt = time;
          if (data.message?.source?.model) summary.context.model = data.message.source.model;
          if (data.message?.source?.provider) summary.context.provider = data.message.source.provider;
        }
        if (typeof time === "number" && pressure > 0) {
          summary.pressureSamples.push({ ts: time, pressure });
          if (summary.pressureSamples.length > 200) summary.pressureSamples.shift();
        }
        break;
      }
      case "tool/call": {
        summary.counts.toolCalls += 1;
        const name = typeof data.name === "string" ? data.name : "unknown";
        summary.tools[name] = (summary.tools[name] ?? 0) + 1;
        if (typeof data.callId === "string") toolCallNames.set(data.callId, name);
        const toolDate = cycleDateKey(typeof time === "number" ? time : Date.now(), options.dayStartHour ?? 4);
        if (!summary.byDayTools[toolDate]) summary.byDayTools[toolDate] = {};
        summary.byDayTools[toolDate][name] = (summary.byDayTools[toolDate][name] ?? 0) + 1;
        break;
      }
      case "tool/result": {
        summary.reliability.toolResults += 1;
        const isError = Boolean(data.error);
        if (isError) summary.reliability.toolErrors += 1;
        const resultDate = cycleDateKey(typeof time === "number" ? time : Date.now(), options.dayStartHour ?? 4);
        if (!summary.byDayReliability[resultDate]) {
          summary.byDayReliability[resultDate] = { retries: 0, rateLimit: 0, toolResults: 0, toolErrors: 0 };
        }
        summary.byDayReliability[resultDate].toolResults += 1;
        if (isError) summary.byDayReliability[resultDate].toolErrors += 1;
        // callId 位于 message.source.callId（兼容 content 内的 toolCallId）
        const callId =
          data.message?.source?.callId ??
          data.message?.source?.toolCallId ??
          data.message?.content?.find?.((block) => block?.type === "tool-result")?.toolCallId ??
          null;
        const toolName = callId ? toolCallNames.get(callId) : null;
        if (toolName === "web_search" || toolName === "web_fetch") {
          const bucket = toolName === "web_search" ? "webSearch" : "webFetch";
          summary.service[bucket][isError ? "failed" : "success"] += 1;
          const serviceDate = cycleDateKey(typeof time === "number" ? time : Date.now(), options.dayStartHour ?? 4);
          if (!summary.byDayService[serviceDate]) {
            summary.byDayService[serviceDate] = {
              webSearch: { success: 0, failed: 0 },
              webFetch: { success: 0, failed: 0 },
            };
          }
          summary.byDayService[serviceDate][bucket][isError ? "failed" : "success"] += 1;
        }
        break;
      }
      case "llm/retry": {
        summary.reliability.retries += 1;
        const code = typeof data.failure?.code === "string" ? data.failure.code : "UNKNOWN";
        summary.reliability.byCode[code] = (summary.reliability.byCode[code] ?? 0) + 1;
        if (code === "RATE_LIMIT") summary.reliability.rateLimit += 1;
        const retryDate = cycleDateKey(typeof time === "number" ? time : Date.now(), options.dayStartHour ?? 4);
        if (!summary.byDayReliability[retryDate]) {
          summary.byDayReliability[retryDate] = { retries: 0, rateLimit: 0, toolResults: 0, toolErrors: 0, byCode: {} };
        }
        summary.byDayReliability[retryDate].retries += 1;
        if (code === "RATE_LIMIT") summary.byDayReliability[retryDate].rateLimit += 1;
        if (!summary.byDayReliability[retryDate].byCode) summary.byDayReliability[retryDate].byCode = {};
        summary.byDayReliability[retryDate].byCode[code] = (summary.byDayReliability[retryDate].byCode[code] ?? 0) + 1;
        break;
      }
      case "llm/retry-started": {
        summary.reliability.retryStarted += 1;
        break;
      }
      case "user/message": {
        summary.counts.userMessages += 1;
        break;
      }
      case "compaction/prune": {
        const tokens = safeNumber(data.shadowedTokenCount) ?? 0;
        summary.compactions.push({ ts: typeof time === "number" ? time : null, tokens });
        break;
      }
      default:
        break;
    }
  }

  // 数值收敛：成本保留 6 位，避免浮点噪声。
  for (const metrics of Object.values(summary.byDay)) metrics.costCny = Math.round(metrics.costCny * 1e6) / 1e6;
  for (const metrics of Object.values(summary.byModel)) metrics.costCny = Math.round(metrics.costCny * 1e6) / 1e6;
  for (const models of Object.values(summary.byDayModel)) {
    for (const metrics of Object.values(models)) metrics.costCny = Math.round(metrics.costCny * 1e6) / 1e6;
  }
  summary.compactions.sort((a, b) => (a.ts ?? 0) - (b.ts ?? 0));
  return summary;
}

/** 供缓存/测试使用的空摘要（避免 undefined 分支）。 */
export function emptySummary() {
  return summarizeSession({ header: null, events: [] }, {});
}

/** 把若干摘要按日期合并（用于报告/历史）。 */
export function mergeByDay(summaries) {
  const out = {};
  for (const summary of summaries) {
    for (const [date, metrics] of Object.entries(summary.byDay ?? {})) {
      if (!out[date]) out[date] = emptyMetrics();
      addMetrics(out[date], metrics);
      out[date].costCny += metrics.costCny ?? 0;
      out[date].costKnownTokens += metrics.costKnownTokens ?? 0;
      out[date].costUnknownTokens += metrics.costUnknownTokens ?? 0;
      out[date].messages -= 1; // addMetrics 已 +1，这里抵消重复计数
    }
  }
  for (const metrics of Object.values(out)) metrics.costCny = Math.round(metrics.costCny * 1e6) / 1e6;
  return out;
}
