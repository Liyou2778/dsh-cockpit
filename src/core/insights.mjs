/**
 * 洞察引擎（规则化，确定性输出）——复刻参考产品 UsageInsightsPanel 的"给结论而不是给图"。
 * 每条洞察：{ id, severity, title, body, metric, action }
 */
import { round } from "./math.mjs";

function pct(value) {
  return `${round(value, 1)}%`;
}

/**
 * @param {{
 *   aggregate: ReturnType<import('./aggregate.mjs').aggregateAll>,
 *   status: object,
 *   history: Array<{date:string,tokens:number,costCny:number}>,
 *   comfortEntries: Array<{date:string,level:number}>,
 *   config: object,
 *   nowMs: number,
 *   rangeLabel: string,
 * }} input
 */
export function buildInsights(input) {
  const { aggregate, status, history, comfortEntries, config, nowMs, rangeLabel } = input;
  const items = [];
  const totals = aggregate.totals;

  // 1) 任务集中度
  const taskList = [...aggregate.tasks.values()].sort((a, b) => b.metrics.totalTokens - a.metrics.totalTokens);
  if (totals.totalTokens > 0 && taskList.length > 0) {
    const top = taskList[0];
    const share = (top.metrics.totalTokens / totals.totalTokens) * 100;
    if (share >= 40) {
      items.push({
        id: "dominant-task",
        severity: "info",
        title: "任务集中度偏高",
        body: `${rangeLabel}有 ${pct(share)} 的 token 来自「${top.title}」；考虑拆分长会话可降低单任务成本。`,
        metric: round(share, 1),
        action: "open-tasks",
      });
    }
  }

  // 2) 模型集中度
  const modelList = [...aggregate.models.entries()].sort((a, b) => b[1].totalTokens - a[1].totalTokens);
  if (totals.totalTokens > 0 && modelList.length === 1) {
    items.push({
      id: "model-concentration",
      severity: "info",
      title: "单一模型",
      body: `${rangeLabel}全部用量来自 ${modelList[0][0]}；如遇长任务可对比 deepseek-pro 的单位成本。`,
      metric: 100,
      action: "open-models",
    });
  }

  // 3) 预算进度
  const usedPercent = status?.quota?.usedPercent ?? 0;
  const notify = config?.notify ?? {};
  if (usedPercent >= (notify.budgetCritical ?? 95)) {
    items.push({
      id: "budget-critical",
      severity: "warn",
      title: "预算接近耗尽",
      body: `当前预算周期已用 ${pct(usedPercent)}，超过临界阈值 ${notify.budgetCritical}%。`,
      metric: usedPercent,
      action: "open-settings",
    });
  } else if (usedPercent >= (notify.budgetWarn ?? 80)) {
    items.push({
      id: "budget-warn",
      severity: "warn",
      title: "预算偏高",
      body: `当前预算周期已用 ${pct(usedPercent)}，建议收紧今日用量或调整预算。`,
      metric: usedPercent,
      action: "open-settings",
    });
  }

  // 4) 配速
  const overBy = status?.pace?.overByPercent ?? 0;
  if ((status?.pace?.status ?? "") === "over_pace" && overBy >= 10) {
    items.push({
      id: "pace-over",
      severity: "warn",
      title: "配速超速",
      body: `实际用量比线性建议高 ${pct(overBy)}，按当前节奏可能在周期结束前触及上限。`,
      metric: overBy,
      action: "open-pace",
    });
  }

  // 5) 上下文风险
  const contextPercent = status?.context?.percent ?? 0;
  if (contextPercent >= 80) {
    items.push({
      id: "context-high",
      severity: "warn",
      title: "上下文接近压缩",
      body: `当前会话上下文压力 ${pct(contextPercent)}；建议先收尾再开新会话，避免压缩丢失细节。`,
      metric: contextPercent,
      action: "open-forecast",
    });
  }

  // 6) 压缩频率
  const compactions = status?.context?.compactions24h ?? 0;
  if (compactions >= 2) {
    items.push({
      id: "compaction-frequent",
      severity: "warn",
      title: "压缩频繁",
      body: `24 小时内已发生 ${compactions} 次压缩；可考虑缩短单会话任务范围。`,
      metric: compactions,
      action: "open-forecast",
    });
  }

  // 7) 成本尖峰（今日 vs 近 7 日均值）
  const todayKey = new Date(nowMs + 8 * 3_600_000).toISOString().slice(0, 10);
  const last7 = history.filter((day) => day.date !== todayKey).slice(-7);
  const todayRow = history.find((day) => day.date === todayKey);
  if (last7.length >= 3 && todayRow) {
    const avgCost = last7.reduce((sum, day) => sum + (day.costCny ?? 0), 0) / last7.length;
    if (avgCost > 0 && todayRow.costCny > avgCost * 1.5) {
      items.push({
        id: "cost-spike",
        severity: "warn",
        title: "今日成本高于近期均值",
        body: `今日 ¥${round(todayRow.costCny, 2)}，是近 7 日均值 ¥${round(avgCost, 2)} 的 ${round(todayRow.costCny / avgCost, 1)} 倍。`,
        metric: round(todayRow.costCny / avgCost, 2),
        action: "open-trend",
      });
    }
  }

  // 8) 舒适度偏低
  const recentComfort = comfortEntries.slice(-3);
  if (recentComfort.length >= 2) {
    const avgLevel = recentComfort.reduce((sum, entry) => sum + entry.level, 0) / recentComfort.length;
    if (avgLevel <= 2.3) {
      items.push({
        id: "comfort-low",
        severity: "info",
        title: "最近体感偏紧",
        body: `最近 ${recentComfort.length} 次记录平均 ${round(avgLevel, 1)}/5；可下调今日建议或安排休息。`,
        metric: round(avgLevel, 1),
        action: "open-comfort",
      });
    }
  }

  // 9) 闲置提醒
  const lastAt = Math.max(0, ...aggregate.sessions.map((row) => row.lastAt ?? 0));
  if (totals.totalTokens > 0 && lastAt > 0 && nowMs - lastAt > 6 * 3_600_000) {
    items.push({
      id: "idle",
      severity: "info",
      title: "已有一段时间未使用",
      body: `最近一次记录在 ${round((nowMs - lastAt) / 3_600_000, 1)} 小时前。`,
      metric: round((nowMs - lastAt) / 3_600_000, 1),
      action: "open-sessions",
    });
  }

  // 10) 可靠性：限流/重试/工具失败
  const reliability = input.reliability ?? {};
  if (Number.isFinite(reliability.rateLimit) && reliability.rateLimit >= 3) {
    items.push({
      id: "rate-limit",
      severity: "warn",
      title: "限流重试偏多",
      body: `${rangeLabel}发生 ${reliability.rateLimit} 次 RATE_LIMIT 重试（429）；可能是并发或余额触发的降级限制。`,
      metric: reliability.rateLimit,
      action: "open-reliability",
    });
  }
  if (Number.isFinite(reliability.toolErrorRate) && reliability.toolErrorRate >= 0.05 && (reliability.toolResults ?? 0) >= 20) {
    items.push({
      id: "tool-error-rate",
      severity: "info",
      title: "工具失败率偏高",
      body: `${rangeLabel}工具调用 ${reliability.toolResults} 次，失败 ${reliability.toolErrors} 次（${pct(reliability.toolErrorRate * 100)}）。`,
      metric: round(reliability.toolErrorRate * 100, 1),
      action: "open-reliability",
    });
  }
  if (Number.isFinite(reliability.retriesPerMessage) && reliability.retriesPerMessage >= 0.02) {
    items.push({
      id: "retry-rate",
      severity: "info",
      title: "重试比例偏高",
      body: `${rangeLabel}平均每 ${round(1 / Math.max(1e-6, reliability.retriesPerMessage), 0)} 条消息就发生 1 次重试。`,
      metric: round(reliability.retriesPerMessage * 100, 2),
      action: "open-reliability",
    });
  }

  // 11) Search/Fetch 服务费占比
  const service = input.serviceFees;
  const modelCost = totals.costCny ?? 0;
  const totalCost = modelCost + (service?.costCny ?? 0);
  if (service && service.costCny > 0 && totalCost > 0) {
    const share = (service.costCny / totalCost) * 100;
    if (share >= 5) {
      items.push({
        id: "service-fee-share",
        severity: "info",
        title: "Search/Fetch 费用占比偏高",
        body: `${rangeLabel}服务费 ¥${round(service.costCny, 2)}（成功 ${service.requests} 次），占总成本 ${pct(share)}；一次搜索可能触发多次 provider 请求，实际可能更高。`,
        metric: round(share, 1),
        action: "open-receipt",
      });
    }
  }

  const severityRank = { warn: 0, info: 1 };
  return items.sort((a, b) => (severityRank[a.severity] ?? 1) - (severityRank[b.severity] ?? 1));
}
