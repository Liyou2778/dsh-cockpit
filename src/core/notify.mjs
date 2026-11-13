/**
 * 通知评估（本地、确定性）：把状态映射成可读告警。
 * 已读状态存 `~/.dsh-cockpit/notifications.json`（不联网）。
 * 参考产品对应能力：ResetWatchBell + desktop notification。
 */
import { round } from "./math.mjs";

/**
 * @param {{status: object, config: object}} input
 * @returns {Array<{id:string, level:'info'|'warn'|'critical', title:string, body:string, metric:number|null}>}
 */
export function evaluateAlerts({ status, config }) {
  const notify = config?.notify ?? {};
  if (notify.enabled === false) return [];
  const alerts = [];
  const usedPercent = status?.quota?.usedPercent ?? 0;
  const forecastScore = status?.forecast?.score ?? 0;
  const overBy = status?.pace?.overByPercent ?? 0;
  const contextPercent = status?.context?.percent ?? 0;

  if (Number.isFinite(usedPercent) && usedPercent >= (notify.budgetCritical ?? 95)) {
    alerts.push({
      id: "budget-critical",
      level: "critical",
      title: "预算接近耗尽",
      body: `本周期已用 ${round(usedPercent, 1)}%，超过临界阈值 ${notify.budgetCritical ?? 95}%。`,
      metric: round(usedPercent, 1),
    });
  } else if (Number.isFinite(usedPercent) && usedPercent >= (notify.budgetWarn ?? 80)) {
    alerts.push({
      id: "budget-warn",
      level: "warn",
      title: "预算已过警戒线",
      body: `本周期已用 ${round(usedPercent, 1)}%，建议收紧今日用量。`,
      metric: round(usedPercent, 1),
    });
  }

  if (Number.isFinite(usedPercent) && usedPercent >= (notify.dailyCap ?? 90)) {
    alerts.push({
      id: "daily-cap",
      level: "warn",
      title: "接近个人上限",
      body: `已用 ${round(usedPercent, 1)}%，个人上限设置为 ${notify.dailyCap ?? 90}%。`,
      metric: round(usedPercent, 1),
    });
  }

  if (Number.isFinite(forecastScore) && forecastScore >= (notify.compactionScore ?? 70)) {
    alerts.push({
      id: "compaction",
      level: "warn",
      title: "压缩风险偏高",
      body: `预测 ${round(forecastScore, 1)}%${Number.isFinite(status?.forecast?.etaHours) ? `，预计 ${round(status.forecast.etaHours, 1)}h 后触发` : ""}。`,
      metric: round(forecastScore, 1),
    });
  }

  if (status?.pace?.status === "over_pace" && overBy >= 10) {
    alerts.push({
      id: "pace-over",
      level: "info",
      title: "配速超速",
      body: `实际用量比建议高 ${round(overBy, 1)}%。`,
      metric: round(overBy, 1),
    });
  }

  if (contextPercent >= 80) {
    alerts.push({
      id: "context-high",
      level: "warn",
      title: "上下文接近上限",
      body: `当前会话压力 ${round(contextPercent, 1)}%，建议收尾后开新会话。`,
      metric: round(contextPercent, 1),
    });
  }

  return alerts;
}

/** 结合已读集合 → 未读数与已读标记。 */
export function withReadState(alerts, readIds) {
  const read = new Set(Array.isArray(readIds) ? readIds : []);
  const items = alerts.map((alert) => ({ ...alert, read: read.has(alert.id) }));
  return { alerts: items, unread: items.filter((item) => !item.read).length };
}
